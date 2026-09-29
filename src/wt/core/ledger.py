"""Hash-chained append-only ledgers: the forward ledger and the paper journal (plan R3).

Every line after the chain starts carries `prev_sha256`, the sha256 of the previous line's bytes (GENESIS on a
fresh file's first line). Lines written before the chain existed carry none and are accepted as a prefix. Like any
hash chain, an edit to the very last line is invisible here: that is what the daily off-host anchor of `head()` is
for (wt.ops.backup).
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
from typing import Any

GENESIS = "0" * 64


def verify_chain(path: Path) -> list[str]:
    """Problems in the file's hash chain; empty when intact (or when the file doesn't exist)."""
    if not path.exists():
        return []
    problems: list[str] = []
    prev: bytes | None = None
    chained = False
    for i, line in enumerate([x for x in path.read_bytes().split(b"\n") if x], 1):
        want = hashlib.sha256(prev).hexdigest() if prev is not None else GENESIS
        prev = line
        try:
            r = json.loads(line)
        except ValueError:
            r = None
        if not isinstance(r, dict):
            problems.append(f"line {i}: not a JSON object")
            continue
        if r.get("prev_sha256") is None:
            if chained:
                problems.append(f"line {i}: no prev_sha256 after the chain started")
            continue
        chained = True
        if r["prev_sha256"] != want:
            problems.append(f"line {i}: prev_sha256 does not match line {i - 1}" if i > 1 else f"line {i}: not genesis")
    return problems


def head(path: Path) -> tuple[int, str | None]:
    """(line count, sha256 of the last line): what the daily anchor records. (0, None) for a missing/empty file."""
    if not path.exists():
        return 0, None
    lines = [x for x in path.read_bytes().split(b"\n") if x]
    return len(lines), (hashlib.sha256(lines[-1]).hexdigest() if lines else None)


TAIL = 65_536


def _tail(fh: Any) -> tuple[bytes | None, bool]:
    """(last complete-or-torn line, whether the file ends with a newline). Reads the whole file only when the last
    line is longer than TAIL."""
    fh.seek(0, os.SEEK_END)
    size = fh.tell()
    if size == 0:
        return None, True
    start = max(0, size - TAIL)
    fh.seek(start)
    chunk = fh.read()
    ends = chunk.endswith(b"\n")
    lines = [x for x in chunk.split(b"\n") if x]
    if start > 0 and len(lines) <= 1 and b"\n" not in chunk.rstrip(b"\n"):
        fh.seek(0)
        lines = [x for x in fh.read().split(b"\n") if x]
    return (lines[-1] if lines else None), ends


def append(path: Path, rec: dict[str, Any], fsync: bool = False) -> str:
    """Append `rec` as one JSON line carrying prev_sha256 (the sha256 of the previous line, GENESIS on an empty
    file). Holds an exclusive flock on the file while it reads the tail and writes. A torn last line (a writer killed
    mid-line) is ended first, so it stays a line of its own that verify_chain reports. Returns the line written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+b") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            last, ends = _tail(fh)
            prev = hashlib.sha256(last).hexdigest() if last is not None else GENESIS
            line = json.dumps({**rec, "prev_sha256": prev}, default=str)
            fh.seek(0, os.SEEK_END)
            fh.write((b"" if ends else b"\n") + line.encode() + b"\n")
            fh.flush()
            if fsync:
                os.fsync(fh.fileno())
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
    return line
