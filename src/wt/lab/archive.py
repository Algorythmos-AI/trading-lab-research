"""The tape's archive (DEC-0060 section 2.5): each finished session uploaded write-once, verified, and only then
pruned locally; every archived session's manifest and a seeded sample of its parts re-read every week.

    python -m wt.lab.archive upload [--deadline-min 20]   # every finished, not yet uploaded session
    python -m wt.lab.archive prune  [--keep 10]           # local copies of older sessions, each re-read remotely first
    python -m wt.lab.archive check  [--parts 12]          # every archived manifest, and a seeded sample of parts

The bucket is the lab's own (`WT_LAB_BUCKET`, default `wt-lab-tape`; its name must start `wt-lab-`) with its own
token (`R2_LAB_ACCESS_KEY_ID`, `R2_LAB_SECRET_ACCESS_KEY`, and the account's `R2_ACCOUNT_ID`). No other credential is
ever used: with any of the three missing, nothing is sent. Nothing is overwritten: every upload is a conditional
create, and an object that already exists must hold the same bytes. Every file of the session folder is uploaded, the
manifest last, so a bucket holding a manifest holds the whole session.

Receipts are kept in `<tape root>/receipts/<session>.json`, outside the session folders, so they outlive the local
copies: the weekly check reads every archived session from them, not only the ones still on disk.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import random
import shutil
import sys
import time
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from wt.lab import manifest
from wt.lab.recorder import tape_root

RECEIPT = "upload.json"                     # the session folder's copy (the receipts folder holds the lasting one)
RECEIPTS = "receipts"
MAX_PART_BYTES = 64 * 1024 * 1024           # R2.put holds the whole body in memory
SKIP = {".lock", RECEIPT}                   # never uploaded: the folder's own receipt, and lock files
BUCKET_PREFIX = "wt-lab-"


class Store(Protocol):
    def get(self, bucket: str, key: str) -> Any: ...
    def put(self, bucket: str, key: str, body: bytes, if_match: str | None = None,
            if_none_match: str | None = None, content_type: str = "application/json") -> Any: ...


def key_of(session: str, name: str) -> str:
    return f"tape/{session}/{name}"


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def bucket_of(env: Mapping[str, str]) -> str:
    """The lab's bucket. Refused unless its name is a lab bucket's: the tape is PRIVATE and never goes to the backup's
    or anyone else's bucket, whatever the environment says."""
    b = env.get("WT_LAB_BUCKET") or "wt-lab-tape"
    if not b.startswith(BUCKET_PREFIX):
        raise ValueError(f"the lab's bucket must be named {BUCKET_PREFIX}*: {b!r}")
    return b


def put_once(store: Store, bucket: str, key: str, body: bytes) -> str | None:
    """None when the object now holds exactly `body`; otherwise why not. An answer whose ETag cannot vouch for the
    bytes (missing, or not a plain MD5) is checked by reading the object back."""
    r = store.put(bucket, key, body, if_none_match="*", content_type="application/octet-stream")
    if r.status in (200, 201):
        etag = (r.etag or "").strip('"')
        if len(etag) == 32 and all(c in "0123456789abcdef" for c in etag.lower()):
            return None if etag.lower() == hashlib.md5(body, usedforsecurity=False).hexdigest() else \
                f"etag mismatch on {key}"
        g = store.get(bucket, key)
        return None if g.status == 200 and _sha(g.body) == _sha(body) else f"{key} unreadable after upload"
    if r.status == 412:                                      # already there: it must be the same bytes
        g = store.get(bucket, key)
        if g.status != 200:
            return f"{key} exists but read back status {g.status} (retried next run)"
        return None if _sha(g.body) == _sha(body) else f"{key} exists with other bytes"
    return f"status {r.status} on {key}"


def finished(root: Path) -> list[Path]:
    """Session folders with a manifest, oldest first."""
    return sorted(p for p in root.iterdir() if p.is_dir() and p.name != RECEIPTS and (p / manifest.NAME).exists()) \
        if root.exists() else []


def recorded(folder: Path) -> bool:
    try:
        return bool(json.loads((folder / manifest.NAME).read_text()).get("recorded"))
    except (OSError, ValueError):
        return False


def receipt_path(root: Path, session: str) -> Path:
    return root / RECEIPTS / f"{session}.json"


def read_receipt(root: Path, session: str) -> dict[str, Any] | None:
    p = receipt_path(root, session)
    try:
        doc = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and doc.get("verified") else None


def receipt_ok(folder: Path, bucket: str | None = None, account: str | None = None) -> bool:
    """The session has a verified receipt for its present manifest (and, when given, this bucket and account)."""
    doc = read_receipt(folder.parent, folder.name)
    if doc is None or not (folder / manifest.NAME).exists():
        return False
    if doc.get("manifest_sha256") != manifest.sha256_file(folder / manifest.NAME):
        return False
    return (bucket is None or doc.get("bucket") == bucket) and (account is None or doc.get("account") == account)


def files_of(folder: Path) -> list[str]:
    """Every file of the session folder to upload, the manifest last."""
    names = sorted(p.name for p in folder.iterdir()
                   if p.is_file() and p.name not in SKIP and not p.name.endswith(".tmp") and p.name != manifest.NAME)
    return names + [manifest.NAME]


def upload(folder: Path, store: Store, bucket: str, deadline: float | None = None,
           account: str | None = None) -> dict[str, Any]:
    """Upload one finished session; write a receipt only when every object is in place."""
    out: dict[str, Any] = {"session": folder.name, "objects": [], "problems": []}
    try:
        problems = manifest.verify(folder)
    except (OSError, ValueError, KeyError) as e:
        problems = [f"manifest unreadable: {e.__class__.__name__}"]
    if problems:
        return {**out, "verified": False, "problems": problems}
    names = files_of(folder)
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
        out.update(manifest_sha256=manifest.sha256_file(folder / manifest.NAME), bucket=bucket, account=account,
                   uploaded_at=dt.datetime.now(dt.UTC).isoformat(timespec="seconds"))
        text = json.dumps(out, indent=2, sort_keys=True) + "\n"
        receipt_path(folder.parent, folder.name).parent.mkdir(exist_ok=True)
        manifest.atomic(receipt_path(folder.parent, folder.name), text)
        manifest.atomic(folder / RECEIPT, text)
    return out


def upload_all(root: Path, store: Store, bucket: str, deadline: float | None = None,
               account: str | None = None) -> list[dict[str, Any]]:
    """Every finished session without a receipt for this bucket. One bad session never stops the others."""
    out = []
    for f in finished(root):
        if receipt_ok(f, bucket, account):
            continue
        try:
            out.append(upload(f, store, bucket, deadline, account))
        except Exception as e:  # noqa: BLE001 (a network or disk error on one session: the next run retries)
            out.append({"session": f.name, "verified": False, "problems": [f"error {e.__class__.__name__}"]})
    return out


def remote_matches(store: Store, bucket: str, receipt: Mapping[str, Any]) -> list[str]:
    """Objects of a receipt that the bucket does not hold with the receipt's bytes; empty when all match."""
    bad = []
    for o in receipt.get("objects", []):
        try:
            g = store.get(bucket, o["key"])
            ok = g.status == 200 and _sha(g.body) == o["sha256"]
        except Exception:  # noqa: BLE001
            ok = False
        if not ok:
            bad.append(o["key"])
    return bad


def prune(root: Path, store: Store, bucket: str, keep: int = 10, account: str | None = None) -> list[str]:
    """Remove local copies of recorded sessions older than the newest `keep` recorded ones. A folder goes only when
    its receipt is for this bucket, every file in it is in the receipt, and every object reads back from the bucket
    with the receipt's sha256 now. Sessions with nothing recorded do not count toward `keep`."""
    done = [f for f in finished(root) if recorded(f)]
    older = done[:-keep] if keep > 0 else done
    older += [f for f in finished(root) if not recorded(f) and f not in older]
    gone = []
    for f in sorted(older):
        if not receipt_ok(f, bucket, account):
            continue
        doc = read_receipt(root, f.name) or {}
        listed = {o["key"] for o in doc.get("objects", [])}
        if any(key_of(f.name, n) not in listed for n in files_of(f)):
            continue                                        # a file the receipt does not cover: never deleted
        if remote_matches(store, bucket, doc):
            continue
        shutil.rmtree(f)
        gone.append(f.name)
    return gone


def check(store: Store, bucket: str, root: Path, parts: int = 12, seed: str | None = None,
          today: dt.date | None = None) -> dict[str, Any]:
    """Every archived session's manifest is read back and compared with its receipt; then `parts` objects drawn with
    a seed (the date by default, printed) from every receipt, local copy or not. It fails when anything read back
    differs, when a recorded session is still not archived three days on, and when no receipt is left although
    sessions were written here (the chain head says so): the receipts live on this disk only, and losing them must
    never read as a clean bucket."""
    receipts = sorted((root / RECEIPTS).glob("*.json")) if (root / RECEIPTS).exists() else []
    docs = [d for p in receipts if (d := read_receipt(root, p.stem)) is not None and d.get("bucket") == bucket]
    today = today or dt.date.today()
    seed = seed or today.isoformat()
    bad: list[str] = []
    for d in docs:
        man = [o for o in d.get("objects", []) if o["key"].endswith("/" + manifest.NAME)]
        bad += remote_matches(store, bucket, {"objects": man})
    pool = sorted((o for d in docs for o in d.get("objects", []) if not o["key"].endswith("/" + manifest.NAME)),
                  key=lambda o: o["key"])
    pick = random.Random(f"wt-lab-check|{seed}").sample(pool, min(parts, len(pool)))
    bad += remote_matches(store, bucket, {"objects": pick})
    unarchived = [f.name for f in finished(root) if recorded(f) and read_receipt(root, f.name) is None]
    late = [d for d in unarchived if (today - dt.date.fromisoformat(d)).days > 3]   # uploads failing for days
    lost = not docs and (root / manifest.HEAD).exists()        # sessions were written, and no receipt is left here
    return {"seed": seed, "sessions": len(docs), "manifests": len(docs), "parts": [o["key"] for o in pick],
            "bad": bad, "not_archived": unarchived, "not_archived_after_3_days": late, "receipts_lost": lost,
            "ok": not bad and not late and not lost}


@contextlib.contextmanager
def locked(root: Path) -> Iterator[None]:
    """One archive operation at a time (the recorder's own upload, a hand-run upload, prune or check)."""
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".archive.lock").open("w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def store_from_env(env: Mapping[str, str]) -> Store | None:
    """The lab's own R2 credentials, or None. Each value is taken from `env` only and passed explicitly: the R2
    client's own fallback to the backup's variables can never be reached with an empty value."""
    from wt.ops.r2 import R2
    acct, key, secret = (env.get(k) or "" for k in ("R2_ACCOUNT_ID", "R2_LAB_ACCESS_KEY_ID", "R2_LAB_SECRET_ACCESS_KEY"))
    if not (acct and key and secret):
        return None
    if key in {env.get("R2_ACCESS_KEY_ID"), env.get("R2_BACKUP_ACCESS_KEY_ID")} - {None, ""}:
        return None                                        # the backup's token under the lab's name: refused too
    r2 = R2(account_id=acct, access_key=key, secret_key=secret, timeout=120)
    return r2 if r2.configured and r2.access == key and r2.secret == secret and r2.account == acct else None


def main(argv: Sequence[str] | None = None, store: Store | None = None, env: Mapping[str, str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("what", choices=("upload", "prune", "check"))
    ap.add_argument("--deadline-min", type=float, default=20.0)
    ap.add_argument("--keep", type=int, default=10)
    ap.add_argument("--parts", type=int, default=12)
    ap.add_argument("--seed", default=None)
    args = ap.parse_args(argv)
    e = dict(os.environ) if env is None else dict(env)
    root, bucket = tape_root(e), bucket_of(e)
    s = store or store_from_env(e)
    if s is None:
        print("no lab bucket credentials (R2_ACCOUNT_ID, R2_LAB_ACCESS_KEY_ID, R2_LAB_SECRET_ACCESS_KEY)", file=sys.stderr)
        return 2
    acct = e.get("R2_ACCOUNT_ID")
    with locked(root):
        if args.what == "prune":
            print(json.dumps({"pruned": prune(root, s, bucket, args.keep, acct)}))
            return 0
        if args.what == "upload":
            res = upload_all(root, s, bucket, time.monotonic() + args.deadline_min * 60, acct)
            print(json.dumps([{k: r[k] for k in ("session", "verified", "problems")} for r in res]))
            return 0 if all(r["verified"] for r in res) else 1
        res2 = check(s, bucket, root, args.parts, args.seed)
    print(json.dumps(res2))
    return 0 if res2["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
