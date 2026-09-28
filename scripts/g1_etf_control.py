"""Random-entry controls for the ETF track: same symbols, days, management (M3/M1), costs; entry at a random
bar in the same window with an ATR-based stop. 200 seeds per family -> distribution of expectancy."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.runner import save_experiment  # noqa: E402
from wt.data.etf_minutes import load  # noqa: E402
from wt.signals import setups  # noqa: E402

DEV_END = pd.Timestamp("2025-09-25").date()
results = {}
for sym in ("SPY", "QQQ"):
    df = load(sym)
    df = df[df.date <= DEV_END]
    by_day = [g.reset_index(drop=True) for _, g in df.groupby("date") if len(g) >= 200][20:]
    for fam, win, mg in (("A", (5, 60), "M1"), ("B", (30, 390), "M3")):
        means = []
        for seed in range(200):
            rs = []
            rng = np.random.default_rng(seed)
            for b in by_day:
                if rng.random() > 0.75:          # match approx trade frequency (~70% of days)
                    continue
                sig = setups.random_entry(b, window=win, seed=int(rng.integers(1e9)))
                if sig is None:
                    continue
                cst = Costs(slippage_per_share={'SPY': 0.07, 'QQQ': 0.022}[sym])
                tr = simulate(b, sig, REGISTRY[mg](), cst, sym, "", 6, 1e9, 1e9, flatten_idx=len(b) - 11)
                if tr:
                    rs.append(tr.r_multiple(cst))
            means.append(float(np.mean(rs)))
        results[f"{fam}|{sym}|control"] = {"control_means": means,
                                           "trades": [{"R": m, "date": "2020-01-02"} for m in means]}
        print(fam, sym, "control mean of means", round(np.mean(means), 4), "95th pct", round(np.percentile(means, 95), 4), flush=True)
save_experiment(sys.argv[1] if len(sys.argv) > 1 else "EXP-0006-g1-etf-controls", [], {"n_trials": 0, "results": results})
