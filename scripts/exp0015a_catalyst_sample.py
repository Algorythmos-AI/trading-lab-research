"""EXP-0015a step 1: draw the catalyst-accuracy sample (dev span only, D17).

Headlines come from Alpaca News for past 09:25 watchlist names (prior close 16:00 -> 09:25 window). The sample is
stratified by the v2 classifier's category, so rare categories (buyouts, rumours) are represented. Blindness:
    sample_blind.csv  item_id, date, symbol, headline      (shuffled; what labellers see)
    sample_key.csv    item_id, classifier_category         (opened only after all labels are in)
    owner_blind_ids.txt  20 random item_ids the owner labels first, without seeing any other label
Only aggregate counts are printed.
Usage: PYTHONPATH=src .venv/bin/python scripts/exp0015a_catalyst_sample.py [--days 300] [--seed 15]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.clock import et, to_utc_iso  # noqa: E402
from wt.core.config import ROOT  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.scanner.catalyst import classify_spec  # noqa: E402

DEV = (dt.date(2019, 1, 2), dt.date(2025, 9, 25))
OUT = ROOT / "research" / "experiments" / "EXP-0015a-catalyst-accuracy"
CATS = ["fda_approval", "clinical_study_results", "earnings_release", "price_target_upgrade", "breaking_news",
        "buyout_offer", "unconfirmed_rumor", "offering_dilution", "reverse_split", "hype_only", "none"]


def main(days: int, seed: int, n: int = 100, per_cat: int = 9, owner_blind: int = 20) -> None:
    rng = random.Random(seed)
    wls = sorted(p for p in (ROOT / "watchlist").glob("*.json") if DEV[0] <= dt.date.fromisoformat(p.stem) <= DEV[1])
    chosen = sorted(rng.sample(wls, min(days, len(wls))))
    a = AlpacaREST(per_minute=120)
    cal = a.calendar(DEV[0].isoformat(), DEV[1].isoformat())
    sessions = sorted(cal.date)
    pool: dict[str, dict] = {}
    for p in chosen:
        d = dt.date.fromisoformat(p.stem)
        syms = [t["symbol"] for t in json.loads(p.read_text())["top"]]
        i = sessions.index(d) if d in sessions else None
        if not syms or not i:
            continue
        prev = sessions[i - 1]
        for item in a.news(syms, to_utc_iso(et(prev, "16:00")), to_utc_iso(et(d, "09:25"))):
            hl = (item.get("headline") or "").strip()
            key = hl.lower()
            if not hl or key in pool:
                continue
            sym = next((s for s in item.get("symbols", []) if s in syms), None)
            if sym:
                pool[key] = {"date": str(d), "symbol": sym, "headline": hl, "cat": classify_spec(hl)}
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in pool.values():
        by_cat[r["cat"]].append(r)
    picked: list[dict] = []
    for c in CATS:                                   # stratify: up to per_cat from every category
        items = sorted(by_cat.get(c, []), key=lambda r: (r["date"], r["symbol"], r["headline"]))
        picked += rng.sample(items, min(per_cat, len(items)))
    rest = [r for r in pool.values() if r not in picked]
    picked += rng.sample(sorted(rest, key=lambda r: (r["date"], r["symbol"], r["headline"])), max(0, n - len(picked)))
    rng.shuffle(picked)
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "sample_blind.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["item_id", "date", "symbol", "headline"])
        for i, r in enumerate(picked, 1):
            w.writerow([f"H{i:03d}", r["date"], r["symbol"], r["headline"]])
    with open(OUT / "sample_key.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["item_id", "classifier_category"])
        for i, r in enumerate(picked, 1):
            w.writerow([f"H{i:03d}", r["cat"]])
    blind_ids = sorted(rng.sample([f"H{i:03d}" for i in range(1, len(picked) + 1)], owner_blind))
    (OUT / "owner_blind_ids.txt").write_text("\n".join(blind_ids) + "\n")
    manifest = {"seed": seed, "days_sampled": len(chosen), "dev_span": [str(DEV[0]), str(DEV[1])],
                "pool_headlines": len(pool), "pool_by_category": dict(Counter(r["cat"] for r in pool.values())),
                "sample_size": len(picked), "sample_by_category": dict(Counter(r["cat"] for r in picked)),
                "classifier": "config/catalysts_spec.yaml v2", "owner_blind_n": owner_blind}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(json.dumps({k: manifest[k] for k in ("days_sampled", "pool_headlines", "sample_size")}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=300)
    ap.add_argument("--seed", type=int, default=15)
    args = ap.parse_args()
    main(args.days, args.seed)
