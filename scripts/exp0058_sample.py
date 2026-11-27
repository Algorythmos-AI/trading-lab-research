"""EXP-0058 step 1: build the frame and draw the sample, once (DEC-0082 points 2, 3 and 8).

Refuses unless DEC-0082's status is exactly ACCEPTED and `config/catalysts_spec.yaml` is v3 by its sha256, and refuses
a second draw. Reads the 43 forward pools (`data/candidates/DATE.parquet`), the session calendar cached by the EDGAR
annotator (`data/edgar/sessions.json`) and the private news archive, every day of which must be complete.

Writes, in the private archive clone (`experiments/EXP-0058/`; headline text lives only here):
    sample_blind.csv       item_id, session, symbol, headline         what the agent labeller sees
    sample_key.csv         item_id, archive_id, v3_category          opened only by the scorer
    owner_blind.csv        the 30 owner-blind items, with an empty owner_label column
    agent_labels.csv       all 100 items' ids, with empty agent_label and note columns
and, in the public experiment folder, `sample_manifest.json` (ids, counts and sha256 sums only). Prints three counts
only (no category tally): the agent labeller sees this output before labelling.
Commit the private folder to the private repository with `--publish`.

Usage: PYTHONPATH=src .venv/bin/python scripts/exp0058_sample.py [--publish]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import sys
from collections import Counter
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import CONFIG_DIR, DATA_DIR, ROOT  # noqa: E402
from wt.data import news_archive as na  # noqa: E402
from wt.research import exp0058 as x  # noqa: E402

DECISION = ROOT / "research" / "decisions" / "DEC-0082-v3-on-fiscal-ai.md"
PUBLIC = ROOT / "research" / "experiments" / "EXP-0058-v3-on-fiscal"
PRIVATE_IN_REPO = "experiments/EXP-0058"
PRIVATE = na.CLONE / PRIVATE_IN_REPO
CLASSIFIER = CONFIG_DIR / "catalysts_spec.yaml"      # the file classify_spec loads


def _csv(header: list[str], rows: list[list[object]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


def _write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=DATA_DIR)
    ap.add_argument("--archive", type=Path, default=na.DEFAULT_ROOT)
    ap.add_argument("--private", type=Path, default=PRIVATE)
    ap.add_argument("--public", type=Path, default=PUBLIC)
    ap.add_argument("--decision", type=Path, default=DECISION)
    ap.add_argument("--publish", action="store_true", help="commit the private folder to the private repository")
    a = ap.parse_args(argv)

    if not x.accepted(a.decision.read_text()):
        print("EXP-0058: DEC-0082 is not ACCEPTED; nothing is drawn")
        return 2
    try:
        x.check_classifier(CLASSIFIER)
    except x.Refused as e:
        print(f"EXP-0058: {e}")
        return 2
    done = [p.name for p in (a.private / "sample_blind.csv", a.public / "sample_manifest.json") if p.exists()]
    if done:
        print(f"EXP-0058: the sample was drawn once ({', '.join(done)} exist); a new draw needs a new EXP id")
        return 2

    cal = [dt.date.fromisoformat(s) for s in json.loads((a.data / "edgar" / "sessions.json").read_text())]
    prev = x.previous(cal)
    sessions = [d for d in sorted(set(cal)) if x.FRAME[0] <= d <= x.FRAME[1]]
    if len(sessions) != x.SESSIONS_IN_FRAME:
        print(f"EXP-0058: the calendar gives {len(sessions)} sessions in the frame, not {x.SESSIONS_IN_FRAME}")
        return 2
    missing = [str(d) for d in sessions if not (a.data / "candidates" / f"{d}.parquet").exists()]
    if missing:
        print(f"EXP-0058: {len(missing)} pools missing (first {missing[0]}); copy them from the host first")
        return 2
    first = prev[sessions[0]]
    gaps = na.missing(a.archive, first, sessions[-1])
    if gaps:
        print(f"EXP-0058: {len(gaps)} archive days not complete (first {gaps[0]}); run the archive catch-up first")
        return 2

    pools = {d: pd.read_parquet(a.data / "candidates" / f"{d}.parquet", columns=["symbol"]).symbol.tolist()
             for d in sessions}
    items = na.load(a.archive, first, sessions[-1])
    rows = x.frame(pools, prev, items)
    try:
        sample, blind = x.draw(rows)
    except x.Refused as e:
        print(f"EXP-0058: {e}")
        return 2

    by_id = sorted(sample, key=lambda r: r["item_id"])
    files = {
        "sample_blind.csv": _csv(["item_id", "session", "symbol", "headline"],
                                 [[r["item_id"], r["session"], r["symbol"], r["headline"]] for r in by_id]),
        "sample_key.csv": _csv(["item_id", "archive_id", "v3_category"],
                               [[r["item_id"], r["id"], r["v3"]] for r in by_id]),
        "owner_blind.csv": _csv(["item_id", "session", "symbol", "headline", "owner_label"],
                                [[r["item_id"], r["session"], r["symbol"], r["headline"], ""]
                                 for r in by_id if r["item_id"] in blind]),
        "agent_labels.csv": _csv(["item_id", "agent_label", "note"], [[r["item_id"], "", ""] for r in by_id]),
    }
    manifest = {
        "experiment": "EXP-0058", "decision": "DEC-0082", "classifier_sha256": x.CLASSIFIER_SHA256,
        "seed": x.SEED, "frame": [str(x.FRAME[0]), str(x.FRAME[1])], "sessions": len(sessions),
        "pool_name_days": sum(len(v) for v in pools.values()), "archive_items_read": len(items),
        "frame_n": len(rows), "frame_by_category": dict(sorted(Counter(r["v3"] for r in rows).items())),
        "frame_edited_after_cut": sum(r["edited_after_cut"] for r in rows),
        "sample_n": len(sample), "sample_by_category": dict(sorted(Counter(r["v3"] for r in sample).items())),
        "sample_edited_after_cut": sum(r["edited_after_cut"] for r in sample),
        "items": [{"item_id": r["item_id"], "archive_id": r["id"], "session": str(r["session"])} for r in by_id],
        "owner_blind_ids": blind,
        "private_folder": f"{na.ARCHIVE_REPO}/{PRIVATE_IN_REPO}",
        "private_sha256": {f: hashlib.sha256(b).hexdigest() for f, b in files.items()},
    }
    x.check_public(manifest)                    # before anything is written
    a.private.mkdir(parents=True, exist_ok=True)
    for f, data in files.items():
        _write(a.private / f, data)
    a.public.mkdir(parents=True, exist_ok=True)
    _write(a.public / "sample_manifest.json", (json.dumps(manifest, indent=1, default=str) + "\n").encode())
    # Counts only, and no category tally: the agent labeller reads this output before labelling.
    print(json.dumps({k: manifest[k] for k in ("sessions", "frame_n", "sample_n")}))
    if a.publish:
        na.publish(na.CLONE, "EXP-0058: the sample (DEC-0082)", folder=PRIVATE_IN_REPO)
        print("EXP-0058: private folder committed and pushed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
