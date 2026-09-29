"""Hash-chained append-only ledgers (the forward ledger today; the paper journal next, plan R3).

Every line after the chain starts carries `prev_sha256`, the sha256 of the previous line's bytes (GENESIS on a
fresh file's first line). Lines written before the chain existed carry none and are accepted as a prefix. Like any
hash chain, an edit to the very last line is invisible here: that is what the daily off-host anchor of `head()` is
for (wt.ops.backup).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

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
