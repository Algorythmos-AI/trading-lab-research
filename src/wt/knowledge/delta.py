"""K0.0 — compare the live US STOCKS tree against the prior _kb manifest.

Read-only on the source tree. Detects iCloud-evicted (dataless) files, new,
missing and changed files. Hashing is done only for files whose size/mtime
differ from the manifest or that are new, to keep I/O low.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/US STOCKS"
MANIFEST = ROOT / "_kb/manifest.csv"
SF_DATALESS = 0x40000000
SKIP_DIRS = {"_kb", "_output"}
SKIP_NAMES = {".DS_Store"}


def walk(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        if rel_dir.parts and rel_dir.parts[0] in SKIP_DIRS:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if not (not rel_dir.parts and d in SKIP_DIRS)]
        for name in filenames:
            if name in SKIP_NAMES or name.startswith("._"):
                continue
            p = Path(dirpath) / name
            st = p.lstat()
            yield str(p.relative_to(root)), st


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(out_dir: Path, do_hash: bool) -> None:
    csv.field_size_limit(sys.maxsize)
    with open(MANIFEST, newline="") as f:
        manifest = {r["path"]: r for r in csv.DictReader(f)}
    live = {}
    dataless = []
    for rel, st in walk(ROOT):
        live[rel] = st
        if getattr(st, "st_flags", 0) & SF_DATALESS:
            dataless.append(rel)
    new = sorted(set(live) - set(manifest))
    missing = sorted(p for p in set(manifest) - set(live)
                     if manifest[p].get("status") != "skipped")
    changed = []
    if do_hash:
        by_sha = {r["sha256"]: p for p, r in manifest.items() if r.get("sha256")}
        moved = []
        for rel in new:
            if rel in dataless:
                continue
            h = sha256(ROOT / rel)
            if h in by_sha:
                moved.append({"new_path": rel, "old_path": by_sha[h], "sha256": h})
        for rel in sorted(set(live) & set(manifest)):
            m = manifest[rel]
            try:
                if int(m.get("bytes") or -1) != live[rel].st_size:
                    changed.append(rel)
            except ValueError:
                pass
    else:
        moved = []
    report = {
        "live_files": len(live),
        "manifest_rows": len(manifest),
        "dataless": len(dataless),
        "new": len(new),
        "missing": len(missing),
        "moved_or_renamed": len(moved),
        "size_changed": len(changed),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "delta_report.json").write_text(json.dumps(
        {"summary": report, "dataless": dataless, "new": new, "missing": missing,
         "moved": moved, "size_changed": changed}, indent=1, ensure_ascii=False))
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("knowledge/_work"),
         do_hash="--hash" in sys.argv)
