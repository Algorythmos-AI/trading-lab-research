"""Deploy reviewed code into the live checkout, only when no trading job can be affected (ADR 0002).

    python -m wt.ops.deploy gate              # print whether a deploy is allowed now, and why not
    python -m wt.ops.deploy deploy            # tag, pull, migrate state, sync venv, smoke test, record
    python -m wt.ops.deploy rollback <tag>    # back to a runtime-* tag (same gate, same checks)
    python -m wt.ops.deploy migrate           # move runtime files out of tracked paths (same gate)

The gate refuses when any com.wt.* job is running or holds its lock, inside the trading night
(07:00 ET to close + 2 h on a session day), within an hour of a scheduled start, or when the market calendar
can't be read. A failed smoke test rolls straight back to the tag taken before the pull.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path

from wt.core.config import ROOT, STATE_DIR
from wt.ops import agents, migrate, preflight
from wt.ops.alerts import Alerts
from wt.ops.locks import held
from wt.ops.schedule import JOBS, PY, SYDNEY
from wt.ops.status import parse_launchctl_list
from wt.ops.window import deploy_blockers, load_sessions

DEPLOY_DIR = STATE_DIR / "deploy"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _run(*cmd: str, check: bool = True, timeout: float = 600) -> subprocess.CompletedProcess[str]:
    r = subprocess.run(list(cmd), cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} failed: {(r.stderr or r.stdout).strip()[-400:]}")
    return r


def running_jobs() -> dict[str, bool]:
    labels = [j.label for j in JOBS.values()]
    try:
        text = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return {"launchctl": True}          # can't tell: treat as running (fail closed)
    return {k: bool(v["running"]) for k, v in parse_launchctl_list(text, labels).items()}


def gate_blockers(now: dt.datetime | None = None) -> list[str]:
    now = now or _now()
    sessions, exact = load_sessions(now)
    return deploy_blockers(now, sessions, running_jobs(), held(list(JOBS)), exact)


def sync_venv() -> None:
    uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
    _run(uv, "pip", "sync", "--python", str(ROOT / PY), "requirements.lock.txt")
    (ROOT / preflight.LOCK_STAMP).write_text(preflight.lock_hash(ROOT) + "\n")


def smoke() -> tuple[bool, str]:
    r = _run(str(ROOT / PY), "-m", "pytest", "-m", "smoke", "-q", check=False, timeout=900)
    return r.returncode == 0, (r.stdout + r.stderr).strip()[-600:]


def next_tag() -> str:
    day = dt.datetime.now(SYDNEY).strftime("%Y%m%d")
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


def deploy() -> int:
    if _refuse_if_closed():
        return 2
    git = [c for c in preflight.check_git(ROOT) if c.name in ("on main", "clean code") and not c.ok]
    if git:
        print("Refusing: " + "; ".join(f"{c.name}: {c.detail}" for c in git))
        return 2
    _run("git", "fetch", "--quiet", "origin", "main")
    before = _run("git", "rev-parse", "HEAD").stdout.strip()
    tag = next_tag()
    _run("git", "tag", "-a", tag, "-m", f"runtime state before deploy at {_now():%Y-%m-%dT%H:%M:%SZ}", before)
    _run("git", "pull", "--ff-only", "--quiet", "origin", "main")
    after = _run("git", "rev-parse", "HEAD").stdout.strip()
    res = migrate.migrate()
    sync_venv()
    ok, out = smoke()
    body: dict[str, object] = {"from": before, "to": after, "rollback_tag": tag, "lock": preflight.lock_hash(ROOT),
                               "migrated": res.moved, "conflicts": res.conflicts, "smoke_ok": ok}
    if not ok:
        print(f"Smoke test FAILED after pulling {after[:8]}; rolling back to {tag}\n{out}")
        _run("git", "reset", "--hard", "--quiet", tag)
        sync_venv()
        body["rolled_back"] = True
        record(body)
        Alerts().fire("deploy", "Deploy rolled back", f"Smoke test failed on {after[:8]}; live checkout restored "
                      f"to {tag}.", 4)
        return 1
    rec = record(body)
    Alerts().resolve("deploy", "Deploy healthy", f"Live checkout at {after[:8]}.")
    print(f"Deployed {before[:8]} -> {after[:8]} (rollback tag {tag}); record {rec.relative_to(ROOT)}")
    if res.conflicts:
        print("Runtime-state conflicts left alone: " + ", ".join(res.conflicts))
    if d := agents.diff():
        print("launchd agents need reinstalling (owner, outside the trading window):\n  " + "\n  ".join(d) +
              "\n  -> make install-trading-agents")
    return 0


def broker_cleanup_before_rollback() -> str | None:
    """Older code doesn't know the GTC stops this version places. If the account is flat, cancel this repo's
    resting orders so none can outlive a rollback and open a short. If a position is open, refuse (None = ok)."""
    import os
    os.environ["MODE"] = "paper"                    # the paper adapter asserts it; this only reads and cancels
    from wt.brokers.alpaca_paper import AlpacaPaperBroker
    from wt.core.ids import is_ours
    b = AlpacaPaperBroker()
    if any(p.qty for p in b.positions()):
        return "a position is open: flatten it (or let the session finish) before rolling back"
    for o in b.open_orders():
        if is_ours(o.client_order_id):
            b.cancel(o.client_order_id)
            print(f"cancelled resting {o.client_order_id} {o.symbol}")
    return None


def rollback(tag: str) -> int:
    if not tag.startswith("runtime-"):
        print("Rollback targets are runtime-* tags only")
        return 2
    if _refuse_if_closed():
        return 2
    if (why := broker_cleanup_before_rollback()) is not None:
        print(f"Refusing to roll back: {why}")
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
    sub.add_parser("deploy")
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
    return deploy()


if __name__ == "__main__":
    sys.exit(main())
