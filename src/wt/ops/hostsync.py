"""Move a host's runtime state to another host, verified (cutover plan v2: the Mac seeds the VM, and back on rollback).

    python -m wt.ops.hostsync list --root DIR                 # the files the seed carries, one per line (for tar -T)
    python -m wt.ops.hostsync manifest --root DIR --out FILE  # sha256 and size of each of them, JSON
    python -m wt.ops.hostsync verify --dir SEED               # SEED holds exactly its manifest's bytes; chains intact
    python -m wt.ops.hostsync apply --from SEED [--root R]    # verify, archive R's copy, swap SEED in under every lock

What moves is the evidence and the state the nightly jobs read (UNITS). Never moved: secrets and the venv, the KILL
file (each host decides its own), git-tracked files, caches regenerated on each host (the dashboard documents), records
that name the other host (deploy records and their rollback tags), locks, spooled pages (they would page again, late),
the evidence-broken flag, host-local rate-limit state and research-only market data. Each unit is a file or a
directory; `apply` archives the target's copy of every unit to ARCHIVE/<stamp>/ and renames the seed's copy into place,
holding every job lock, the runner's lock and the deploy lock, so no job can see half of each.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fnmatch
import hashlib
import json
import os
import shutil
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from wt.core import ledger
from wt.core.config import ROOT
from wt.ops import locks
from wt.ops.schedule import TRADING_JOBS

MANIFEST = ".hostsync-manifest.json"
DEPLOY_LOCK = getattr(locks, "DEPLOY_LOCK", "deploy")
# Files or directories, relative to the checkout. A unit missing on the source is simply not carried.
UNITS = (
    "var/forward/forward_trades.jsonl",          # the forward ledger (hash-chained evidence)
    "var/watchlist",
    "var/heartbeats",                            # the 14-day job SLA
    "var/routine",
    "var/alerts/state.json",
    "var/alerts/history.jsonl",
    "var/scorecards",
    "var/audit",
    "data/live",                                 # the paper journal (hash-chained), the virtual account, plans
    "data/daily",
    "data/edgar",
    "data/pm",
    "data/pm_bars",
    "data/candidates",
    "data/minute",
    "data/signal_spreads.json",
    "data/intraday_volume_curve_2019.npy",       # without it the jobs try to rebuild it from research data
)
EXCLUDE = ("*.lock", "*.tmp", ".*.tmp", "*.corrupt", "*.corrupt-*", ".DS_Store", "__pycache__")
CHAINS = ("var/forward/forward_trades.jsonl", "data/live/journal.jsonl")


def _excluded(rel: str) -> bool:
    return any(fnmatch.fnmatch(part, pat) for part in rel.split("/") for pat in EXCLUDE)


def files(root: Path) -> list[str]:
    """Every file the seed carries, relative to `root`, sorted."""
    out: list[str] = []
    for unit in UNITS:
        p = root / unit
        if p.is_file() and not _excluded(unit):
            out.append(unit)
        elif p.is_dir():
            for f in p.rglob("*"):
                rel = f.relative_to(root).as_posix()
                if f.is_file() and not f.is_symlink() and not _excluded(rel):
                    out.append(rel)
    return sorted(out)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def manifest(root: Path) -> dict[str, Any]:
    entries = {rel: {"size": (root / rel).stat().st_size, "sha256": sha256(root / rel)} for rel in files(root)}
    body = json.dumps(entries, sort_keys=True).encode()
    return {"created": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "host": os.environ.get("WT_HOST_ID") or os.uname().nodename.split(".")[0],
            "files": entries, "digest": hashlib.sha256(body).hexdigest()}


def verify(seed: Path) -> list[str]:
    """Problems with a received seed: its manifest missing, a file missing, extra, or with other bytes, or a hash
    chain broken. Empty when the seed is exactly what the source hashed."""
    mf = seed / MANIFEST
    if not mf.exists():
        return [f"no {MANIFEST} in {seed}"]
    want: dict[str, dict[str, Any]] = json.loads(mf.read_text())["files"]
    have = set(files(seed))
    out = [f"missing: {rel}" for rel in sorted(set(want) - have)]
    out += [f"not in the manifest: {rel}" for rel in sorted(have - set(want))]
    for rel in sorted(set(want) & have):
        p = seed / rel
        if p.stat().st_size != want[rel]["size"] or sha256(p) != want[rel]["sha256"]:
            out.append(f"different bytes: {rel}")
    for rel in CHAINS:
        out += [f"chain {rel}: {x}" for x in ledger.verify_chain(seed / rel)[:5]]
    return out


@contextlib.contextmanager
def all_locks(lock_root: Path | None = None) -> Iterator[list[str]]:
    """Hold every job lock, the runner's lock, the publisher's and the deploy lock. Yields the busy ones (then none
    is held and the caller must stop)."""
    names = [*TRADING_JOBS, locks.RUNNER_LOCK, "publish", DEPLOY_LOCK]
    with contextlib.ExitStack() as stack:
        busy = [n for n in names if not stack.enter_context(locks.job_lock(n, lock_root))]
        yield busy


def apply(seed: Path, root: Path = ROOT, archive: Path | None = None, lock_root: Path | None = None,
          now: dt.datetime | None = None) -> tuple[bool, list[str]]:
    """Verify the seed, then swap it in unit by unit, archiving the target's copy. (ok, messages)."""
    problems = verify(seed)
    if problems:
        return False, ["refused: the seed does not verify", *problems[:20]]
    stamp = (now or dt.datetime.now(dt.UTC)).strftime("%Y%m%dT%H%M%SZ")
    archive = (archive or root.parent / "archive") / f"hostsync-{stamp}"
    with all_locks(lock_root) as busy:
        if busy:
            return False, [f"refused: busy: {', '.join(busy)} (stop the jobs; nothing was changed)"]
        msgs: list[str] = []
        for unit in UNITS:
            src, dst = seed / unit, root / unit
            if not src.exists():
                continue
            if dst.exists():
                (archive / unit).parent.mkdir(parents=True, exist_ok=True)
                os.replace(dst, archive / unit)
                msgs.append(f"archived {unit}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
            msgs.append(f"placed {unit}")
        record = {"applied": stamp, "from": json.loads((seed / MANIFEST).read_text())["host"],
                  "digest": json.loads((seed / MANIFEST).read_text())["digest"], "archive": str(archive),
                  "chains": {rel: ledger.head(root / rel) for rel in CHAINS}}
        rec = root / "var" / "hostsync" / f"{stamp}.json"
        rec.parent.mkdir(parents=True, exist_ok=True)
        rec.write_text(json.dumps(record, indent=1, default=str))
        after = [f"chain {rel}: {x}" for rel in CHAINS for x in ledger.verify_chain(root / rel)[:5]]
        if after:
            return False, [*msgs, "CHAINS BROKEN AFTER THE SWAP (restore from the archive):", *after]
    shutil.rmtree(seed, ignore_errors=True)
    return True, [*msgs, f"record {rec}", f"archive {archive}"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.hostsync")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("list", "manifest"):
        p = sub.add_parser(name)
        p.add_argument("--root", type=Path, default=ROOT)
        if name == "manifest":
            p.add_argument("--out", type=Path, required=True)
    v = sub.add_parser("verify")
    v.add_argument("--dir", type=Path, required=True)
    a = sub.add_parser("apply")
    a.add_argument("--from", dest="seed", type=Path, required=True)
    a.add_argument("--root", type=Path, default=ROOT)
    args = ap.parse_args(argv)
    if args.cmd == "list":
        print("\n".join(files(args.root)))
        return 0
    if args.cmd == "manifest":
        m = manifest(args.root)
        args.out.write_text(json.dumps(m, indent=1, sort_keys=True))
        total = sum(e["size"] for e in m["files"].values())
        print(f"{len(m['files'])} files, {total / 1e6:.1f} MB, digest {m['digest'][:12]}", file=sys.stderr)
        return 0
    if args.cmd == "verify":
        problems = verify(args.dir)
        print("\n".join(problems) if problems else "seed verified: every file matches its manifest; chains intact")
        return 1 if problems else 0
    ok, msgs = apply(args.seed, args.root)
    print("\n".join(msgs))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
