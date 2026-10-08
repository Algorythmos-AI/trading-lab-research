"""Run a nightly job the way launchd should: locked, pre-flighted, time-boxed, observed.

    python -m wt.ops.jobs run <routine|paper-b|forward|weekly> [--preflight-only]
    python -m wt.ops.jobs status

For every run:
  1. Take the job's own lock. If another run holds it, this is a refusal.
  2. Run the preflight checks (`wt.ops.preflight`). A failure is a refusal: one alert per job per day, exit 0.
     Exception (phase-2 L1): paper-b still starts, in exits-only mode, when strategy B holds a position and every
     failed check is one that can't make exit management unsafe (disk, .env mode, legacy state). Unreviewed code,
     a venv mismatch or a held lock never start a runner.
  3. Wait in-process where the job needs it (forward: until close + 20 min ET).
  4. Run the job as a child process under a deadline, with its output appended to logs/<log>_<YYYYMMDD>.log.
  5. Inspect the outcome: exit code, and for paper-b the journal (not flat, unknown position, latch, loop errors).
     Alerts fire on transitions and resolve when the problem clears.
  6. Write the heartbeat.

Exit code: the child's exit code, 0 for a refusal, 124 for a deadline kill.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from wt.core.clock import ET, et
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT
from wt.core.desk import DESKS, installed
from wt.ops import hc, host, preflight
from wt.ops.alerts import Alerts
from wt.ops.heartbeat import Heartbeat, last_runs, ok_runs_since
from wt.ops.locks import DEPLOY_LOCK, job_lock
from wt.ops.schedule import JOBS, PY, SYDNEY, Job
from wt.ops.window import Session, forward_wait_until, load_sessions

JOURNAL = DATA_DIR / "live" / "journal.jsonl"
KILL = ROOT / "KILL"
WEEKLY_WAIT_S = 3 * 3600
DEPLOY_WAIT_S = 30 * 60           # a job due while a deploy switches the checkout waits for it, then starts
KILL_GRACE_S = 30
# preflight failures that still let paper-b manage an open position (entries stay off)
EXITS_ONLY_CHECKS = frozenset({"free disk", ".env private", "runtime state migrated", "paging configured"})


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _sha(root: Path) -> str | None:
    try:
        return subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                              timeout=10).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


class Log:
    """Appends wrapper lines to the job's dated log. Never raises (a full disk must not kill the job)."""

    def __init__(self, root: Path, job: Job) -> None:
        self.path = root / "logs" / f"{job.log}_{dt.datetime.now(SYDNEY):%Y%m%d}.log"

    def __call__(self, msg: str) -> None:
        line = f"[jobs {dt.datetime.now(ET):%Y-%m-%d %H:%M:%S %Z}] {msg}"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a") as fh:
                fh.write(line + "\n")
        except OSError:
            pass
        print(line, file=sys.stderr, flush=True)


def deadline_for(job: Job, start: dt.datetime, sessions: dict[dt.date, Session]) -> dt.datetime | None:
    """Wall-clock limit for the job's work. The trading jobs end on their own at the close; the limit only catches
    a hang, so it sits well past the close."""
    s = sessions.get(start.astimezone(ET).date())
    if job.name == "routine":
        return et(s.date, "12:30") if s else start + dt.timedelta(minutes=15)
    if job.name == "paper-b":
        return s.close + dt.timedelta(minutes=45) if s else start + dt.timedelta(minutes=15)
    return start + dt.timedelta(minutes=job.deadline_min) if job.deadline_min else None


def run_child(job: Job, root: Path, log: Log, deadline: dt.datetime | None,
              extra_env: dict[str, str] | None = None) -> tuple[int, bool, bool]:
    """Run the job's command. Returns (exit code, killed_at_deadline, stopped_by_sigterm).

    A deadline stops the job's process group with SIGTERM, then SIGKILL after KILL_GRACE_S (exit 124).
    A SIGTERM to this runner (systemd stopping the unit, KillMode=mixed) is forwarded to the job's process group
    the same way (exit 143), so the runner survives long enough to write its heartbeat and page."""
    env = {**os.environ, "PYTHONPATH": "src", "MODE": job.mode, "PYTHONUNBUFFERED": "1",
           "PYTHONDONTWRITEBYTECODE": "1", **(extra_env or {})}
    log(f"start {job.name}: {' '.join(job.command)} (MODE={job.mode}, deadline "
        f"{deadline.astimezone(ET):%H:%M} ET)" if deadline else f"start {job.name}: {' '.join(job.command)}")
    try:
        out = open(log.path, "a")
    except OSError:
        out = open(os.devnull, "w")
    with out:
        proc = subprocess.Popen([str(root / PY), *job.command], cwd=root, env=env, stdout=out, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True)
        stop: dict[str, float | None] = {"sigterm": None, "deadline": None}

        def _killpg(sig: int) -> None:
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass

        def _on_sigterm(signum: int, frame: Any) -> None:
            if stop["sigterm"] is None:
                stop["sigterm"] = time.monotonic()
                _killpg(signal.SIGTERM)

        prev = None
        if threading.current_thread() is threading.main_thread():
            prev = signal.signal(signal.SIGTERM, _on_sigterm)
        try:
            limit = None if deadline is None else time.monotonic() + max(1.0, (deadline - _now()).total_seconds())
            while True:
                try:
                    code = proc.wait(timeout=1.0)
                    break
                except subprocess.TimeoutExpired:
                    pass
                now = time.monotonic()
                if limit is not None and now >= limit and stop["deadline"] is None:
                    log(f"deadline reached: stopping {job.name} (pid {proc.pid})")
                    stop["deadline"] = now
                    _killpg(signal.SIGTERM)
                first = min((t for t in (stop["sigterm"], stop["deadline"]) if t is not None), default=None)
                if first is not None and now - first > KILL_GRACE_S:
                    _killpg(signal.SIGKILL)
                    code = proc.wait()
                    break
        finally:
            if prev is not None:
                signal.signal(signal.SIGTERM, prev)
        if stop["sigterm"] is not None:
            log(f"stopped by SIGTERM: {job.name} (pid {proc.pid}) ended with {code}")
            return 143, False, True
        if stop["deadline"] is not None:
            return 124, True, False
        return code, False, False


def journal_since(start: dt.datetime, path: Path | None = None) -> list[dict[str, Any]]:
    path = path or JOURNAL                  # resolved at call time, so the module-level path can be redirected
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return rows
    for line in lines:
        try:
            r = json.loads(line)
            if dt.datetime.fromisoformat(str(r.get("ts"))) >= start:
                rows.append(r)
        except (ValueError, TypeError):
            continue
    return rows


def paper_outcome(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Trading-critical facts from one paper session's journal rows."""
    events = [str(r.get("event")) for r in rows]
    unknown = [a for r in rows if str(r.get("event", "")).startswith("reconcile")
               for a in (r.get("actions") or []) if any(k in str(a) for k in ("UNKNOWN", "SHORT", "UNPROTECTED"))]
    end = next((r for r in reversed(rows) if r.get("event") == "session_end"), None)
    virtual = (end or {}).get("virtual") or {}
    return {"armed": "armed" in events, "no_session": "no_session" in events or "too_early" in events,
            "not_flat": "END_OF_DAY_NOT_FLAT" in events, "unknown_positions": len(unknown),
            "loop_errors": events.count("loop_error"), "latched": bool(virtual.get("latched")),
            "latch_reason": str(virtual.get("latch_reason") or ""), "refused": "refuse_to_arm" in events,
            "trades": events.count("trade_closed"),
            "r": [r.get("R") for r in rows if r.get("event") == "trade_closed" and isinstance(r.get("R"), int | float)]}


def alert_paper(o: dict[str, Any], alerts: Alerts) -> None:
    pairs = [
        ("paper-b:not-flat", o["not_flat"], 5, "Paper B NOT FLAT at the close",
         "The runner ended the session with an open position. Check the broker and flatten if needed."),
        ("paper-b:unknown-position", o["unknown_positions"] > 0, 5, "Paper B: unknown position",
         f"Reconcile found {o['unknown_positions']} unprotected position(s) it does not manage."),
        ("paper-b:latched", o["latched"], 5, "Paper B loss limit latched",
         f"The virtual account latched ({o['latch_reason'] or 'loss limit'}). Entries stay off until reset."),
        ("paper-b:loop-errors", o["loop_errors"] >= 3, 4, "Paper B: repeated loop errors",
         f"{o['loop_errors']} loop errors in tonight's session. See logs/paper_b_*.log."),
    ]
    for key, bad, prio, title, msg in pairs:
        if bad:
            alerts.fire(key, title, msg, prio, ("rotating_light",) if prio == 5 else ())
        else:
            alerts.resolve(key, f"{title.split(':')[0]}: cleared", "Back to normal.")
    if o["refused"]:
        alerts.once_per_day("paper-b:refused-to-arm", "Paper B refused to arm", "See the paper_b log for the reason.", 3)


def forward_summary(ledger: Path = FORWARD_LEDGER) -> str | None:
    """One line on the latest completed forward session: trades and R by strategy (R only, plan R13)."""
    try:
        rows = [json.loads(x) for x in ledger.read_text().splitlines() if x.strip()]
    except (OSError, json.JSONDecodeError):
        return None
    done = sorted({str(r["session"]) for r in rows if r.get("session_marker")})
    if not done:
        return None
    last = done[-1]
    trades = [r for r in rows if str(r.get("session")) == last and isinstance(r.get("R"), int | float)
              and not r.get("session_marker") and not r.get("strategy_marker")]
    total = sum(float(r["R"]) for r in trades)
    by: dict[str, float] = {}
    for r in trades:
        by[str(r.get("strategy"))] = by.get(str(r.get("strategy")), 0.0) + float(r["R"])
    top = ", ".join(f"{k} {v:+.2f}R" for k, v in sorted(by.items(), key=lambda kv: -abs(kv[1]))[:4])
    return (f"Forward {last}: {len(trades)} trade(s), {total:+.2f}R total" + (f" ({top})" if top else "") +
            f". Sessions recorded: {len(done)}.")


OUTCOME_WORDS = {"traded": "traded", "no_signal": "no signal", "signal_not_acted": "a signal fired and was NOT acted on"}


def paper_summary(rows: list[dict[str, Any]]) -> str | None:
    """One line on Paper B's session from its journal rows: what it did, in R only (plan R13). None when it never
    armed."""
    if not any(r.get("event") == "armed" for r in rows):
        return None
    end = next((r for r in reversed(rows) if r.get("event") == "session_end"), None)
    outcome = str((end or {}).get("outcome") or "")
    rs = [float(r["R"]) for r in rows if r.get("event") == "trade_closed" and isinstance(r.get("R"), int | float)]
    if outcome.startswith("blocked"):
        words = f"a signal was blocked ({outcome.split(':', 1)[-1]})"
    else:
        words = OUTCOME_WORDS.get(outcome, "session not finished" if end is None else "no trade")
    return f"Paper B: {words}" + (f", {sum(rs):+.2f}R on {len(rs)} closed trade(s)" if rs else "") + "."


def crypto_summary(now: dt.datetime) -> str | None:
    """One line on the crypto tournament sleeves: positions open and what closed today (UTC), in R only. None when
    the desk is not on this host or has no sleeves. Never raises: a summary must not fail a job."""
    try:
        from wt.core.config import load_yaml
        from wt.crypto import snapshot
        desk = DESKS["crypto"]
        if not installed(desk):
            return None
        rows = snapshot._jsonl(desk.journal)
        view = snapshot.sleeves_view(desk, load_yaml("crypto.yaml"), rows, now)
        if not view:
            return None
        day, fixed = now.date().isoformat(), snapshot.exit_r(rows)
        parts = []
        for v in view:
            closed = [fixed[str(r.get("id"))] for r in rows if r.get("sleeve") == v["name"] and r.get("kind") == "exit"
                      and str(r.get("t", "")).startswith(day) and str(r.get("id")) in fixed]
            bit = f"{v['name']} {len(v['positions'])} open"
            if closed:
                bit += f", {len(closed)} closed today {sum(closed):+.2f}R"
            parts.append(bit)
        return "Crypto: " + "; ".join(parts) + "."
    except Exception:  # noqa: BLE001
        return None


def daily_summary(start: dt.datetime, now: dt.datetime | None = None) -> str | None:
    """The end-of-day message sent to the owner's phone after the forward test: Paper B, the forward test and the
    crypto sleeves, one line each. Statuses, counts and R: never money."""
    now = now or dt.datetime.now(dt.UTC)
    day_start = dt.datetime.combine(start.astimezone(ET).date(), dt.time(0), tzinfo=ET)
    lines = [paper_summary(journal_since(day_start)), forward_summary(), crypto_summary(now)]
    text = " ".join(x for x in lines if x)
    return text or None


def launchd_loaded(label: str) -> bool:
    """True if the service manager knows the job's agent/unit (launchd or systemd, wt.ops.host). Used for the
    follower fallback while agents are being (re)installed; unknown counts as installed."""
    job = next((j for j in JOBS.values() if j.label == label), None)
    return True if job is None else host.current().loaded(job)


def run_followers(job: Job, root: Path, alerts: Alerts, log: Log) -> None:
    """Until the owner installs the split agents, paper-b still runs the forward test (and forward the Saturday
    scorecard), as the old combined script did. Each follower takes its own lock, so nothing runs twice."""
    if job.name == "paper-b" and not launchd_loaded(JOBS["forward"].label):
        log("com.wt.forward is not installed: running the forward test inline (run `make install-trading-agents`)")
        run_job(JOBS["forward"], root, alerts=alerts)
    elif (job.name == "forward" and not launchd_loaded(JOBS["weekly"].label)
          and dt.datetime.now(SYDNEY).isoweekday() == 6):
        log("com.wt.weekly is not installed: running the weekly scorecard inline")
        run_job(JOBS["weekly"], root, alerts=alerts)


def publish_evidence(root: Path, log: Log, alerts: Alerts) -> None:
    """After the weekly scorecard: open the week's evidence PR (wt.ops.evidence). Never fails the job."""
    try:
        r = subprocess.run([str(root / PY), "-m", "wt.ops.evidence"], cwd=root, capture_output=True, text=True,
                           timeout=600, env={**os.environ, "PYTHONPATH": "src"})
        log(f"evidence: {(r.stdout or r.stderr).strip()[-300:]}")
        if r.returncode != 0:
            alerts.once_per_day("evidence", "Weekly evidence PR failed", "See the scorecard log.", 2)
    except (OSError, subprocess.SubprocessError) as e:
        log(f"evidence: could not run ({e.__class__.__name__})")


def exits_only_allowed(fails: list[preflight.Check]) -> bool:
    return bool(fails) and all(c.name in EXITS_ONLY_CHECKS for c in fails)


def b_exposure() -> bool:
    """Does the paper account hold any of strategy B's symbols? Read-only (AccountReader has no order methods).
    Unknown counts as yes: the exits-only runner re-reads the broker and does nothing if flat."""
    try:
        from wt.brokers.alpaca_read import AccountReader
        from wt.risk.pretrade import load_limits
        allow = load_limits("B").allowlist
        return any(sym in allow and qty for sym, qty in AccountReader().positions())
    except Exception:  # noqa: BLE001
        return True


# jobs with a healthchecks.io check. `crypto` pings every 15 minutes, at any hour: its check has no schedule gap.
# The two daily crypto jobs alert when they fail; only a check notices when one never starts (a timer disabled
# or never installed), which is how both were absent for their first day on the host.
HC_JOBS = frozenset({"routine", "paper-b", "forward", "weekly", "crypto", "crypto-challengers", "crypto-learn"})


def hc_slug(job: Job) -> str:
    return f"wt-{job.name}"


def refuse(job: Job, reason: str, alerts: Alerts, log: Log, hb: Heartbeat | None = None, ping: bool = True) -> int:
    """A refusal exits 0 (launchd/systemd must not retry it) but is not a success: it pings the check's /fail."""
    log(f"REFUSED {job.name}: {reason}")
    alerts.once_per_day(f"refuse:{job.name}", f"{job.name} refused to run", reason, 3)
    if hb:
        hb.finish("refused", 0, reason)
    if ping and job.name in HC_JOBS:
        hc.ping(hc_slug(job), "fail", f"refused: {reason}")
        if job.name == "paper-b":
            hc.ping("wt-paper-b-armed", "fail", "refused before arming")
    return 0


def run_job(job: Job, root: Path = ROOT, preflight_only: bool = False, alerts: Alerts | None = None) -> int:
    alerts = alerts or Alerts()
    log = Log(root, job)
    if preflight_only:
        checks = preflight.run_checks(root)
        for c in checks:
            print(f"  [{'ok' if c.ok else 'FAIL'}] {c.name}: {c.detail}")
        return 0 if not preflight.failures(checks) else 1

    # Wait out a deploy before taking the job lock: a deploy holds the interval jobs' locks while it changes the
    # checkout (wt.ops.deploy.quiesced), and a job that already held its own would make it wait for nothing.
    waited = time.monotonic()
    with job_lock(DEPLOY_LOCK, wait_s=DEPLOY_WAIT_S) as free:   # released at once: only waits out a deploy
        if not free:
            return refuse(job, "a deploy is still changing the checkout after 30 minutes", alerts, log)
    if (waited := time.monotonic() - waited) > 1:
        log(f"waited {waited:.0f}s for a deploy to finish")
    with job_lock(job.name) as got:
        if not got:
            # not a failure: the run that holds the lock is the one that pings
            return refuse(job, "another run of this job is still in progress", alerts, log, ping=False)
        hb = Heartbeat(job.name, _sha(root))
        fails = preflight.failures(preflight.run_checks(root)) if job.preflight else []
        extra_env: dict[str, str] = {}
        if fails:
            reason = "; ".join(f"{c.name}: {c.detail}" for c in fails)
            if not (job.name == "paper-b" and exits_only_allowed(fails) and b_exposure()):
                return refuse(job, reason, alerts, log, hb)
            log(f"preflight refused ({reason}), but strategy B holds a position: starting in exits-only mode")
            alerts.once_per_day(f"refuse:{job.name}", f"{job.name}: entries off, exits only", reason, 4)
            extra_env["WT_EXITS_ONLY"] = "1"

        start = _now()
        sessions, exact = load_sessions(start)
        if not exact:
            log("market calendar unavailable; using the weekday fallback")
        if job.name == "forward" and (until := forward_wait_until(start, sessions)) is not None:
            log(f"waiting until {until.astimezone(ET):%H:%M} ET (close + 20 min) before the forward test")
            while (left := (until - _now()).total_seconds()) > 0:
                time.sleep(min(60.0, left))
        if job.name == "weekly":
            with job_lock("forward", wait_s=WEEKLY_WAIT_S) as free:
                if not free:
                    return refuse(job, "the forward test is still running after 3 hours", alerts, log, hb)
            # released at once: the scorecard only needs the forward test to have finished

        work_start = _now()
        try:
            code, killed, terminated = run_child(job, root, log, deadline_for(job, work_start, sessions), extra_env)
        except OSError as e:            # the child could not start (missing interpreter, fork failure, ...)
            log(f"could not start {job.name}: {e.__class__.__name__}: {e}")
            code, killed, terminated = 127, False, False
        log(f"end {job.name}: exit {code}{' (deadline kill)' if killed else ''}{' (SIGTERM)' if terminated else ''}")

        if job.name == "paper-b":
            outcome = paper_outcome(journal_since(start))
            alert_paper(outcome, alerts)
            if not outcome["armed"]:
                # The runner pings "armed" itself when its loop reaches the open. A day with no session (or a run
                # that started too early and handed over to the scheduled start) is fine; anything else is not.
                if outcome["no_session"]:
                    hc.ping("wt-paper-b-armed", "", "no session today")
                else:
                    hc.ping("wt-paper-b-armed", "fail", f"never armed (exit {code})")
        if job.name in HC_JOBS:
            hc.ping(hc_slug(job), "" if code == 0 else "fail", f"exit {code}")
        key = f"job:{job.name}"
        if code == 0:
            alerts.resolve(key, f"{job.name} recovered", f"{job.name} completed normally.")
            if job.name == "forward" and (line := daily_summary(start)):
                paused = " Paper B entries are paused (KILL file present)." if KILL.exists() else ""
                alerts.once_per_day("summary", "Trading Lab daily summary", line + paused, 2)
            if job.name == "weekly":
                publish_evidence(root, log, alerts)
            hb.finish("ok", 0)
        else:
            what = ("was stopped at its deadline" if killed else
                    "was stopped by the system (SIGTERM)" if terminated else f"exited with code {code}")
            prio = 5 if ((killed or terminated) and job.name == "paper-b") else 4
            alerts.fire(key, f"{job.name} failed", f"{job.name} {what}. See {log.path.relative_to(root)}.", prio)
            hb.finish("timeout" if killed else "terminated" if terminated else "failed", code)
    run_followers(job, root, alerts, log)
    return code


def cadence(now: dt.datetime | None = None, heartbeats: Path | None = None) -> list[str]:
    """Each interval job against its own interval over the last hour. One missed run is allowed (a deploy, a slow
    collector); fewer means the scheduler isn't starting it, which no job-level alert can see."""
    now = now or dt.datetime.now(dt.UTC)
    out = []
    for j in JOBS.values():
        if j.interval_s and installed(DESKS[j.desk]):       # a desk this host doesn't run has nothing to be late
            want = 3600 // j.interval_s
            got = ok_runs_since(j.name, now - dt.timedelta(hours=1), heartbeats)
            out.append(f"  [{'ok' if got >= want - 1 else 'FAIL'}] {j.name} cadence: {got} of {want} runs ok in the last hour")
    return out


def status(root: Path = ROOT) -> int:
    """What's going on, in the terminal: last runs, firing alerts, kill switch, preflight."""
    print(f"KILL switch: {'ON (no new paper-B entries)' if (root / 'KILL').exists() else 'off'}")
    print("Last runs:")
    for name, r in last_runs().items():
        print(f"  {name:8} {r.get('status', '?'):8} exit={r.get('exit')} started={r.get('started')} "
              f"ended={r.get('ended')} sha={r.get('sha')}  {r.get('detail', '')[:80]}")
    for line in cadence():
        print(line)
    firing = Alerts().firing()
    print(f"Alerts firing: {', '.join(sorted(firing)) or 'none'}")
    print("Preflight:")
    for c in preflight.run_checks(root):
        print(f"  [{'ok' if c.ok else 'FAIL'}] {c.name}: {c.detail}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.jobs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("job", choices=sorted(JOBS))
    r.add_argument("--preflight-only", action="store_true")
    sub.add_parser("status")
    a = ap.parse_args(argv)
    if a.cmd == "status":
        return status()
    return run_job(JOBS[a.job], preflight_only=a.preflight_only)


if __name__ == "__main__":
    sys.exit(main())
