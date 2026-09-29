"""Run a nightly job the way launchd should: locked, pre-flighted, time-boxed, observed.

    python -m wt.ops.jobs run <routine|paper-b|forward|weekly> [--preflight-only]
    python -m wt.ops.jobs status

For every run:
  1. Take the job's own lock. If another run holds it, this is a refusal.
  2. Run the preflight checks (`wt.ops.preflight`). A failure is a refusal: one alert per job per day, exit 0.
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
import time
from pathlib import Path
from typing import Any

from wt.core.clock import ET, et
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT
from wt.ops import preflight
from wt.ops.alerts import Alerts
from wt.ops.heartbeat import Heartbeat, last_runs
from wt.ops.locks import job_lock
from wt.ops.schedule import JOBS, PY, SYDNEY, Job
from wt.ops.window import Session, forward_wait_until, load_sessions

JOURNAL = DATA_DIR / "live" / "journal.jsonl"
KILL = ROOT / "KILL"
WEEKLY_WAIT_S = 3 * 3600
KILL_GRACE_S = 30


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


def run_child(job: Job, root: Path, log: Log, deadline: dt.datetime | None) -> tuple[int, bool]:
    """Run the job's command. Returns (exit code, killed_at_deadline)."""
    env = {**os.environ, "PYTHONPATH": "src", "MODE": job.mode, "PYTHONUNBUFFERED": "1",
           "PYTHONDONTWRITEBYTECODE": "1"}
    log(f"start {job.name}: {' '.join(job.command)} (MODE={job.mode}, deadline "
        f"{deadline.astimezone(ET):%H:%M} ET)" if deadline else f"start {job.name}: {' '.join(job.command)}")
    try:
        out = open(log.path, "a")
    except OSError:
        out = open(os.devnull, "w")
    with out:
        proc = subprocess.Popen([str(root / PY), *job.command], cwd=root, env=env, stdout=out, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True)
        timeout = None if deadline is None else max(1.0, (deadline - _now()).total_seconds())
        try:
            return proc.wait(timeout=timeout), False
        except subprocess.TimeoutExpired:
            log(f"deadline reached: stopping {job.name} (pid {proc.pid})")
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=KILL_GRACE_S)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
            return 124, True


def journal_since(start: dt.datetime, path: Path = JOURNAL) -> list[dict[str, Any]]:
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
               for a in (r.get("actions") or []) if "UNKNOWN" in str(a)]
    end = next((r for r in reversed(rows) if r.get("event") == "session_end"), None)
    virtual = (end or {}).get("virtual") or {}
    return {"not_flat": "END_OF_DAY_NOT_FLAT" in events, "unknown_positions": len(unknown),
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


def launchd_loaded(label: str) -> bool:
    """True if launchd knows the agent. Used for the fallback chain while agents are being (re)installed."""
    try:
        return subprocess.run(["launchctl", "list", label], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return True                     # unknown: assume installed rather than run a job twice


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


def refuse(job: Job, reason: str, alerts: Alerts, log: Log, hb: Heartbeat | None = None) -> int:
    log(f"REFUSED {job.name}: {reason}")
    alerts.once_per_day(f"refuse:{job.name}", f"{job.name} refused to run", reason, 3)
    if hb:
        hb.finish("refused", 0, reason)
    return 0


def run_job(job: Job, root: Path = ROOT, preflight_only: bool = False, alerts: Alerts | None = None) -> int:
    alerts = alerts or Alerts()
    log = Log(root, job)
    if preflight_only:
        checks = preflight.run_checks(root)
        for c in checks:
            print(f"  [{'ok' if c.ok else 'FAIL'}] {c.name}: {c.detail}")
        return 0 if not preflight.failures(checks) else 1

    with job_lock(job.name) as got:
        if not got:
            return refuse(job, "another run of this job is still in progress", alerts, log)
        hb = Heartbeat(job.name, _sha(root))
        fails = preflight.failures(preflight.run_checks(root))
        if fails:
            return refuse(job, "; ".join(f"{c.name}: {c.detail}" for c in fails), alerts, log, hb)

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
            code, killed = run_child(job, root, log, deadline_for(job, work_start, sessions))
        except OSError as e:            # the child could not start (missing interpreter, fork failure, ...)
            log(f"could not start {job.name}: {e.__class__.__name__}: {e}")
            code, killed = 127, False
        log(f"end {job.name}: exit {code}{' (deadline kill)' if killed else ''}")

        if job.name == "paper-b":
            alert_paper(paper_outcome(journal_since(start)), alerts)
        key = f"job:{job.name}"
        if code == 0:
            alerts.resolve(key, f"{job.name} recovered", f"{job.name} completed normally.")
            if job.name == "forward" and (line := forward_summary()):
                paused = " Paper B entries are paused (KILL file present)." if KILL.exists() else ""
                alerts.once_per_day("summary", "Trading Lab daily summary", line + paused, 2)
            hb.finish("ok", 0)
        else:
            what = "was stopped at its deadline" if killed else f"exited with code {code}"
            prio = 5 if (killed and job.name == "paper-b") else 4
            alerts.fire(key, f"{job.name} failed", f"{job.name} {what}. See {log.path.relative_to(root)}.", prio)
            hb.finish("timeout" if killed else "failed", code)
    run_followers(job, root, alerts, log)
    return code


def status(root: Path = ROOT) -> int:
    """What's going on, in the terminal: last runs, firing alerts, kill switch, preflight."""
    print(f"KILL switch: {'ON (no new paper-B entries)' if (root / 'KILL').exists() else 'off'}")
    print("Last runs:")
    for name, r in last_runs().items():
        print(f"  {name:8} {r.get('status', '?'):8} exit={r.get('exit')} started={r.get('started')} "
              f"ended={r.get('ended')} sha={r.get('sha')}  {r.get('detail', '')[:80]}")
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
