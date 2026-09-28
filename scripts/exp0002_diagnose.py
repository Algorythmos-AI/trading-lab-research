"""Why were the eventual winners dropped? Rebuild candidates from cache (cheap) and report the hard-filter
reasons and feature values for each day's eventual top-5 gainers. Also writes watchlist/*.json per day."""
from __future__ import annotations

import collections
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import ROOT, load_yaml  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import load_daily  # noqa: E402
from wt.scanner.features import PMCache, build_candidates  # noqa: E402
from wt.scanner.ranking import hard_filter, rank  # noqa: E402

res = json.loads((ROOT / "research/experiments/EXP-0002-ranking-baseline/results.json").read_text())
a, daily, cache, so, cfg = AlpacaREST(), load_daily(), PMCache(), SharesOutstanding(), load_yaml("ranking.yaml")
last = max(daily.date)
cal = a.calendar((last - dt.timedelta(days=200)).isoformat(), last.isoformat())
sessions = [d for d in cal.date if d <= last]
reasons, not_candidate, feats = collections.Counter(), 0, []
for day in res["days"]:
    d = dt.date.fromisoformat(day["date"])
    cands = build_candidates(d, daily, sessions, a, cache, so, with_quotes=True)
    top, dropped = rank(cands, cfg)
    (ROOT / "watchlist" / f"{d}.json").write_text(json.dumps({"date": str(d), "top": top}, default=str))
    by = {c.symbol: c for c in cands}
    for w in day["winners"]:
        if w not in by:
            not_candidate += 1
            continue
        why = hard_filter(by[w], cfg)
        for r in why:
            reasons[r] += 1
        c = by[w]
        feats.append({"date": day["date"], "sym": w, "why": why, "price": round(c.price, 2), "gap": round(c.gap_pct, 1),
                      "rvol": round(c.rvol_tod, 1), "pm_$vol_M": round(c.pm_dollar_vol / 1e6, 2),
                      "float_M": round((c.float_shares or 0) / 1e6, 1), "cat": c.catalyst_type})
cache.save()
out = {"winners_total": 5 * len(res["days"]), "not_in_prefilter_or_no_pm_bars": not_candidate,
       "drop_reasons": dict(reasons.most_common()), "winner_features": feats}
(ROOT / "research/experiments/EXP-0002-ranking-baseline/diagnosis.json").write_text(json.dumps(out, indent=1))
print(json.dumps({k: v for k, v in out.items() if k != "winner_features"}, indent=1))
for f in feats[:40]:
    print(f)
