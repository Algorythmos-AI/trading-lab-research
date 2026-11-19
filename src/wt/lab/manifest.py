"""A session folder's manifest (DEC-0060 section 2.5): what is in it, how complete it is, and a chain to the last one.

`manifest.json` lists every Parquet part with its sha256 and row count, the focus answer's sha256 and names, the
opening tier-1 set, samples taken and expected, coverage, the host clock's offset and the previous session's manifest
sha256. Written last, atomically; a folder with no manifest is an unfinished session.
"""
from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

NAME = "manifest.json"
HEAD = "chain-head.json"           # in the tape root: the newest manifest's session and sha256, kept after pruning


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def previous(root: Path, session: str) -> str | None:
    """The sha256 of the newest earlier session's manifest: from the chain head when it is earlier (local copies may
    have been pruned), else from the newest earlier folder still on disk, else None."""
    best: tuple[str, str] | None = None                       # (session, sha256): the later of head and folders
    head = root / HEAD
    if head.exists():
        try:
            h = json.loads(head.read_text())
            if isinstance(h, dict) and str(h.get("session", "")) < session and isinstance(h.get("sha256"), str):
                best = (str(h["session"]), str(h["sha256"]))
        except ValueError:
            pass
    earlier = sorted(p for p in root.iterdir() if p.is_dir() and p.name < session and (p / NAME).exists()) \
        if root.exists() else []
    if earlier and (best is None or earlier[-1].name > best[0]):
        best = (earlier[-1].name, sha256_file(earlier[-1] / NAME))
    return best[1] if best else None


def write(folder: Path, info: Mapping[str, Any]) -> dict[str, Any]:
    files = []
    for p in sorted(folder.glob("*.parquet")):
        files.append({"file": p.name, "sha256": sha256_file(p), "rows": pq.ParquetFile(p).metadata.num_rows,
                      "bytes": p.stat().st_size})
    doc = {"v": 1, "session": folder.name, **info, "files": files,
           "previous_manifest_sha256": previous(folder.parent, folder.name)}
    atomic(folder / NAME, json.dumps(doc, indent=2, sort_keys=True) + "\n")
    head = folder.parent / HEAD
    try:
        old = json.loads(head.read_text()) if head.exists() else {}
    except ValueError:
        old = {}
    if not isinstance(old, dict) or str(old.get("session", "")) <= folder.name:
        atomic(head, json.dumps({"session": folder.name, "sha256": sha256_file(folder / NAME)}) + "\n")
    return doc


def atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def verify(folder: Path) -> list[str]:
    """Problems with a session folder against its manifest; empty when every listed file matches."""
    p = folder / NAME
    if not p.exists():
        return ["no manifest"]
    doc = json.loads(p.read_text())
    out = []
    listed = {f["file"] for f in doc.get("files", [])}
    for f in doc.get("files", []):
        fp = folder / f["file"]
        if not fp.exists():
            out.append(f"missing {f['file']}")
        elif sha256_file(fp) != f["sha256"]:
            out.append(f"changed {f['file']}")
    out += [f"unlisted {q.name}" for q in sorted(folder.glob("*.parquet")) if q.name not in listed]
    return out
