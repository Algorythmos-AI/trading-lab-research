#!/usr/bin/env python3
"""EXP-0048 driver: Robot B's paper execution against the backtest fill model (wt.research.b_exec_audit).

    python scripts/b_exec_audit.py EXP-0048-b-paper-execution-audit --snapshot DIR          # the registered run
    python scripts/b_exec_audit.py EXP-0048-b-paper-execution-audit --snapshot DIR --check  # reproduce it

DIR is a read-only copy of the host's records, taken by `--fetch DIR` (journal.jsonl, plans/plan_*.json,
replay/*.json). It holds PRIVATE log lines and prices, so it stays outside git; results.json records each file's
sha256. The run refuses an unregistered id, a dirty tree, a broken hash chain, an existing results.json and any
mismatch with the registered published aggregate. It prints counts only.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.analytics import b_replay  # noqa: E402
from wt.core import ledger  # noqa: E402
from wt.research import b_exec_audit as bx  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EXPS = ROOT / "research/experiments"
HOST = ["gcloud", "--configuration=algo-trading", "compute", "ssh", "trading-lab-host", "--zone", "us-east1-b",
        "--tunnel-through-iap", "--quiet", "--command"]
REMOTE = ("sudo -u wt sh -c 'cd /home/wt/trading && tar -cf - data/live/journal.jsonl data/live/plan_*.json "
          "var/forward/replay'")


class ReconcileError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(dest: Path) -> int:
    """Copy the host's B records into `dest` (read-only on the host: one tar of three paths)."""
    import io
    import tarfile
    if dest.exists() and any(dest.iterdir()):
        print(f"{dest} is not empty; a snapshot is taken once", file=sys.stderr)
        return 1
    raw = subprocess.run([*HOST, REMOTE], check=True, capture_output=True).stdout
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "plans").mkdir()
    (dest / "replay").mkdir()
    with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            name = Path(m.name).name
            sub = "plans" if name.startswith("plan_") else "replay" if "/replay/" in m.name else ""
            data = tf.extractfile(m)
            if data is not None:
                (dest / sub / name).write_bytes(data.read())
    print(f"snapshot: {sum(1 for _ in dest.rglob('*') if _.is_file())} files in {dest}")
    return 0


def load(snapshot: Path, cfg: dict[str, Any]) -> dict[str, Any]:
    journal = snapshot / "journal.jsonl"
    breaks = ledger.verify_chain(journal)
    if breaks:
        raise ReconcileError(f"journal hash chain broken: {breaks[:3]}")
    last_day = str(cfg["cutoff"]["last_session"])
    rows = [json.loads(x) for x in journal.read_text().splitlines() if x.strip()]
    sess = bx.sessions(rows, last_day)
    used = sum(len(s.rows) for s in sess)
    plans: dict[str, dict[str, Any]] = {}
    for f in sorted((snapshot / "plans").glob("plan_*.json")):
        p = json.loads(f.read_text())
        if str(p.get("date")) <= last_day:
            plans[str(p["date"])] = p
    try:
        fs = bx.fills(sess, plans)
    except bx.SnapshotError as e:
        raise ReconcileError(str(e)) from e
    miss = bx.reconcile(fs, sess, cfg["reconcile"])
    if miss:
        raise ReconcileError("; ".join(miss))
    recs = [r for r in b_replay.load_records(snapshot / "replay") if str(r.get("session")) <= last_day]
    armed_days = {s.day for s in sess if s.rows and s.rows[0].get("event") == "armed"}
    out = bx.aggregate(sess, fs, seed=int(cfg["seed"]), n_boot=int(cfg["n_boot"]))
    out["replay"] = {"records": len(recs),
                     "replay_vs_journal": b_replay.tally(recs, "replay_vs_journal"),
                     "forward_vs_replay": b_replay.tally(recs, "forward_vs_replay"),
                     "agreement_over_armed_sessions": b_replay.agreement(recs, armed_days)}
    out["inputs"] = {"journal": {"lines_total": len(rows), "lines_used": used, "chain_intact": True,
                                 "sha256": sha256(journal),
                                 "head_at_cutoff": ledger.head_at(journal, used) if used else None},
                     "plans": {f.name: sha256(f) for f in sorted((snapshot / "plans").glob("*.json"))},
                     "replay": {f.name: sha256(f) for f in sorted((snapshot / "replay").glob("*.json"))}}
    out["cutoff"] = cfg["cutoff"]
    out["reconciled"] = cfg["reconcile"]
    return out


def rounded(obj: Any, digits: int = 9) -> Any:
    if isinstance(obj, float):
        return obj if not math.isfinite(obj) or obj == 0 else float(f"{obj:.{digits}g}")
    if isinstance(obj, dict):
        return {str(k): rounded(v, digits) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [rounded(v, digits) for v in obj]
    return obj


def dump(obj: Any) -> str:
    return json.dumps(rounded(obj), indent=1, sort_keys=True, default=str) + "\n"


def main(argv: list[str]) -> int:
    if "--fetch" in argv:
        return fetch(Path(argv[argv.index("--fetch") + 1]).expanduser())
    if not argv or "--snapshot" not in argv:
        print(__doc__, file=sys.stderr)
        return 1
    exp = EXPS / argv[0]
    if exp.name.startswith("--") or not (exp / "config.yaml").exists():
        print(f"{argv[0]}: not a registered experiment (no config.yaml)", file=sys.stderr)
        return 1
    cfg = yaml.safe_load((exp / "config.yaml").read_text())
    snapshot = Path(argv[argv.index("--snapshot") + 1]).expanduser()
    check = "--check" in argv
    target = exp / "results.json"
    if not check:
        if target.exists():
            print(f"{target.relative_to(ROOT)} exists; experiments are append-only", file=sys.stderr)
            return 1
        from wt.research.manifest import assert_clean_for_preregistered_run
        assert_clean_for_preregistered_run()
    try:
        out = dump(load(snapshot, cfg))
    except ReconcileError as e:
        print(f"RECONCILE FAILED: {e}", file=sys.stderr)
        return 2
    if check:
        if not target.exists() or target.read_text() != out:
            print("results.json is missing or differs from a fresh run", file=sys.stderr)
            return 1
        print("results.json matches a fresh run")
        return 0
    target.write_text(out)
    from wt.research.manifest import write_manifest
    write_manifest(exp, {"exp": exp.name, "argv": argv}, [exp / "config.yaml"], name="manifest.json")
    print(f"wrote {target.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
