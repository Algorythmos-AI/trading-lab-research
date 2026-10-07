"""Deploy reviewed code into the live checkout, only when no trading job can be affected (ADR 0002).

    python -m wt.ops.deploy gate                          # print whether a deploy is allowed now, and why not
    python -m wt.ops.deploy deploy [--sha SHA] [--stage]  # one transaction: see below
    python -m wt.ops.deploy rollback <tag>                # back to a runtime-* tag (same gate, same checks)
    python -m wt.ops.deploy migrate                       # move runtime files out of tracked paths (same gate)

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
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from wt.core.config import ROOT, STATE_DIR
from wt.ops import agents, ci, dashguard, host, migrate, preflight
from wt.ops.alerts import Alerts
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
def quiesced(wait_s: float | None = None) -> Iterator[list[str]]:
    """Hold every interval job's lock for the block, waiting for a run in flight to finish. Those jobs are not
    trading jobs, so the gate lets a deploy start while one runs; without this the checkout (and the venv) would
    change under it. Yields the jobs still busy after `wait_s` (empty = quiet)."""
    wait_s = QUIESCE_WAIT_S if wait_s is None else wait_s
    with contextlib.ExitStack() as stack:
        busy = [j.name for j in JOBS.values()
                if j.interval_s and not stack.enter_context(job_lock(j.name, wait_s=wait_s, poll_s=2.0))]
        yield busy


def sync_venv() -> None:
    uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
    _run(uv, "pip", "sync", "--python", str(ROOT / PY), "requirements.lock.txt")
    (ROOT / preflight.LOCK_STAMP).write_text(preflight.lock_hash(ROOT) + "\n")


ML_LOCK, ML_VENV = "requirements-ml.lock.txt", ".venv-ml"


def sync_ml() -> str:
    """Bring the machine-learning environment (DEC-0016) in line with its own hashed lockfile: "none" when the
    checkout has no such lockfile, "current" when nothing changed, "synced", or "failed".

    It is a separate environment so that the trading one stays exactly its lockfile. It is synced after the
    smoke test, and a failure here never fails the deploy: the trading jobs do not import it, and the scorer
    falls back to unfiltered trading when it is missing (wt.crypto.scorer)."""
    lock = ROOT / ML_LOCK
    if not lock.exists():
        return "none"
    want = hashlib.sha256(lock.read_bytes()).hexdigest()
    stamp = ROOT / ML_VENV / ".lock-sha256"
    if stamp.exists() and stamp.read_text().strip() == want:
        return "current"
    try:
        uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
        if not (ROOT / ML_VENV / "bin" / "python").exists():
            _run(uv, "venv", "--quiet", "--python", str(ROOT / PY), str(ROOT / ML_VENV))
        _run(uv, "pip", "sync", "--quiet", "--python", str(ROOT / ML_VENV / "bin" / "python"), "--require-hashes",
             str(lock), timeout=1800)
        stamp.write_text(want + "\n")
        Alerts().resolve("deploy-ml", "ML environment in sync", "The machine-learning environment matches its lockfile.")
        return "synced"
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
        Alerts().fire("deploy-ml", "ML environment did not sync",
                      f"{str(e)[:200]}. Trading is unaffected; models are not scored until the next deploy fixes it.", 3)
        return "failed"


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


def deploy(sha: str | None = None, stage: bool = False) -> int:
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
    green = ci.check(target)
    ci_override = os.environ.get(CI_OVERRIDE_ENV, "").strip()
    if not green.green and not ci_override:
        print(f"Refusing: {target[:12]} is not green ({green.detail})\n  (owner override: {CI_OVERRIDE_ENV}='reason')")
        return 2
    ok_dash, why_dash, override = dashguard.guard(ROOT, target)
    if not ok_dash:
        print(f"Refusing: {why_dash}\n  (owner override: {dashguard.OVERRIDE_ENV}='reason' make deploy)")
        return 2
    if why_dash:
        print(f"Dashboard check overridden by the owner ({override}): {why_dash}")
    if stage:
        print(f"staging {target[:12]}: the full test suite in a throwaway worktree ...", flush=True)
        passed, out = stage_tests(target)
        if not passed:
            record({"target": target, "staged": False, "stage_output": out})
            Alerts().fire("deploy", "Deploy refused: tests failed", f"The test suite failed on {target[:8]} before "
                          "the switch; the live checkout is unchanged.", 4)
            print(f"Refusing: the test suite failed on {target[:12]}; nothing changed\n{out}")
            return 1
    with job_lock(DEPLOY_LOCK) as got:
        if not got:
            print("Refusing: another deploy is running")
            return 2
        if _refuse_if_closed():                    # staging took a while: a job may be due now
            return 2
        with quiesced() as busy:
            if busy:
                print(f"Refusing: still running after {QUIESCE_WAIT_S:.0f}s: {', '.join(busy)}")
                return 2
            return _switch(target, stage, green, ci_override, why_dash, override)


def _switch(target: str, staged: bool, green: ci.Verdict, ci_override: str, why_dash: str | None,
            override: str | None) -> int:
    before = _run("git", "rev-parse", "HEAD").stdout.strip()
    tag = next_tag()
    _run("git", *TAGGER, "tag", "-a", tag, "-m", f"runtime state before deploy at {_now():%Y-%m-%dT%H:%M:%SZ}", before)
    _run("git", "merge", "--ff-only", "--quiet", target)             # exactly the checked commit: no second fetch
    after = _run("git", "rev-parse", "HEAD").stdout.strip()
    res = migrate.migrate()
    sync_venv()
    ok, out = smoke()
    body: dict[str, object] = {"from": before, "to": after, "rollback_tag": tag, "lock": preflight.lock_hash(ROOT),
                               "migrated": res.moved, "conflicts": res.conflicts, "smoke_ok": ok, "staged": staged,
                               "ci": green.checks if green.green else {"override": ci_override, "why": green.detail},
                               "dashboard_check": "overridden" if why_dash else "ok",
                               **({"dashboard_override": {"reason": override, "why": why_dash}} if why_dash else {})}
    if not ok:
        print(f"Smoke test FAILED on {after[:8]}; rolling back to {tag} (inside the deploy lock)\n{out}")
        _run("git", "reset", "--hard", "--quiet", tag)
        sync_venv()
        body["rolled_back"] = True
        record(body)
        Alerts().fire("deploy", "Deploy rolled back", f"Smoke test failed on {after[:8]}; live checkout restored "
                      f"to {tag}.", 4)
        return 1
    body["ml_env"] = sync_ml()
    rec = record(body)
    Alerts().resolve("deploy", "Deploy healthy", f"Live checkout at {after[:8]}.")
    shown = rec.relative_to(ROOT) if rec.is_relative_to(ROOT) else rec          # WT_STATE may live elsewhere
    print(f"Deployed {before[:8]} -> {after[:8]} (rollback tag {tag}); record {shown}")
    if res.conflicts:
        print("Runtime-state conflicts left alone: " + ", ".join(res.conflicts))
    if host.current().kind == "launchd" and (d := agents.diff()):
        print("launchd agents need reinstalling (owner, outside the trading window):\n  " + "\n  ".join(d) +
              "\n  -> make install-trading-agents")
    return 0


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
        with quiesced() as busy:
            if busy:
                print(f"Refusing: still running after {QUIESCE_WAIT_S:.0f}s: {', '.join(busy)}")
                return 2
            before = _run("git", "rev-parse", "HEAD").stdout.strip()
            _run("git", "reset", "--hard", "--quiet", tag)
            sync_venv()
            ok, out = smoke()
    record({"rollback_from": before, "to_tag": tag, "smoke_ok": ok})
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
    r = sub.add_parser("rollback")
    r.add_argument("tag")
    a = ap.parse_args(argv)
    if a.cmd == "gate":
        b = gate_blockers()
        print("Deploy gate OPEN" if not b else "Deploy gate CLOSED:\n  " + "\n  ".join(b))
        return 0 if not b else 2
    if a.cmd == "migrate":
        return do_migrate()
    if a.cmd == "rollback":
        return rollback(a.tag)
    return deploy(a.sha, a.stage)


if __name__ == "__main__":
    sys.exit(main())
