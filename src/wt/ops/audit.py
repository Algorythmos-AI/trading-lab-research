"""Append-only, hash-chained audit log of owner and operator actions: var/audit/events.jsonl.

Only actions with no other durable record are logged here (KILL on/off today). Deploys, latch resets, refusals and
alerts already have their own records; the publisher merges them into one trail (wt.analytics.ops_view.audit_trail).
Each row: {seq, at, kind, detail, prev, hash}; hash = sha256(prev + canonical JSON of the row without its hash).
Free text the owner types (a KILL reason) stays local: only `kind` and `at` are ever published.

CLI (used by the Makefile): python -m wt.ops.audit <kind> [detail]
"""
from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from wt.core.config import STATE_DIR

AUDIT = STATE_DIR / "audit" / "events.jsonl"
GENESIS = "0" * 64
KINDS = ("kill_on", "kill_off", "latch_reset", "override", "note")


def _digest(row: dict[str, Any]) -> str:
    body = json.dumps({k: v for k, v in row.items() if k != "hash"}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256((row["prev"] + body).encode()).hexdigest()


def read(path: Path = AUDIT) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            r = {"_bad": line[:40]}
        rows.append(r if isinstance(r, dict) else {"_bad": str(r)[:40]})
    return rows


def verify(rows: list[dict[str, Any]]) -> tuple[bool, int | None]:
    """(ok, seq of the first bad row or None). Torn lines (a crash mid-write; read() marks them `_bad`) are skipped:
    append() chains past them to the last good row, so they hide nothing. Deleting trailing rows is not visible
    here; the dashboard publishes the row count for that."""
    prev = GENESIS
    good = [r for r in rows if "_bad" not in r]
    for i, r in enumerate(good):
        intact = isinstance(r.get("prev"), str) and r["prev"] == prev and r.get("seq") == i \
            and r.get("hash") == _digest(r)
        if not intact:
            return False, i
        prev = r["hash"]
    return True, None


def append(kind: str, detail: str = "", path: Path = AUDIT, now: dt.datetime | None = None) -> dict[str, Any]:
    if kind not in KINDS:
        raise ValueError(f"unknown audit kind {kind!r}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        good = [r for r in read(path) if "_bad" not in r]
        prev = str(good[-1].get("hash", GENESIS)) if good else GENESIS
        row: dict[str, Any] = {"seq": len(good), "at": (now or dt.datetime.now(dt.UTC)).isoformat(timespec="seconds"),
                               "kind": kind, "detail": detail[:200], "prev": prev}
        row["hash"] = _digest(row)
        torn = path.exists() and path.stat().st_size > 0 and not path.read_bytes().endswith(b"\n")
        with open(path, "a") as fh:
            fh.write(("\n" if torn else "") + json.dumps(row, sort_keys=True) + "\n")   # end a torn line first
            fh.flush()
            os.fsync(fh.fileno())
    return row


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or args[0] not in KINDS:
        print(f"usage: python -m wt.ops.audit {{{'|'.join(KINDS)}}} [detail]", file=sys.stderr)
        return 2
    try:
        append(args[0], " ".join(args[1:]))
    except OSError as e:
        print(f"audit log not written ({e.__class__.__name__})", file=sys.stderr)
        return 0                         # never block the owner's action on the log
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
