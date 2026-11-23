"""Owner control actions that loosen safety: `make unkill` and `make reset-latch` (plan R7, loopholes L14/L15).

Both refuse while the QQQ rule's runner is live (its job lock is held), and act while holding that lock themselves. Mid-session they would be unsafe or silently
undone: an unkill would re-enable entries part-way through a session, and a reset is overwritten by the runner's
in-memory account at its next save. Tightening actions (`make kill`) are never refused.

Since DEC-0069 (2026-11-20) the QQQ rule is retired and its job (`paper-b`) is gone, so that lock is never held by a
scheduled run: the refusal now only catches a runner someone started by hand. The root KILL file is still read by the
options clone (wt.live.runner_o), so `make kill` and `make unkill` keep their use. `reset-latch` clears the retired
rule's virtual account and has no use while nothing trades it. The lock names below are not renamed.

Every action is recorded: KILL on/off in the hash-chained audit log (wt.ops.audit); a latch reset in the virtual
account's own latch history, which the dashboard's audit trail already reads. The owner's words stay on the host.

    python -m wt.ops.control unkill
    python -m wt.ops.control reset-latch "why it is safe to resume"
    python -m wt.ops.control reset-latch-s "DEC-NNNN: why it is safe to resume"

`reset-latch-s` clears the stock desk's (Gap Hunter's) latch, on its own account file, and refuses while `paper-s` or
its runner holds a lock. Its stop rule (DEC-0066) and its execution stops (DEC-0073) latch with a reason that only a
new decision record clears: name that record in the reason, or nothing is changed.
"""
from __future__ import annotations

import contextlib
import sys
from collections.abc import Iterator
from pathlib import Path

from wt.core.config import DATA_DIR, ROOT, STATE_DIR
from wt.ops import audit, locks

RUNNER_JOB = "paper-b"
VA_PATH = DATA_DIR / "live" / "virtual_account.json"
RUNNER_JOB_S = "paper-s"
VA_PATH_S = STATE_DIR / "smallcap" / "virtual_account.json"     # wt.live.runner_s.VA_PATH


BUSY_UNKILL = ("paper B is running (its lock is held): removing KILL now would re-enable entries mid-session. "
               "Try again after the session ends.")
BUSY_RESET_S = ("paper-s is running (its lock is held): its in-memory account would overwrite a reset at the next "
                "save. Try again after the session ends.")
BUSY_RESET = ("paper B is running (its lock is held): its in-memory account would overwrite a reset at the next "
              "save. Try again after the session ends.")


@contextlib.contextmanager
def _runner_idle(lock_root: Path | None, job_name: str = RUNNER_JOB,
                 runner_lock: str = locks.RUNNER_LOCK) -> Iterator[bool]:
    """Hold both the job's lock and its runner process's own lock for the block; yields False if either is held
    elsewhere (a runner orphaned by a dead wrapper holds only the second)."""
    with locks.job_lock(job_name, lock_root) as job:
        if not job:                        # the wrapper is running the job: don't touch the runner's lock at all
            yield False
            return
        with locks.job_lock(runner_lock, lock_root) as runner:
            yield runner


def unkill(root: Path = ROOT, lock_root: Path | None = None, audit_log: Path | None = None) -> tuple[int, str]:
    """The action runs while holding paper-b's lock, so the runner can't start half-way through it (and a start
    that meets the lock refuses cleanly, through the normal jobs.py path)."""
    kill = root / "KILL"
    if not kill.exists():
        return 0, "KILL switch already off"
    with _runner_idle(lock_root) as got:
        if not got:
            return 3, BUSY_UNKILL
        kill.unlink()
        _audit("kill_off", audit_log)
    return 0, "KILL switch off"


def reset_latch(reason: str, va_path: Path = VA_PATH, lock_root: Path | None = None) -> tuple[int, str]:
    return _reset_latch(reason, va_path, lock_root, RUNNER_JOB, locks.RUNNER_LOCK, BUSY_RESET, "reset-latch")


def reset_latch_s(reason: str, va_path: Path = VA_PATH_S, lock_root: Path | None = None) -> tuple[int, str]:
    """The stock desk's latch (Gap Hunter): its stop rule's or an execution stop's, cleared only by a new record."""
    return _reset_latch(reason, va_path, lock_root, RUNNER_JOB_S, locks.RUNNER_LOCK_S, BUSY_RESET_S, "reset-latch-s")


def _reset_latch(reason: str, va_path: Path, lock_root: Path | None, job_name: str, runner_lock: str, busy: str,
                 target: str) -> tuple[int, str]:
    from wt.risk.virtual_account import NotLatched, StateError
    from wt.risk.virtual_account import reset_latch as _reset
    if not reason.strip():
        return 2, f'usage: make {target} REASON="why it is safe to resume"'
    with _runner_idle(lock_root, job_name, runner_lock) as got:
        if not got:
            return 3, busy
        try:
            va = _reset(va_path, reason)
        except NotLatched as e:
            return 0, str(e)
        except StateError as e:
            return 4, f"{e} (nothing was changed)"
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
    elif args[:1] == ["reset-latch-s"]:
        code, msg = reset_latch_s(" ".join(args[1:]))
    else:
        code, msg = 2, "usage: python -m wt.ops.control {unkill | reset-latch REASON | reset-latch-s REASON}"
    print(msg, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
