"""EXP-0011: ONE-TIME holdout evaluation of the frozen B config (QQQ signals, QQQM costs, M3)."""
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

OUT = ROOT / "research/experiments/EXP-0011-holdout-B-qqqm"
if (OUT / "results.json").exists():
    raise SystemExit("holdout already run — it may be run exactly once (DEC-0005/DEC-0007)")
H0, H1 = pd.Timestamp("2025-09-26").date(), pd.Timestamp("2026-09-25").date()
df = load("QQQ")
by_day = {d: g.reset_index(drop=True) for d, g in df.groupby("date")}
days = sorted(by_day)
absmove = pd.Series({d: float(np.mean(np.abs(g.c.iloc[29::30].to_numpy() / g.o.iloc[0] - 1))) for d, g in by_day.items() if len(g) > 60})
sigma = absmove.rolling(14).mean().shift(1)
closes = {d: g.c.iloc[-1] for d, g in by_day.items()}
cst = Costs(slippage_per_share=0.022)
trades = []
for i, d in enumerate(days):
    if not (H0 <= d <= H1) or i < 20:
        continue
    b, sg = by_day[d], sigma.get(d)
    if len(b) < 200 or sg is None or not np.isfinite(sg):
        continue
    sig = setups.b_intraday_momentum(b, sigma=float(sg), prev_close=float(closes[days[i - 1]]))
    if not sig:
        continue
    tr = simulate(b, sig, REGISTRY["M3"](), cst, "QQQ", str(d), 6, 1e9, 1e9, flatten_idx=len(b) - 11)
    if tr:
        trades.append({"date": str(d), "R": tr.r_multiple(cst), "exit": tr.exits[-1][3], "mfe_R": tr.mfe})
r = np.array([t["R"] for t in trades])
s = summarize(r)
m = pd.DataFrame(trades).assign(m=lambda x: pd.to_datetime(x.date).dt.to_period("M")).groupby("m").R.agg(["count", "sum"])
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "results.json").write_text(json.dumps({"summary": s, "monthly": {str(k): v for k, v in m.to_dict("index").items()},
                                              "trades": trades}, indent=1, default=str))
print(json.dumps(s, indent=1))
print(m)
