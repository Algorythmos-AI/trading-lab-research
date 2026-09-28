"""HYP-0009 (EXP-0012): frozen B rules on IWM and DIA, dev span, 1c slippage on the traded ETF itself."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.stats import summarize  # noqa: E402
from wt.core.config import ROOT  # noqa: E402
from wt.data.etf_minutes import load  # noqa: E402
from wt.signals import setups  # noqa: E402

DEV_END = pd.Timestamp("2025-09-25").date()
OUT = ROOT / "research/experiments/EXP-0012-r2-B-iwm-dia"
res = {}
for sym in ("IWM", "DIA"):
    df = load(sym)
    df = df[df.date <= DEV_END]
    by_day = {d: g.reset_index(drop=True) for d, g in df.groupby("date")}
    days = sorted(by_day)
    absmove = pd.Series({d: float(np.mean(np.abs(g.c.iloc[29::30].to_numpy() / g.o.iloc[0] - 1))) for d, g in by_day.items() if len(g) > 60})
    sigma = absmove.rolling(14).mean().shift(1)
    closes = {d: g.c.iloc[-1] for d, g in by_day.items()}
    cst = Costs(slippage_per_share=0.01)
    tr_list = []
    for i, d in enumerate(days):
        if i < 20:
            continue
        b, sg = by_day[d], sigma.get(d)
        if len(b) < 200 or sg is None or not np.isfinite(sg):
            continue
        sig = setups.b_intraday_momentum(b, sigma=float(sg), prev_close=float(closes[days[i - 1]]))
        if not sig:
            continue
        tr = simulate(b, sig, REGISTRY["M3"](), cst, sym, str(d), 6, 1e9, 1e9, flatten_idx=len(b) - 11)
        if tr:
            tr_list.append({"date": str(d), "R": tr.r_multiple(cst)})
    r = np.array([t["R"] for t in tr_list])
    s = summarize(r)
    yrs = pd.DataFrame(tr_list).assign(y=lambda x: x.date.str[:4]).groupby("y").R.sum()
    s["years_profitable"] = f"{int((yrs > 0).sum())}/{len(yrs)}"
    res[sym] = {"summary": s, "trades": tr_list}
    print(sym, {k: s[k] for k in ("n", "expectancy_R", "win_rate", "profit_factor", "ci95_expectancy", "years_profitable")})
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "results.json").write_text(json.dumps({"n_trials": 2, "results": res}, indent=1, default=str))
