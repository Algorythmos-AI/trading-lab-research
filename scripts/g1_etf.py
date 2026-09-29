"""G1 ETF track: strategies A (5-min ORB) and B (intraday momentum) on SPY/QQQ, dev span only.
R-multiples are scale-invariant, so SPY/QQQ bars stand in for SPYM/QQQM signals & fills (cost model uses
per-share slippage scaled to SPYM/QQQM price ratio ~ 1/7 and ~1/2 -> conservative: we keep 1c on SPY/QQQ).
Usage: python scripts/g1_etf.py EXP-0005-g1-etf [--method dec0011]
--method dec0011 (DEC-0011): trade-through targets, and every trade row carries its fills and realised P&L for
g1_eval --method dec0011. The default (legacy) reproduces the recorded runs."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.runner import save_experiment, StratConfig  # noqa: E402
from wt.backtest.stress import detail  # noqa: E402
from wt.data.etf_minutes import load  # noqa: E402
from wt.research.method import get_method, pop_method  # noqa: E402
from wt.signals import setups  # noqa: E402

DEV_END = pd.Timestamp("2025-09-25").date()


SLIP = {"SPY": 0.07, "QQQ": 0.022}   # 1c on SPYM (~SPY/7) and QQQM (~QQQ/2.28) expressed in SPY/QQQ units


def main(exp_id: str, method: str = "legacy") -> None:
    m = get_method(method)
    cfgs, results = [], {}
    for sym in ("SPY", "QQQ"):
        df = load(sym)
        df = df[df.date <= DEV_END]
        days = sorted(df.date.unique())
        daily = df.groupby("date").agg(o=("o", "first"), h=("h", "max"), l=("l", "min"), c=("c", "last"))
        daily["tr"] = np.maximum(daily.h - daily.l, np.maximum(abs(daily.h - daily.c.shift()), abs(daily.l - daily.c.shift())))
        daily["atr14"] = daily.tr.rolling(14).mean().shift(1)          # known before today's open
        # sigma for B: mean |close_t/open - 1| at 10:00..15:30 over prior 14 days (single blended value, causal)
        by_day = {d: g.reset_index(drop=True) for d, g in df.groupby("date")}
        absmove = pd.Series({d: float(np.mean(np.abs(g.c.iloc[29::30].to_numpy() / g.o.iloc[0] - 1))) for d, g in by_day.items() if len(g) > 60})
        sigma = absmove.rolling(14).mean().shift(1)
        variants = [("A", "range_low", "M3"), ("A", "range_low", "M4"), ("A", "atr10", "M4"),
                    ("A", "range_low", "M1"), ("B", None, "M4"), ("B", None, "M3")]
        for strat, mode, mg in variants:
            name = f"{strat}|{sym}|{mode or 'noise'}|{mg}"
            cfgs.append(StratConfig(name=name, setup=strat, management=mg, window=(0, 390)))
            trades = []
            for i, d in enumerate(days[20:], 20):
                b = by_day[d]
                if len(b) < 200:
                    continue
                flatten = len(b) - 11 if len(b) >= 380 else len(b) - 11
                if strat == "A":
                    sig = setups.a_orb_5m(b, stop_mode=mode, atr_daily=daily.atr14.get(d))
                else:
                    sg = sigma.get(d)
                    if sg is None or not np.isfinite(sg):
                        continue
                    sig = setups.b_intraday_momentum(b, sigma=float(sg), prev_close=float(daily.c.loc[days[i - 1]]))
                if sig is None:
                    continue
                cst = Costs(slippage_per_share=SLIP[sym])
                tr = simulate(b, sig, REGISTRY[mg](), cst, sym, str(d), risk_dollars=6, cash=1e9, max_notional=1e9,
                              flatten_idx=flatten, **m.sim_kwargs())
                if tr:
                    trades.append({"date": str(d), "symbol": sym, "R": tr.r_multiple(cst), "exit_reason": tr.exits[-1][3],
                                   "mfe_R": tr.mfe, "entry_time": str(tr.entry_time)} | ({} if m.legacy else detail(tr, cst)))
            r = np.array([t["R"] for t in trades])
            results[name] = {"trades": trades, "summary": {"n": len(r), "expectancy_R": float(r.mean()) if len(r) else 0}}
            print(f"{name:<28} n={len(r):<5} E={results[name]['summary']['expectancy_R']:+.3f}R", flush=True)
    save_experiment(exp_id, cfgs, {"n_trials": len(cfgs), "results": results} | ({} if m.legacy else {"method": m.name}))


if __name__ == "__main__":
    meth, argv = pop_method(sys.argv[1:])
    main(argv[0], meth.name)
