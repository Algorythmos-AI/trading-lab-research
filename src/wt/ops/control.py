"""Owner control actions that loosen safety: `make unkill` and `make reset-latch` (plan R7, loopholes L14/L15).

Both refuse while the QQQ rule's runner is live (its job lock is held), and act while holding that lock themselves. Mid-session they would be unsafe or silently
undone: an unkill would re-enable entries part-way through a session, and a reset is overwritten by the runner's
in-memory account at its next save. Tightening actions (`make kill`) are never refused.

Since DEC-0069 (2026-11-20) the QQQ rule is retired and its job (`paper-b`) is gone, so that lock is never held by a
scheduled run: the refusal now only catches a runner someone started by hand. The root KILL file is the master switch:
the options clone (wt.live.runner_o) and Gap Hunter (wt.live.runner_s) both read it, so `make kill` with no DESK stops
every desk's new entries. `reset-latch` clears the retired
rule's virtual account and has no use while nothing trades it. The lock names below are not renamed.

`make kill DESK=s` / `make unkill DESK=s` act on Gap Hunter's own file (var/smallcap/KILL), `DESK=options` on the
clone's own file; only the root file's unkill takes the lock above. An unknown DESK is refused rather than falling
back to the root file, so a typo never stops a different set of desks than the one named.

Every action is recorded: KILL on/off for every desk's file in the hash-chained audit log (wt.ops.audit), the
desk's name as the row's detail; a latch reset in the virtual
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
from wt.core.desk import OPTIONS_DIR
from wt.ops import audit, locks

RUNNER_JOB = "paper-b"
VA_PATH = DATA_DIR / "live" / "virtual_account.json"
RUNNER_JOB_S = "paper-s"
VA_PATH_S = STATE_DIR / "smallcap" / "virtual_account.json"     # wt.live.runner_s.VA_PATH
KILL_S = STATE_DIR / "smallcap" / "KILL"                         # wt.live.runner_s.KILL: Gap Hunter's own kill file
KILL_OPTIONS = OPTIONS_DIR / "KILL"                              # wt.core.desk.DESKS["options"].kill_file
# The desks `make kill DESK=...` / `make unkill DESK=...` name. The root file stops every desk (the clone and Gap
# Hunter both read it); no DESK (or DESK=stocks) means the root file. The audit row's detail carries this name, which stays on the host.
DESK_KILLS = {"root": None, "options": KILL_OPTIONS, "s": KILL_S}
# How `make status`, the forward summary and the dashboard name each file. The root file stops every desk.
KILL_LABELS = {"s": "Gap Hunter", "options": "Options clone", "root": "All desks (root KILL)"}


def kill_states(root: Path = ROOT) -> dict[str, bool]:
    """Is each desk's kill file on? Keys as DESK_KILLS: `s` (Gap Hunter), `options` (the clone's own file) and
    `root` (the root KILL, which every desk reads). A file that can't be checked counts as on: a status line
    must never say a desk can enter when it can't tell."""
    out: dict[str, bool] = {}
    for desk, f in DESK_KILLS.items():
        path = f or root / "KILL"
        try:
            out[desk] = path.exists()
        except OSError:
            out[desk] = True
    return out


def kill_lines(root: Path = ROOT) -> list[str]:
    """`make status`'s kill switch lines: one per desk's file."""
    states = kill_states(root)
    return [f"  {KILL_LABELS[d]:27} {'ON (no new entries)' if states[d] else 'off'}" for d in ("s", "options", "root")]


def paused_note(root: Path = ROOT) -> str:
    """The forward summary's note on which desks' kill files are on, or "" when none is."""
    on = [KILL_LABELS[d] for d, v in kill_states(root).items() if v]
    return f" Kill switch on: {', '.join(on)}. New entries there are paused." if on else ""


BUSY_UNKILL = ("paper B is running (its lock is held): removing KILL now would re-enable entries mid-session. "
               "Try again after the session ends.")
BUSY_UNKILL_S = ("paper-s (Gap Hunter) is running (its lock is held): the root KILL stops it too, so removing it now "
                 "would re-enable its entries mid-session. Try again after the session ends.")
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


def unkill(root: Path = ROOT, lock_root: Path | None = None, audit_log: Path | None = None, desk: str = "root",
           kill_file: Path | None = None) -> tuple[int, str]:
    """Remove one desk's kill file and write `kill_off` (detail: the desk) to the audit log.

    The root file is removed while holding paper-b's and paper-s's locks: it stops every desk, so removing it while
    Gap Hunter's session runs would re-enable its entries mid-session (refused, like paper-b's), and neither runner can
    start half-way through it (a start that meets the lock refuses cleanly, through the normal jobs.py path). Gap Hunter's (`s`) and the options clone's
    own file are removed without a lock check, as `rm` would: each runner re-reads its file and logs the change."""
    desk = desk_name(desk)
    if desk not in DESK_KILLS:
        return 2, f"unknown desk {desk!r}: use s (Gap Hunter), options, or none for the root KILL file"
    kill = kill_file or DESK_KILLS[desk] or root / "KILL"
    label = "KILL switch" if desk == "root" else f"{desk} KILL switch"
    if not kill.exists():
        return 0, f"{label} already off"
    if desk != "root":
        kill.unlink()
        _audit("kill_off", audit_log, desk)
        return 0, f"{label} off"
    with _runner_idle(lock_root) as got:
        if not got:
            return 3, BUSY_UNKILL
        with _runner_idle(lock_root, RUNNER_JOB_S, locks.RUNNER_LOCK_S) as got_s:
            if not got_s:
                return 3, BUSY_UNKILL_S
            kill.unlink()
            _audit("kill_off", audit_log, desk)
    return 0, f"{label} off"


def desk_name(desk: str) -> str:
    """The Makefile's DESK value as a key of DESK_KILLS: none or `stocks` is the root file; case is ignored."""
    d = desk.strip().lower()
    return "root" if d in ("", "stocks") else d


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


def _audit(kind: str, path: Path | None, detail: str = "") -> None:
    try:
        audit.append(kind, detail, path=path or audit.AUDIT)
    except OSError as e:
        print(f"audit log not written ({e.__class__.__name__})", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args[:1] == ["unkill"]:
        code, msg = unkill(desk=" ".join(args[1:2]))
    elif args[:1] == ["reset-latch"]:
        code, msg = reset_latch(" ".join(args[1:]))
    elif args[:1] == ["reset-latch-s"]:
        code, msg = reset_latch_s(" ".join(args[1:]))
    else:
        code, msg = 2, "usage: python -m wt.ops.control {unkill [s|options] | reset-latch REASON | reset-latch-s REASON}"
    print(msg, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
