"""Historical pre-market scan: python scripts/scan.py 2026-09-25 [--no-quotes]"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import ROOT  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import load_daily  # noqa: E402
from wt.scanner.features import PMCache, build_candidates  # noqa: E402
from wt.scanner.ranking import rank  # noqa: E402


def main(day: str, with_quotes: bool = True) -> dict:
    d = dt.date.fromisoformat(day)
    a = AlpacaREST()
    daily = load_daily()
    cal = a.calendar((d - dt.timedelta(days=60)).isoformat(), d.isoformat())
    sessions = list(cal.date)
    cache = PMCache()
    cands = build_candidates(d, daily, sessions, a, cache, SharesOutstanding(), with_quotes=with_quotes)
    cache.save()
    top, dropped = rank(cands)
    out = {"date": day, "scan_time_et": "09:25", "n_candidates": len(cands), "top": top,
           "dropped_reasons": pd.Series([r for x in dropped for r in x["reasons"]]).value_counts().to_dict()}
    wl = ROOT / "watchlist"
    wl.mkdir(exist_ok=True)
    (wl / f"{day}.json").write_text(json.dumps(out, indent=1, default=str))
    return out


if __name__ == "__main__":
    res = main(sys.argv[1], "--no-quotes" not in sys.argv)
    print(f"{res['date']}: {res['n_candidates']} candidates; drops {res['dropped_reasons']}")
    for t in res["top"]:
        f = t["features"]
        print(f"  #{t['rank']:<2} {t['symbol']:<6} score {t['score']:5.1f}  ${f['price']:.2f} gap {f['gap_pct']:.0f}% "
              f"rvol {f['rvol_tod']:.1f}x float {(f['float_shares'] or 0)/1e6:.1f}M cat {f['catalyst_type']}")
