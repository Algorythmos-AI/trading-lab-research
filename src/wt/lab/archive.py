"""The tape's archive (DEC-0060 section 2.5): each finished session uploaded write-once, verified, and only then
pruned locally; a sample re-downloaded and checked every week.

    python -m wt.lab.archive upload [--deadline-min 20]   # every finished, not yet uploaded session
    python -m wt.lab.archive prune  [--keep 10]           # local copies of verified, older sessions
    python -m wt.lab.archive check  [--parts 3]           # re-download random parts and compare sha256

The bucket is the lab's own (`WT_LAB_BUCKET`, default `wt-lab-tape`) with its own token (`R2_LAB_ACCESS_KEY_ID`,
`R2_LAB_SECRET_ACCESS_KEY`, and the account's `R2_ACCOUNT_ID`). Nothing is ever overwritten: every upload is a
conditional create, and an object that already exists must hold the same bytes. The session's manifest goes last, so
an object store holding a manifest holds the whole session.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import shutil
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from wt.lab import manifest
from wt.lab.recorder import tape_root

RECEIPT = "upload.json"
MAX_PART_BYTES = 64 * 1024 * 1024           # R2.put holds the whole body in memory


class Store(Protocol):
    def get(self, bucket: str, key: str) -> Any: ...
    def put(self, bucket: str, key: str, body: bytes, if_match: str | None = None,
            if_none_match: str | None = None, content_type: str = "application/json") -> Any: ...


def key_of(session: str, name: str) -> str:
    return f"tape/{session}/{name}"


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def put_once(store: Store, bucket: str, key: str, body: bytes) -> str | None:
    """None when the object now holds exactly `body`; otherwise why not."""
    r = store.put(bucket, key, body, if_none_match="*", content_type="application/octet-stream")
    if r.status in (200, 201):
        etag = (r.etag or "").strip('"')
        if etag and len(etag) == 32 and etag != hashlib.md5(body, usedforsecurity=False).hexdigest():
            return f"etag mismatch on {key}"
        return None
    if r.status == 412:                                      # already there: it must be the same bytes
        g = store.get(bucket, key)
        if g.status == 200 and _sha(g.body) == _sha(body):
            return None
        return f"{key} exists with other bytes"
    return f"status {r.status} on {key}"


def finished(root: Path) -> list[Path]:
    """Session folders with a manifest, oldest first."""
    return sorted(p for p in root.iterdir() if p.is_dir() and (p / manifest.NAME).exists()) if root.exists() else []


def receipt_ok(folder: Path) -> bool:
    r = folder / RECEIPT
    if not r.exists():
        return False
    try:
        doc = json.loads(r.read_text())
    except ValueError:
        return False
    return bool(doc.get("verified")) and doc.get("manifest_sha256") == manifest.sha256_file(folder / manifest.NAME)


def upload(folder: Path, store: Store, bucket: str, deadline: float | None = None) -> dict[str, Any]:
    """Upload one finished session; write a receipt only when every object is in place."""
    problems = manifest.verify(folder)
    if problems:
        return {"session": folder.name, "verified": False, "problems": problems}
    doc = json.loads((folder / manifest.NAME).read_text())
    names = [f["file"] for f in doc.get("files", [])] + [manifest.NAME]
    out: dict[str, Any] = {"session": folder.name, "objects": [], "problems": []}
    for name in names:
        if deadline is not None and time.monotonic() > deadline:
            out["problems"].append("deadline")
            break
        path = folder / name
        if path.stat().st_size > MAX_PART_BYTES:
            out["problems"].append(f"{name} too large")
            break
        body = path.read_bytes()
        why = put_once(store, bucket, key_of(folder.name, name), body)
        if why:
            out["problems"].append(why)
            break
        out["objects"].append({"key": key_of(folder.name, name), "sha256": _sha(body), "bytes": len(body)})
    out["verified"] = not out["problems"] and len(out["objects"]) == len(names)
    if out["verified"]:
        out["manifest_sha256"] = manifest.sha256_file(folder / manifest.NAME)
        out["uploaded_at"] = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
        tmp = folder / (RECEIPT + ".tmp")
        tmp.write_text(json.dumps(out, indent=2) + "\n")
        os.replace(tmp, folder / RECEIPT)
    return out


def upload_all(root: Path, store: Store, bucket: str, deadline: float | None = None) -> list[dict[str, Any]]:
    return [upload(f, store, bucket, deadline) for f in finished(root) if not receipt_ok(f)]


def prune(root: Path, keep: int = 10) -> list[str]:
    """Remove local sessions older than the newest `keep`, and only those with a verified receipt."""
    done = finished(root)
    gone = []
    for f in done[:-keep] if keep > 0 else done:
        if receipt_ok(f):
            shutil.rmtree(f)
            gone.append(f.name)
    return gone


def check(store: Store, bucket: str, root: Path, parts: int = 3, rng: random.Random | None = None) -> dict[str, Any]:
    """Re-download random archived parts listed in local receipts and compare their sha256."""
    pool = []
    for f in finished(root):
        if receipt_ok(f):
            pool += json.loads((f / RECEIPT).read_text())["objects"]
    pick = (rng or random.Random()).sample(pool, min(parts, len(pool)))
    bad = []
    for o in pick:
        g = store.get(bucket, o["key"])
        if g.status != 200 or _sha(g.body) != o["sha256"]:
            bad.append(o["key"])
    return {"checked": len(pick), "bad": bad}


def store_from_env(env: Mapping[str, str]) -> Store | None:
    from wt.ops.r2 import R2
    r2 = R2(account_id=env.get("R2_ACCOUNT_ID"), access_key=env.get("R2_LAB_ACCESS_KEY_ID"),
            secret_key=env.get("R2_LAB_SECRET_ACCESS_KEY"), timeout=120)
    return r2 if r2.configured else None


def main(argv: Sequence[str] | None = None, store: Store | None = None, env: Mapping[str, str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("what", choices=("upload", "prune", "check"))
    ap.add_argument("--deadline-min", type=float, default=20.0)
    ap.add_argument("--keep", type=int, default=10)
    ap.add_argument("--parts", type=int, default=3)
    args = ap.parse_args(argv)
    e = dict(os.environ) if env is None else dict(env)
    root, bucket = tape_root(e), e.get("WT_LAB_BUCKET", "wt-lab-tape")
    if args.what == "prune":
        print(json.dumps({"pruned": prune(root, args.keep)}))
        return 0
    s = store or store_from_env(e)
    if s is None:
        print("no lab bucket credentials (R2_ACCOUNT_ID, R2_LAB_ACCESS_KEY_ID, R2_LAB_SECRET_ACCESS_KEY)", file=sys.stderr)
        return 2
    if args.what == "upload":
        res = upload_all(root, s, bucket, time.monotonic() + args.deadline_min * 60)
        print(json.dumps([{k: r[k] for k in ("session", "verified", "problems")} for r in res]))
        return 0 if all(r["verified"] for r in res) else 1
    res2 = check(s, bucket, root, args.parts)
    print(json.dumps(res2))
    return 0 if not res2["bad"] else 1


if __name__ == "__main__":
    sys.exit(main())
