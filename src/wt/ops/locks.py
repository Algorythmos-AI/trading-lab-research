"""Per-job exclusive locks (flock) under var/locks/.

Each nightly job holds its own lock for its whole run. There is deliberately no shared lock: the routine and the
paper runner overlap by design. The deploy gate refuses while any lock is held.
"""
from __future__ import annotations

import contextlib
import fcntl
import time
from collections.abc import Iterator
from pathlib import Path

from wt.core.config import STATE_DIR

LOCK_DIR = STATE_DIR / "locks"
# Held by the paper-B runner process itself for its whole session (the job lock is held by the jobs.py wrapper,
# which runs the runner in its own session: if the wrapper dies, this is what still marks the runner as live).
RUNNER_LOCK = "paper-b-runner"
DEPLOY_LOCK = "deploy"             # held while a deploy or rollback changes the live checkout; jobs wait for it


def _path(name: str, root: Path | None) -> Path:
    d = root or LOCK_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{name}.lock"


@contextlib.contextmanager
def job_lock(name: str, root: Path | None = None, wait_s: float = 0.0, poll_s: float = 5.0) -> Iterator[bool]:
    """Hold ``name``'s lock for the block. Yields False (without the lock) if it is still busy after ``wait_s``."""
    path = _path(name, root)
    with open(path, "a+") as fh:
        deadline = time.monotonic() + wait_s
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    yield False
                    return
                time.sleep(min(poll_s, max(0.0, deadline - time.monotonic())))
        try:
            yield True
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def is_held(name: str, root: Path | None = None) -> bool:
    """True if another process holds ``name``'s lock right now."""
    with job_lock(name, root) as got:
        return not got


def held(names: list[str], root: Path | None = None) -> list[str]:
    return [n for n in names if is_held(n, root)]
