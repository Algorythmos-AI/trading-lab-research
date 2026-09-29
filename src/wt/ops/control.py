"""Owner control actions that loosen safety: `make unkill` and `make reset-latch` (plan R7, loopholes L14/L15).

Both refuse while paper B's runner is live (its job lock is held). Mid-session they would be unsafe or silently
undone: an unkill would re-enable entries part-way through a session, and a reset is overwritten by the runner's
in-memory account at its next save. Tightening actions (`make kill`) are never refused.

Every action is recorded: KILL on/off in the hash-chained audit log (wt.ops.audit); a latch reset in the virtual
account's own latch history, which the dashboard's audit trail already reads. The owner's words stay on the host.

    python -m wt.ops.control unkill
    python -m wt.ops.control reset-latch "why it is safe to resume"
"""
from __future__ import annotations

import sys
from pathlib import Path

from wt.core.config import DATA_DIR, ROOT
from wt.ops import audit, locks

RUNNER_JOB = "paper-b"
VA_PATH = DATA_DIR / "live" / "virtual_account.json"


def runner_live(lock_root: Path | None = None) -> bool:
    return locks.is_held(RUNNER_JOB, lock_root)


def unkill(root: Path = ROOT, lock_root: Path | None = None, audit_log: Path | None = None) -> tuple[int, str]:
    kill = root / "KILL"
    if not kill.exists():
        return 0, "KILL switch already off"
    if runner_live(lock_root):
        return 3, ("paper B is running (its lock is held): removing KILL now would re-enable entries mid-session. "
                   "Try again after the session ends.")
    kill.unlink()
    _audit("kill_off", audit_log)
    return 0, "KILL switch off"


def reset_latch(reason: str, va_path: Path = VA_PATH, lock_root: Path | None = None) -> tuple[int, str]:
    from wt.risk.virtual_account import reset_latch as _reset
    if not reason.strip():
        return 2, 'usage: make reset-latch REASON="why it is safe to resume"'
    if runner_live(lock_root):
        return 3, ("paper B is running (its lock is held): its in-memory account would overwrite a reset at the "
                   "next save. Try again after the session ends.")
    va = _reset(va_path, reason)
    return 0, f"latch cleared; recorded at {va.latch_history[-1]['at']}"


def _audit(kind: str, path: Path | None) -> None:
    try:
        audit.append(kind, path=path or audit.AUDIT)
    except OSError as e:
        print(f"audit log not written ({e.__class__.__name__})", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args[:1] == ["unkill"]:
        code, msg = unkill()
    elif args[:1] == ["reset-latch"]:
        code, msg = reset_latch(" ".join(args[1:]))
    else:
        code, msg = 2, "usage: python -m wt.ops.control {unkill | reset-latch REASON}"
    print(msg, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
