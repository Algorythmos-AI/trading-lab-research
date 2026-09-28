"""Resumable historical watchlist builder: python scripts/build_watchlists.py 2019-01-02 2026-09-25
Writes watchlist/YYYY-MM-DD.json (Top-10 + drop-reason counts); skips days already done."""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import ROOT, load_yaml  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import load_daily  # noqa: E402
from wt.scanner.features import PMCache, build_candidates  # noqa: E402
from wt.scanner.ranking import rank  # noqa: E402


def main(start: str, end: str) -> None:
    a, daily, cache, so, cfg = AlpacaREST(), load_daily(), PMCache(), SharesOutstanding(), load_yaml("ranking.yaml")
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    cal = a.calendar((s - dt.timedelta(days=60)).isoformat(), e.isoformat())
    sessions = list(cal.date)
    early_close = {r.date: r.close for r in cal.itertuples() if r.close != "16:00"}
    wl = ROOT / "watchlist"
    wl.mkdir(exist_ok=True)
    todo = [d for d in sessions if s <= d <= e and not (wl / f"{d}.json").exists()]
    print(f"{len(todo)} sessions to build", flush=True)
    t0 = time.time()
    for n, d in enumerate(todo, 1):
        try:
            cands = build_candidates(d, daily, sessions, a, cache, so, with_quotes=True)
        except Exception as ex:  # noqa: BLE001 — log and continue; day can be retried later
            print(f"{d} FAILED {ex!r}", flush=True)
            continue
        top, dropped = rank(cands, cfg)
        for t in top:
            t["pm_high"] = float(cache.get([t["symbol"]], [d]).pm_high.iloc[0])
        out = {"date": str(d), "early_close": early_close.get(d), "n_candidates": len(cands), "top": top,
               "dropped_reasons": pd.Series([r for x in dropped for r in x["reasons"]]).value_counts().to_dict()}
        (wl / f"{d}.json").write_text(json.dumps(out, default=str))
        if n % 10 == 0:
            cache.save()
            rate = (time.time() - t0) / n
            print(f"{n}/{len(todo)} done ({d}); {rate:.0f}s/day, ETA {(len(todo) - n) * rate / 3600:.1f}h", flush=True)
    cache.save()
    print("complete", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
