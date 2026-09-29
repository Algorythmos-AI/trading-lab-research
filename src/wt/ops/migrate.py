"""Move runtime files out of tracked paths into var/ (ADR 0002). Idempotent and lossless.

Each file is copied, verified by sha256, then the original is moved to var/migrated/<timestamp>/ (not deleted).
If a destination already exists with different content, that file is reported as a conflict and left alone.
Run it only through the deploy gate (`make migrate-state` or `make deploy`): a nightly job may be writing.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from wt.core.config import ROOT, STATE_DIR

MOVES = (("research/forward/forward_trades.jsonl", "forward/forward_trades.jsonl"),
         ("research/forward/routine", "routine"))


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


@dataclass
class Result:
    moved: list[str] = field(default_factory=list)
    already: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)


def _untracked_forward_watchlists(root: Path) -> list[str]:
    """watchlist/<date>.json files written by the old forward test and never committed."""
    try:
        out = subprocess.run(["git", "-C", str(root), "ls-files", "--others", "--exclude-standard", "--", "watchlist"],
                             capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    keep = []
    for rel in out.splitlines():
        if not rel.endswith(".json"):
            continue
        try:
            if json.loads((root / rel).read_text()).get("forward") is True:
                keep.append(rel)            # research watchlists that are merely uncommitted stay where they are
        except (OSError, ValueError, AttributeError):
            continue
    return keep


def plan(root: Path, state: Path) -> list[tuple[Path, Path]]:
    pairs: list[tuple[Path, Path]] = []
    for src_rel, dst_rel in MOVES:
        src = root / src_rel
        if src.is_file():
            pairs.append((src, state / dst_rel))
        elif src.is_dir():
            pairs += [(f, state / dst_rel / f.relative_to(src)) for f in sorted(src.rglob("*")) if f.is_file()]
    pairs += [(root / rel, state / "watchlist" / Path(rel).name) for rel in _untracked_forward_watchlists(root)]
    return pairs


def migrate(root: Path | None = None, state: Path | None = None, now: dt.datetime | None = None) -> Result:
    root, state = root or ROOT, state or STATE_DIR
    stamp = (now or dt.datetime.now(dt.UTC)).strftime("%Y%m%dT%H%M%SZ")
    backup = state / "migrated" / stamp
    res = Result()
    for src, dst in plan(root, state):
        rel = str(src.relative_to(root))
        if dst.exists():
            if _sha(dst) != _sha(src):
                res.conflicts.append(rel)
                continue
            res.already.append(rel)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            tmp = dst.with_name(f".{dst.name}.migrating")
            shutil.copy2(src, tmp)
            if _sha(tmp) != _sha(src):
                tmp.unlink(missing_ok=True)
                res.conflicts.append(rel)
                continue
            tmp.replace(dst)
            res.moved.append(rel)
        keep = backup / rel
        keep.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), keep)
    for src_rel, _ in MOVES:                    # drop directories the move emptied
        d = root / src_rel
        if d.is_dir() and not any(p.is_file() for p in d.rglob("*")):
            shutil.rmtree(d)
    return res
