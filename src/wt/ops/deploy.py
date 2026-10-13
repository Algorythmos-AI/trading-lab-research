"""Deploy reviewed code into the live checkout, only when no trading job can be affected (ADR 0002).

    python -m wt.ops.deploy gate                          # print whether a deploy is allowed now, and why not
    python -m wt.ops.deploy deploy [--sha SHA] [--stage]  # one transaction: see below
    python -m wt.ops.deploy rollback <tag>                # back to a runtime-* tag (same gate, same checks)
    python -m wt.ops.deploy migrate                       # move runtime files out of tracked paths (same gate)
    python -m wt.ops.deploy ready                         # notify-only: say when a deploy would be accepted (ADR 0007)

The gate refuses when any com.wt.* job is running or holds its lock, inside the trading night
(07:00 ET to close + 2 h on a session day), within an hour of a scheduled start, or when the market calendar
can't be read.

A deploy is one transaction on one exact commit (plan v7 B7):
  1. the target (--sha, default the tip of main) must be on main, a fast-forward of the live checkout, and green:
     every required GitHub check concluded "success" on that commit (wt.ops.ci);
  2. the live dashboard must not be older than the dashboard/contract code it brings (wt.ops.dashguard);
  3. --stage: the full test suite runs in a throwaway worktree of the target with its own locked venv, BEFORE the
     live checkout changes; a red suite changes nothing;
  4. under the deploy lock (jobs wait for it; wt.ops.jobs), with the gate checked again: tag, fast-forward to
     exactly the target (never a second fetch), migrate state, sync the venv, smoke test. A failed smoke test
     rolls back to the tag inside the same lock, without asking the gate again: restoring the code that was
     running is always allowed.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from wt.core.config import ROOT, STATE_DIR
from wt.ops import agents, ci, dashguard, host, migrate, preflight, safeio, units
from wt.ops.alerts import Alerts
from wt.ops.heartbeat import ok_runs_since
from wt.ops.locks import DEPLOY_LOCK, RUNNER_LOCK, held, job_lock
from wt.ops.schedule import JOBS, PY, TRADING_JOBS
from wt.ops.window import deploy_blockers, load_sessions

DEPLOY_DIR = STATE_DIR / "deploy"
STAGE_DIR = STATE_DIR / "stage"
STAGE_TIMEOUT_S = 1800.0
CI_OVERRIDE_ENV = "WT_DEPLOY_CI_OVERRIDE"       # owner only: deploy a commit whose checks can't be read (reason)
TAGGER = ("-c", "user.name=wt-deploy", "-c", "user.email=wt-deploy@localhost")   # a host may have no git identity


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _run(*cmd: str, check: bool = True, timeout: float = 600) -> subprocess.CompletedProcess[str]:
    r = subprocess.run(list(cmd), cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} failed: {(r.stderr or r.stdout).strip()[-400:]}")
    return r


def running_jobs() -> dict[str, bool]:
    """Which trading jobs launchd/systemd shows running (wt.ops.host); fails closed when it can't tell."""
    return host.current().running_jobs([j for j in JOBS.values() if j.trading])


def gate_blockers(now: dt.datetime | None = None) -> list[str]:
    now = now or _now()
    sessions, exact = load_sessions(now)
    # The runner's own lock too: a runner orphaned by a dead wrapper holds only that one.
    return deploy_blockers(now, sessions, running_jobs(), held([*TRADING_JOBS, RUNNER_LOCK]), exact)


QUIESCE_WAIT_S = 120.0


@contextlib.contextmanager
def quiesced(wait_s: float | None = None, own: str | None = None) -> Iterator[list[str]]:
    """Hold the lock of every job the gate does not wait for (the interval jobs and the daily challenger run),
    waiting for a run in flight to finish. Those are not trading jobs, so the gate lets a deploy start while one
    runs; without this the checkout (and the venv) would change under it. Yields the jobs still busy after
    `wait_s` (empty = quiet). `own` is the job this deploy is itself running as (the automatic deploy): its lock
    is already held by its own runner, so it is not waited for."""
    wait_s = QUIESCE_WAIT_S if wait_s is None else wait_s
    with contextlib.ExitStack() as stack:
        busy = [j.name for j in JOBS.values()
                if not j.trading and j.name != own
                and not stack.enter_context(job_lock(j.name, wait_s=wait_s, poll_s=2.0))]
        yield busy


def sync_venv() -> None:
    uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
    _run(uv, "pip", "sync", "--python", str(ROOT / PY), "requirements.lock.txt")
    (ROOT / preflight.LOCK_STAMP).write_text(preflight.lock_hash(ROOT) + "\n")


ML_LOCK, ML_VENV = "requirements-ml.lock.txt", ".venv-ml"
ML_NEXT, ML_PREV = ".venv-ml.next", ".venv-ml.prev"
# Held while a deploy tests its target before the switch. Staging runs for minutes, outside the deploy lock (which
# every job waits on), and starts by clearing its worktree: without this a second deploy of the same commit removed
# the first one's worktree under its running tests, and that first deploy was refused as "tests failed".
STAGE_LOCK = "deploy-stage"
ML_ENV_LOCK = "ml-env"                  # one build at a time; not the deploy lock, which every job waits on
ML_USERS = ("crypto-learn",)            # jobs that run for long in the ML environment: the swap waits for them
SWAP_WAIT_S = 120.0
ML_IMPORT_CHECK = "import sklearn, lightgbm"       # what the learning job and the scorer import


def sync_ml(swap_wait_s: float | None = None) -> str:
    """Bring the machine-learning environment (DEC-0016) in line with its own hashed lockfile: "none" when the
    checkout has no such lockfile, "current" when nothing changed, "synced", "pending" (built, not yet swapped
    in), "busy" (another build is running) or "failed".

    It is a separate environment so that the trading one stays exactly its lockfile. A failure here never fails
    the deploy: the trading jobs do not import it, and the scorer falls back to unfiltered trading when it is
    missing (wt.crypto.scorer).

    Nothing here holds a lock a trading job waits on. Every job waits for the deploy lock before it starts, so
    this runs after that lock is released, under a lock of its own: a large install delays no job. The new
    environment is built beside the live one and put in its place by two renames, so the scorer sees the old
    one or the new one and never one that is half installed. The renames wait for the learning job, which
    trains in the environment for up to an hour; if it is still running the built environment is kept and the
    next call (the next deploy, or `make sync-ml`) only has to swap it in."""
    lock = ROOT / ML_LOCK
    if not lock.exists():
        return "none"
    want = hashlib.sha256(lock.read_bytes()).hexdigest()
    live, nxt, prev = ROOT / ML_VENV, ROOT / ML_NEXT, ROOT / ML_PREV
    stamp = live / ".lock-sha256"
    if stamp.exists() and stamp.read_text().strip() == want:
        return "current"
    with job_lock(ML_ENV_LOCK) as mine:
        if not mine:
            return "busy"
        try:
            built = nxt / ".lock-sha256"
            if not (built.exists() and built.read_text().strip() == want):
                uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
                shutil.rmtree(nxt, ignore_errors=True)
                _run(uv, "venv", "--quiet", "--python", str(ROOT / PY), str(nxt))
                _run(uv, "pip", "sync", "--quiet", "--python", str(nxt / "bin" / "python"), "--require-hashes",
                     str(lock), timeout=1800)
                # Installed is not usable: a wheel can need a system library the host lacks (LightGBM needs
                # OpenMP, `libgomp1` on Debian). An environment that cannot import is never swapped in.
                _run(str(nxt / "bin" / "python"), "-c", ML_IMPORT_CHECK, timeout=120)
                built.write_text(want + "\n")
            wait = SWAP_WAIT_S if swap_wait_s is None else swap_wait_s
            with contextlib.ExitStack() as stack:
                if not all(stack.enter_context(job_lock(n, wait_s=wait, poll_s=2.0)) for n in ML_USERS):
                    Alerts().fire("deploy-ml", "ML environment built, not yet in use",
                                  "The learning job is running in the old one. Trading is unaffected. The next deploy "
                                  "swaps the new one in, or run: make sync-ml", 3)
                    return "pending"
                shutil.rmtree(prev, ignore_errors=True)
                if live.exists():
                    os.rename(live, prev)
                os.rename(nxt, live)
            shutil.rmtree(prev, ignore_errors=True)
            Alerts().resolve("deploy-ml", "ML environment in sync", "The machine-learning environment matches its lockfile.")
            return "synced"
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
            if not live.exists() and prev.exists():             # the second rename failed: put the old one back
                with contextlib.suppress(OSError):
                    os.rename(prev, live)
            shutil.rmtree(nxt, ignore_errors=True)
            Alerts().fire("deploy-ml", "ML environment did not sync",
                          f"{str(e)[:200]}. Trading is unaffected; models are not scored until the next deploy fixes it.", 3)
            return "failed"


def _note_ml(rec: Path | None) -> None:
    """Sync the ML environment and write the outcome into the deploy's record."""
    state = sync_ml()
    if rec is not None and rec.exists():
        rec.write_text(json.dumps({**json.loads(rec.read_text()), "ml_env": state}, indent=1, default=str))
    if state in ("synced", "failed", "pending", "busy"):
        print(f"ML environment: {state}" + ("  (finish with: make sync-ml)" if state in ("pending", "busy") else ""))


def smoke() -> tuple[bool, str]:
    r = _run(str(ROOT / PY), "-m", "pytest", "-m", "smoke", "-q", check=False, timeout=900)
    return r.returncode == 0, (r.stdout + r.stderr).strip()[-600:]


def next_tag() -> str:
    day = _now().strftime("%Y%m%d")                 # UTC: the same name whichever host deploys
    existing = _run("git", "tag", "--list", f"runtime-{day}-*").stdout.split()
    return f"runtime-{day}-{len(existing) + 1}"


def record(body: dict[str, object]) -> Path:
    DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
    p = DEPLOY_DIR / f"{_now():%Y%m%dT%H%M%SZ}.json"
    p.write_text(json.dumps(body, indent=1, default=str))
    return p


def _refuse_if_closed() -> bool:
    if blockers := gate_blockers():
        print("Deploy gate CLOSED:\n  " + "\n  ".join(blockers))
        return True
    return False


def do_migrate() -> int:
    if _refuse_if_closed():
        return 2
    res = migrate.migrate()
    print(f"migrated {len(res.moved)}, already in place {len(res.already)}, conflicts {len(res.conflicts)}")
    for c in res.conflicts:
        print(f"  CONFLICT (left alone): {c}")
    return 1 if res.conflicts else 0


def is_ancestor(a: str, b: str) -> bool:
    return _run("git", "merge-base", "--is-ancestor", a, b, check=False).returncode == 0


def stage_tests(target: str, timeout_s: float = STAGE_TIMEOUT_S) -> tuple[bool, str]:
    """The full test suite on `target`, in a throwaway worktree with its own venv synced from the target's hashed
    lockfile (uv's cache makes that cheap). The live checkout and its venv are never touched. The suite runs with
    a minimal environment: no broker keys, no secrets file, the worktree's own state dir."""
    d = STAGE_DIR / target[:12]
    _run("git", "worktree", "remove", "--force", str(d), check=False)
    shutil.rmtree(d, ignore_errors=True)
    _run("git", "worktree", "prune", check=False)
    STAGE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _run("git", "worktree", "add", "--detach", "--force", str(d), target)
        uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
        _run(uv, "venv", "--quiet", "--python", str(ROOT / PY), str(d / ".venv"))
        _run(uv, "pip", "sync", "--quiet", "--python", str(d / PY), "--require-hashes", str(d / "requirements.lock.txt"))
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")}
        env.update(PYTHONPATH="src", PYTHONDONTWRITEBYTECODE="1")
        r = subprocess.run([str(d / PY), "-m", "pytest", "-q", "-p", "no:cacheprovider", "-o", "addopts="], cwd=d,
                           env=env, capture_output=True, text=True, timeout=timeout_s)
        tail = (r.stdout + r.stderr).strip()[-600:]
        return r.returncode == 0, tail
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        return False, f"staging failed: {e}"[:600]
    finally:
        _run("git", "worktree", "remove", "--force", str(d), check=False)
        shutil.rmtree(d, ignore_errors=True)
        _run("git", "worktree", "prune", check=False)


LAST_RECORD: Path | None = None          # the record of this process's last successful switch


def resolve_target(sha: str | None) -> tuple[str | None, str]:
    """(target commit, why not) after fetching main: on main, a fast-forward of HEAD, not HEAD itself."""
    _run("git", "fetch", "--quiet", "origin", "main")
    main_head = _run("git", "rev-parse", "origin/main").stdout.strip()
    if sha is None:
        target = main_head
    else:
        r = _run("git", "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}", check=False)
        if r.returncode != 0:
            return None, f"{sha} is not a commit here"
        target = r.stdout.strip()
    if not is_ancestor(target, main_head):
        return None, f"{target[:12]} is not on main"
    head = _run("git", "rev-parse", "HEAD").stdout.strip()
    if head == target:
        return None, f"already at {target[:12]}"
    if not is_ancestor(head, target):
        return None, f"{target[:12]} does not follow the live checkout {head[:12]} (use rollback to go back)"
    return target, ""


def deploy(sha: str | None = None, stage: bool = False, by: str = "owner", own_job: str | None = None,
           stage_timeout_s: float = STAGE_TIMEOUT_S, go_on: Callable[[], str | None] | None = None,
           ml: bool = True) -> int:
    """One deploy. `by`, `own_job`, `go_on` and `ml` are the automatic deploy's (ADR 0008): who is recorded, whose
    job lock is already held, a last question asked after the tests and before the switch (a reason not to go on,
    or None), and whether the ML environment is brought along here or by the caller afterwards."""
    if _refuse_if_closed():
        return 2
    git = [c for c in preflight.check_git(ROOT) if c.name in ("on main", "clean code") and not c.ok]
    if git:
        print("Refusing: " + "; ".join(f"{c.name}: {c.detail}" for c in git))
        return 2
    target, why = resolve_target(sha)
    if target is None:
        print(f"Nothing deployed: {why}")
        return 0 if why.startswith("already at") else 2
    # An automatic deploy asks for the checks the code names, whatever the host's environment says.
    green = ci.check(target) if by == "owner" else ci.check(target, required=ci.DEFAULT_REQUIRED)
    # The overrides are the owner's, typed for one deploy: an automatic deploy never reads them.
    ci_override = os.environ.get(CI_OVERRIDE_ENV, "").strip() if by == "owner" else ""
    if not green.green and not ci_override:
        print(f"Refusing: {target[:12]} is not green ({green.detail})\n  (owner override: {CI_OVERRIDE_ENV}='reason')")
        return 2
    ok_dash, why_dash, override = dashguard.guard(ROOT, target)
    if by != "owner" and why_dash:
        ok_dash = False                         # passed only by an override left in the environment: not here
    if not ok_dash:
        print(f"Refusing: {why_dash}\n  (owner override: {dashguard.OVERRIDE_ENV}='reason' make deploy)")
        return 2
    if why_dash:
        print(f"Dashboard check overridden by the owner ({override}): {why_dash}")
    if stage:
        print(f"staging {target[:12]}: the full test suite in a throwaway worktree ...", flush=True)
        with job_lock(STAGE_LOCK) as mine:
            if not mine:
                # Not a failed suite: nothing was tested, so no alert and no record. The other deploy decides.
                print("Refusing: another deploy is testing a commit before its switch; wait for it to finish, "
                      "then run this again (it will say so if there is nothing left to deploy)")
                return 2
            passed, out = stage_tests(target, stage_timeout_s)
        if not passed:
            record({"target": target, "staged": False, "stage_output": out})
            Alerts().fire("deploy", "Deploy refused: tests failed", f"The test suite failed on {target[:8]} before "
                          "the switch; the live checkout is unchanged.", 4)
            print(f"Refusing: the test suite failed on {target[:12]}; nothing changed\n{out}")
            return 1
    if go_on is not None and (stop := go_on()) is not None:
        print(f"Refusing: {stop}; nothing changed")
        return 2
    with job_lock(DEPLOY_LOCK) as got:
        if not got:
            print("Refusing: another deploy is running")
            return 2
        if _refuse_if_closed():                    # staging took a while: a job may be due now
            return 2
        with quiesced(own=own_job) as busy:
            if busy:
                print(f"Refusing: still running after {QUIESCE_WAIT_S:.0f}s: {', '.join(busy)}")
                return 2
            code, rec = _switch(target, stage, green, ci_override, why_dash, override, by)
    # Every lock is released: jobs start again. The ML environment has its own lock (see `sync_ml`).
    global LAST_RECORD
    LAST_RECORD = rec if code == 0 else None
    if code == 0 and ml:
        _note_ml(rec)
    return code


def _switch(target: str, staged: bool, green: ci.Verdict, ci_override: str, why_dash: str | None,
            override: str | None, by: str = "owner") -> tuple[int, Path | None]:
    before = _run("git", "rev-parse", "HEAD").stdout.strip()
    tag = next_tag()
    _run("git", *TAGGER, "tag", "-a", tag, "-m", f"runtime state before deploy at {_now():%Y-%m-%dT%H:%M:%SZ}", before)
    _run("git", "merge", "--ff-only", "--quiet", target)             # exactly the checked commit: no second fetch
    after = _run("git", "rev-parse", "HEAD").stdout.strip()
    # From here the checkout is ahead of its environment. A fault in any step (the lock cannot be synced, the
    # smoke test hangs) is a failed switch and takes the same way back; nobody may be watching a terminal.
    moved: list[str] = []
    conflicts: list[str] = []
    try:
        res = migrate.migrate()
        moved, conflicts = res.moved, res.conflicts
        sync_venv()
        ok, out = smoke()
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        ok, out = False, f"the switch failed before the smoke test: {e.__class__.__name__}: {e}"[:600]
    body: dict[str, object] = {"from": before, "to": after, "rollback_tag": tag, "lock": preflight.lock_hash(ROOT),
                               "migrated": moved, "conflicts": conflicts, "smoke_ok": ok, "staged": staged,
                               "by": by,
                               "ci": green.checks if green.green else {"override": ci_override, "why": green.detail},
                               "dashboard_check": "overridden" if why_dash else "ok",
                               **({"dashboard_override": {"reason": override, "why": why_dash}} if why_dash else {})}
    if not ok:
        print(f"Smoke test FAILED on {after[:8]}; rolling back to {tag} (inside the deploy lock)\n{out}")
        try:
            _run("git", "reset", "--hard", "--quiet", tag)
            sync_venv()
        except (RuntimeError, OSError, subprocess.SubprocessError) as e:
            body["rolled_back"] = False
            record(body)
            Alerts().fire("deploy-broken", "Host left between two releases",
                          f"The switch to {after[:8]} failed and so did the way back to {tag} "
                          f"({e.__class__.__name__}). Jobs may refuse to start. Log in and run: "
                          f"sudo -u wt /usr/local/bin/wt-deploy 'rollback {tag}'", 5)
            return 1, None
        body["rolled_back"] = True
        record(body)
        Alerts().fire("deploy", "Deploy rolled back", f"Smoke test failed on {after[:8]}; live checkout restored "
                      f"to {tag}.", 4)
        return 1, None
    rec = record(body)
    Alerts().resolve("deploy", "Deploy healthy", f"Live checkout at {after[:8]}.")
    shown = rec.relative_to(ROOT) if rec.is_relative_to(ROOT) else rec          # WT_STATE may live elsewhere
    print(f"Deployed {before[:8]} -> {after[:8]} (rollback tag {tag}); record {shown}")
    if conflicts:
        print("Runtime-state conflicts left alone: " + ", ".join(conflicts))
    if host.current().kind == "launchd" and (d := agents.diff()):
        print("launchd agents need reinstalling (owner, outside the trading window):\n  " + "\n  ".join(d) +
              "\n  -> make install-trading-agents")
    return 0, rec


def broker_cleanup_before_rollback(broker_factory: Any = None) -> str | None:
    """Older code doesn't know the GTC stops this version places. If strategy B is flat, cancel this repo's
    resting orders so none can outlive a rollback and open a short. If B holds a position, refuse (None = ok).
    Positions outside B's mandate (a manual test buy) don't block a rollback: no version of this code touches them."""
    import os

    from wt.brokers.cancel_only import connect
    from wt.core.ids import is_ours
    from wt.risk.pretrade import load_limits
    allow = load_limits("B").allowlist
    prev = os.environ.get("MODE")
    os.environ["MODE"] = "paper"                    # the paper adapter asserts it; restored below so it can't leak
    try:
        b = connect(broker_factory)                 # positions, open orders, cancel: nothing that adds exposure
        if any(p.qty for p in b.positions() if p.symbol in allow):
            return "strategy B holds a position: flatten it (or let the session finish) before rolling back"
        for o in b.open_orders():
            if is_ours(o.client_order_id):
                b.cancel(o.client_order_id)
                print(f"cancelled resting {o.client_order_id} {o.symbol}")
        return None
    finally:
        if prev is None:
            os.environ.pop("MODE", None)
        else:
            os.environ["MODE"] = prev


# ---- a deploy is ready: tell the owner, change nothing (ADR 0007) -----------------------------------------------
NOTIFY_KEY = "deploy-ready"
NOTIFY_OFF = "NOTIFY_OFF"               # a file of this name in var/deploy/ silences the notice
NOTIFY_MIN_AGE_MIN = 30                 # merges come in bursts: wait for the tip of main to settle


def _commit_time(sha: str) -> dt.datetime:
    return dt.datetime.fromtimestamp(int(_run("git", "show", "-s", "--format=%ct", sha).stdout.strip()), dt.UTC)


def _settle_ready(alerts: Any, now: dt.datetime) -> None:
    """Clear this notice once there is nothing left to deploy (today's key and yesterday's)."""
    for d in (now, now - dt.timedelta(days=1)):
        alerts.resolve(f"{NOTIFY_KEY}:{d.astimezone().date().isoformat()}", "Host is up to date",
                       "Nothing on main is waiting to be deployed.", 1)


def ready(now: dt.datetime | None = None) -> int:
    """Say, at most once a day, that a deploy would be accepted right now: main is ahead of the live checkout, its
    tip is green and has settled, the dashboard is not behind it, and the gate is open. It reads; it never
    deploys, stages, tags or touches the checkout beyond a `git fetch`, and only while the gate is open. Always exits 0: a notice that cannot be
    worked out is a line in the job's log, not a failed job."""
    now = now or _now()
    if (DEPLOY_DIR / NOTIFY_OFF).exists():
        print(f"deploy notice: off ({DEPLOY_DIR / NOTIFY_OFF} exists)")
        return 0
    try:
        # The gate first: while it is closed (a session, a job running) the checkout is not even fetched.
        if blockers := gate_blockers(now):
            print(f"deploy notice: the gate is closed ({blockers[0]})")
            return 0
        target, why = resolve_target(None)
        alerts = Alerts()
        if target is None:
            if why.startswith("already at"):
                _settle_ready(alerts, now)
            print(f"deploy notice: nothing to deploy ({why})")
            return 0
        age_min = (now - _commit_time(target)).total_seconds() / 60
        if age_min < NOTIFY_MIN_AGE_MIN:
            print(f"deploy notice: {target[:12]} is {age_min:.0f} min old; waiting for main to settle")
            return 0
        green = ci.check(target)
        if not green.green:
            print(f"deploy notice: {target[:12]} is not green ({green.detail})")
            return 0
        ok_dash, why_dash, _ = dashguard.guard(ROOT, target)
        if not ok_dash:
            print(f"deploy notice: {target[:12]} waits for the dashboard ({why_dash})")
            return 0
        head = _run("git", "rev-parse", "HEAD").stdout.strip()
        if auto_enabled() and ok_runs_since(AUTO_JOB, now - dt.timedelta(hours=AUTO_ALIVE_H)) > 0:
            # The host deploys this by itself at its next run (ADR 0008); a release it leaves to the owner is said
            # there, in words that say why. Two notices for one release would be one too many.
            print(f"deploy notice: {target[:12]} is ready; the automatic deploy takes it from here")
            return 0
        n = _run("git", "rev-list", "--count", f"{head}..{target}").stdout.strip()
        sent = alerts.once_per_day(
            NOTIFY_KEY, "A deploy is ready",
            f"main is green and {n} commit{'' if n == '1' else 's'} ahead of the host ({head[:8]} -> {target[:8]}); "
            "the gate is open. To deploy: sudo -u wt /usr/local/bin/wt-deploy deploy", 3)
        print(f"deploy notice: {target[:12]} is ready, {n} ahead ({'sent' if sent else 'already said today'})")
    except Exception as e:  # noqa: BLE001 — a notice must never fail its job or page about itself
        print(f"deploy notice: could not be worked out ({e.__class__.__name__}: {str(e)[:200]})")
    return 0


# ---- the host deploys itself (ADR 0008) --------------------------------------------------------------------------
AUTO_JOB = "deploy-auto"
AUTO_ON = "AUTO_ON"                     # the owner's file in var/deploy/: without it a run only says what it would do
AUTO_STATE = STATE_DIR / "deploy-auto.json"   # not in var/deploy/: every file there is read as a deploy's record
AUTO_MARGIN_MIN = 60                    # the gate must still be open this long from now
AUTO_STAGE_S = 1200.0                   # the tests' limit here; the owner's own deploy allows them longer
AUTO_SWITCH_BY_S = 25 * 60.0            # no switch is started later than this into a run: the job's deadline is 50 min
AUTO_TRIES = 2                          # a target that failed here is tried once more, after AUTO_RETRY_H, then left
AUTO_RETRY_H = 6
AUTO_ALIVE_H = 3                        # the notice of ADR 0007 steps aside only for a job seen running this recently
AUTO_STUCK_H = 12                       # a release waiting longer than this is said, once a day
AUTO_BUSY = ("crypto-challengers", "crypto-learn")     # long, heavy jobs: the tests are not run beside them
# What `sudo wt-install-units` installs is made from the first four. The rest is the deploy's own machinery: a
# release that changes how the host deploys is not let in by the thing it changes.
OWNER_PATHS = ("deploy/oci/bin", "deploy/oci/systemd", "src/wt/ops/schedule.py", "src/wt/ops/units.py",
               "src/wt/ops/deploy.py", "src/wt/ops/jobs.py", "src/wt/ops/ci.py", "src/wt/ops/window.py",
               "src/wt/ops/locks.py", "src/wt/ops/dashguard.py")


def auto_enabled() -> bool:
    """True on a host whose timers run the automatic deploy and where the owner has switched it on."""
    return AUTO_JOB in JOBS and host.current().kind == "systemd" and (DEPLOY_DIR / AUTO_ON).exists()


def needs_owner(head: str, target: str) -> str | None:
    """Why this release cannot go in unattended, or None. Installing units needs `sudo`, which no job has: a
    release that changes what is installed, or a host whose installed units already differ from its code, is the
    owner's; so is one that changes the deploy itself. Judged by path, so a comment in the schedule counts too:
    the owner deploys a few releases by hand rather than one going in with half its timers."""
    changed = _run("git", "diff", "--name-only", head, target, "--", *OWNER_PATHS).stdout.split()
    if changed:
        return (f"it changes the units, the host helpers or the deploy itself ({len(changed)} "
                f"file{'' if len(changed) == 1 else 's'}): deploy it, then run sudo wt-install-units")
    if host.current().kind == "systemd" and units.diff(units.render_all(ROOT)):
        return "the installed units differ from the code: run sudo wt-install-units, then deploy"
    return None


def _auto_state() -> dict[str, Any]:
    try:
        got = json.loads(AUTO_STATE.read_text())
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _auto_remember(target: str, now: dt.datetime, tries: int | None = None) -> None:
    was = _auto_state()
    n = tries if tries is not None else (int(was.get("tries") or 0) + 1 if was.get("failed") == target else 1)
    safeio.atomic_write(AUTO_STATE, json.dumps({"failed": target, "tries": n, "at": now.isoformat(timespec="seconds")}),
                        AUTO_STATE.parent)


def _auto_waits(target: str, now: dt.datetime) -> str | None:
    """Why a target that failed here before is not tried now, or None."""
    was = _auto_state()
    if was.get("failed") != target:
        return None
    try:
        since_h = (now - dt.datetime.fromisoformat(str(was.get("at")))).total_seconds() / 3600
        tries = int(was.get("tries") or 1)
    except (TypeError, ValueError):
        return None
    if tries >= AUTO_TRIES:
        return f"it failed here {tries} times (or was rolled back); a newer commit is needed"
    return None if since_h >= AUTO_RETRY_H else f"it failed here {since_h:.0f} h ago; one more try after {AUTO_RETRY_H} h"


def _stuck(alerts: Any, head: str, target: str, why: str, now: dt.datetime) -> None:
    """Say, once a day, that a release has waited too long: by its oldest commit, since the tip keeps moving."""
    try:
        first = int(_run("git", "log", "--reverse", "--format=%ct", f"{head}..{target}").stdout.split()[0])
    except (RuntimeError, IndexError, ValueError):
        return
    waited_h = (now - dt.datetime.fromtimestamp(first, dt.UTC)).total_seconds() / 3600
    if waited_h > AUTO_STUCK_H:
        alerts.once_per_day("deploy-stuck", "A release has waited for hours",
                            f"{head[:8]} -> {target[:8]} has waited {waited_h:.0f} h and is not deployed: {why}", 3)


def auto(now: dt.datetime | None = None) -> int:
    """Deploy the tip of main if a deploy typed by the owner would be accepted right now, and say so on the
    owner's phone. It asks what `ready` asks, then runs the same transaction as `wt-deploy deploy` (the full test
    suite on this host before the switch, the smoke test and the rollback after it), and is stricter in the ways
    ADR 0008 lists. Without the owner's `AUTO_ON` file it changes nothing and says what it would have done.
    Always exits 0: a refusal is a line in the job's log, a release that waits is said once a day, and a deploy
    that fails pages by itself."""
    now = now or _now()
    started = time.monotonic()
    if AUTO_JOB not in JOBS or host.current().kind != "systemd":
        print("auto deploy: this host does not run it")
        return 0
    live = (DEPLOY_DIR / AUTO_ON).exists()
    head = ""
    alerts: Any = None
    try:
        if blockers := gate_blockers(now):
            print(f"auto deploy: the gate is closed ({blockers[0]})")
            return 0
        # The tests run for minutes and the switch asks the gate again: do not start what cannot finish.
        if later := gate_blockers(now + dt.timedelta(minutes=AUTO_MARGIN_MIN)):
            print(f"auto deploy: the gate closes within {AUTO_MARGIN_MIN} min ({later[0]})")
            return 0
        git = [c for c in preflight.check_git(ROOT) if c.name in ("on main", "clean code") and not c.ok]
        if git:
            print("auto deploy: " + "; ".join(f"{c.name}: {c.detail}" for c in git))
            return 0
        head = _run("git", "rev-parse", "HEAD").stdout.strip()
        target, why = resolve_target(None)
        alerts = Alerts()
        if target is None:
            if why.startswith("already at"):
                _settle_ready(alerts, now)
            print(f"auto deploy: nothing to deploy ({why})")
            return 0

        def wait(reason: str) -> int:
            print(f"auto deploy: {target[:12]} waits: {reason}")
            _stuck(alerts, head, target, reason, now)
            return 0
        age_min = (now - _commit_time(target)).total_seconds() / 60
        if age_min < NOTIFY_MIN_AGE_MIN:
            print(f"auto deploy: {target[:12]} is {age_min:.0f} min old; waiting for main to settle")
            return 0
        if stop := _auto_waits(target, now):
            return wait(stop)
        green = ci.check(target, required=ci.DEFAULT_REQUIRED)
        if not green.green:
            return wait(f"not green ({green.detail})")
        ok_dash, why_dash, _ = dashguard.guard(ROOT, target)
        if not ok_dash or why_dash:
            return wait(f"the dashboard is behind it ({why_dash})")
        if owner := needs_owner(head, target):          # only now: the owner is told of a release they could deploy
            sent = alerts.once_per_day(
                NOTIFY_KEY, "A deploy needs you",
                f"{head[:8]} -> {target[:8]} was not deployed automatically: {owner}. "
                "The deploy: sudo -u wt /usr/local/bin/wt-deploy deploy", 3)
            print(f"auto deploy: {target[:12]} is the owner's: {owner} ({'said' if sent else 'already said today'})")
            return 0
        if busy := held(list(AUTO_BUSY)):
            print(f"auto deploy: {', '.join(sorted(busy))} is running; not testing beside it")
            return 0
        n = _run("git", "rev-list", "--count", f"{head}..{target}").stdout.strip()
        commits = f"{n} commit{'' if n == '1' else 's'}"
        if not live:
            print(f"auto deploy: would deploy {head[:12]} -> {target[:12]}, {commits} (dry: {DEPLOY_DIR / AUTO_ON} "
                  "does not exist)")
            return 0
        print(f"auto deploy: {head[:12]} -> {target[:12]}, {commits}", flush=True)

        def go_on() -> str | None:
            if not (DEPLOY_DIR / AUTO_ON).exists():
                return "automatic deploys were switched off while the tests ran"
            if time.monotonic() - started > AUTO_SWITCH_BY_S:
                return "the tests took too long to start a switch inside this run"
            return None
        code = deploy(target, stage=True, by="auto", own_job=AUTO_JOB, stage_timeout_s=AUTO_STAGE_S, go_on=go_on, ml=False)
        after = _run("git", "rev-parse", "HEAD").stdout.strip()
        if code == 0 and after == target:
            alerts.notify("Deployed automatically", f"The host moved {head[:8]} -> {target[:8]} ({commits}): tests "
                          "passed here before the switch and the smoke test after it. To go back: sudo -u wt "
                          "/usr/local/bin/wt-deploy 'rollback <tag>' (the tag is in the newest record in var/deploy). "
                          f"To stop automatic deploys: remove var/deploy/{AUTO_ON}", 3)
            _settle_ready(alerts, now)
            alerts.resolve("deploy-stuck", "Release deployed", f"The host is at {target[:8]}.", 1)
            _note_ml(LAST_RECORD)                   # last, and after the page: it can run for a long time
        elif code == 1:
            _auto_remember(target, now)             # its tests or its smoke test failed here: already paged
            _stuck(alerts, head, target, "its tests or its smoke test failed on the host", now)
        else:
            _stuck(alerts, head, target, "the deploy refused it (see the job's log)", now)
    except Exception as e:  # noqa: BLE001 — the job itself never fails; what matters is said on the phone
        print(f"auto deploy: stopped ({e.__class__.__name__}: {str(e)[:200]})")
        try:
            moved = bool(head) and _run("git", "rev-parse", "HEAD").stdout.strip() != head
        except Exception:  # noqa: BLE001
            moved = True
        try:
            alerts = alerts or Alerts()
            if moved:
                alerts.fire("deploy-broken", "Automatic deploy stopped half way",
                            f"The live checkout moved from {head[:8]} and the deploy did not finish "
                            f"({e.__class__.__name__}). Log in and check: sudo -u wt /usr/local/bin/wt-deploy status", 5)
            else:
                alerts.once_per_day("deploy-auto-fault", "Automatic deploy could not run",
                                    f"Nothing was changed ({e.__class__.__name__}). See logs/deploy_auto_*.log", 3)
        except Exception:  # noqa: BLE001
            pass
    return 0


def rollback(tag: str) -> int:
    if not tag.startswith("runtime-"):
        print("Rollback targets are runtime-* tags only")
        return 2
    if _refuse_if_closed():
        return 2
    if (why := broker_cleanup_before_rollback()) is not None:
        print(f"Refusing to roll back: {why}")
        return 2
    with job_lock(DEPLOY_LOCK) as got:
        if not got:
            print("Refusing: a deploy is running")
            return 2
        # Not waiting for the automatic deploy's job: the deploy lock above already keeps its switch out, and it
        # may sit in a long ML build after one.
        with quiesced(own=AUTO_JOB) as busy:
            if busy:
                print(f"Refusing: still running after {QUIESCE_WAIT_S:.0f}s: {', '.join(busy)}")
                return 2
            before = _run("git", "rev-parse", "HEAD").stdout.strip()
            _run("git", "reset", "--hard", "--quiet", tag)
            sync_venv()
            ok, out = smoke()
    # The ML environment follows the checkout back, so the scorer never runs against a lock from the future.
    # The automatic deploy must not put back what the owner just took out: only a newer commit is taken.
    with contextlib.suppress(OSError):
        _auto_remember(before, _now(), tries=AUTO_TRIES)
    _note_ml(record({"rollback_from": before, "to_tag": tag, "smoke_ok": ok}))
    print(f"Rolled back {before[:8]} -> {tag}; smoke {'ok' if ok else 'FAILED'}")
    if not ok:
        print(out)
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.deploy")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("gate")
    dp = sub.add_parser("deploy")
    dp.add_argument("--sha", help="the commit to deploy (default: the tip of main)")
    dp.add_argument("--stage", action="store_true", help="run the full test suite on the target before switching")
    sub.add_parser("migrate")
    sub.add_parser("sync-ml")
    sub.add_parser("ready")
    sub.add_parser("auto")
    r = sub.add_parser("rollback")
    r.add_argument("tag")
    a = ap.parse_args(argv)
    if a.cmd == "gate":
        b = gate_blockers()
        print("Deploy gate OPEN" if not b else "Deploy gate CLOSED:\n  " + "\n  ".join(b))
        return 0 if not b else 2
    if a.cmd == "migrate":
        return do_migrate()
    if a.cmd == "ready":
        return ready()
    if a.cmd == "auto":
        return auto()
    if a.cmd == "sync-ml":
        state = sync_ml()
        print(f"ML environment: {state}")
        if state not in ("none", "current", "synced"):
            return 1
        if state == "none":
            return 0
        # In sync with its lockfile is not the same as working: say so if it cannot import what it is for.
        got = _run(str(ROOT / ML_VENV / "bin" / "python"), "-c", ML_IMPORT_CHECK, check=False, timeout=120)
        if got.returncode != 0:
            print("ML environment: installed, but it cannot import its libraries:\n  "
                  + (got.stderr or got.stdout).strip().splitlines()[-1][:200]
                  + "\n  (LightGBM needs the system's OpenMP library: sudo apt-get install -y libgomp1)")
            return 1
        return 0
    if a.cmd == "rollback":
        return rollback(a.tag)
    return deploy(a.sha, a.stage)


if __name__ == "__main__":
    sys.exit(main())
