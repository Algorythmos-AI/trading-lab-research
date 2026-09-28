"""EXP-0003: scanner hard-filter variants vs eventual-winner recall on the EXP-0002 sessions.
Scanner-recall tuning only (not strategy P&L); every variant is logged."""
from __future__ import annotations

import copy
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
from wt.scanner.ranking import rank  # noqa: E402

EXP = ROOT / "research/experiments/EXP-0003-scanner-filter-variants"
base = load_yaml("ranking.yaml")


def variant(**kw):
    c = copy.deepcopy(base)
    for k, v in kw.items():
        c["hard_filters"][k] = v
    return c


VARIANTS = {
    "V0_baseline": base,
    "V1_liq250k": variant(pm_dollar_vol_min=250_000),
    "V2_no_float_cap": variant(float_max=10**12),
    "V3_liq250k_no_float_cap": variant(pm_dollar_vol_min=250_000, float_max=10**12),
    "V4_V3_price_1_5_to_40": variant(pm_dollar_vol_min=250_000, float_max=10**12, price_min=1.5, price_max=40),
}
relaxed = variant(pm_dollar_vol_min=0, float_max=10**12, price_min=1.0, price_max=50)

days = json.loads((ROOT / "research/experiments/EXP-0002-ranking-baseline/results.json").read_text())["days"]
a, daily, cache, so = AlpacaREST(), load_daily(), PMCache(), SharesOutstanding()
last = max(daily.date)
cal = a.calendar((last - dt.timedelta(days=200)).isoformat(), last.isoformat())
sessions = [d for d in cal.date if d <= last]
res = {k: {"hits": 0, "days_hit": 0, "avg_top": 0.0} for k in VARIANTS}
for day in days:
    d = dt.date.fromisoformat(day["date"])
    cands = build_candidates(d, daily, sessions, a, cache, so, with_quotes=True, quote_cfg=relaxed)
    for k, cfg in VARIANTS.items():
        top, _ = rank(cands, cfg)
        h = len({t["symbol"] for t in top} & set(day["winners"]))
        res[k]["hits"] += h
        res[k]["days_hit"] += h > 0
        res[k]["avg_top"] += len(top) / len(days)
cache.save()
EXP.mkdir(parents=True, exist_ok=True)
out = {"sessions": len(days), "winners_total": 5 * len(days), "naive_top10_hits": sum(d["hit_naive"] for d in days),
       "variants": res, "configs": {k: v["hard_filters"] for k, v in VARIANTS.items()}}
(EXP / "results.json").write_text(json.dumps(out, indent=1))
print(json.dumps({k: v for k, v in out.items() if k != "configs"}, indent=1))
