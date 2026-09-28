"""G1 driver (first pass): run pre-registered S1/S5 configs x management styles x entry windows over a
date range, reusing cached watchlists (research/experiments/EXP-0002.../results.json or watchlist/*.json).

Usage: python scripts/g1_run.py EXP-0003-g1-pass1 2026-07-01 2026-09-25
Every config run is a trial in the global registry (research/experiments/).
"""
from __future__ import annotations

import datetime as dt
import itertools
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.runner import StratConfig, minute_bars, run_day, save_experiment  # noqa: E402
from wt.backtest.stats import deflated_sharpe_prob, summarize  # noqa: E402
from wt.core.config import DATA_DIR, ROOT  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402

WINDOWS = {"W1": (0, 30), "W2": (0, 60), "W3": (0, 120), "W4": (120, 240)}


def configs() -> list[StratConfig]:
    out = []
    for (setup, mg), (wk, win) in itertools.product(
            [("s1_pm_high_break", "M1"), ("s1_pm_high_break", "M2_2"), ("s1_pm_high_break", "M3"),
             ("s1_bull_flag_5m", "M1"), ("s1_bull_flag_5m", "M8"), ("s1_bull_flag_5m", "M5"),
             ("s5_breakout_retest_pmh", "M1"), ("s5_breakout_retest_pmh", "M4")],
            WINDOWS.items()):
        if setup == "s1_pm_high_break" and wk == "W4":
            continue            # PM-high break is an opening setup by definition
        out.append(StratConfig(name=f"{setup}|{mg}|{wk}", setup=setup, management=mg, window=win))
    # S2 extreme reversal (long) on the gapper watchlist: KB reversal scanner targets extended movers.
    for (rsi_max, down_min), mg in itertools.product(((10.0, 3), (20.0, 3), (20.0, 5)), ("M7", "M3")):
        out.append(StratConfig(name=f"s2_extreme_reversal|rsi{rsi_max:g}_d{down_min}|{mg}", setup="s2_extreme_reversal",
                               management=mg, window=(15, 360), params={"rsi_max": rsi_max, "down_min": down_min}))
    return out


def control_configs(n_seeds: int = 100) -> list[StratConfig]:
    """Random-entry controls matched to each watchlist family's window and baseline management."""
    fams = {"s1_pm_high_break": ((0, 120), "M1"), "s1_bull_flag_5m": ((0, 120), "M1"),
            "s5_breakout_retest_pmh": ((0, 120), "M1"), "s2_extreme_reversal": ((15, 360), "M7")}
    return [StratConfig(name=f"{fam}|control|seed{sd}", setup="random_entry", management=mg, window=win,
                        params={"seed": sd}) for fam, (win, mg) in fams.items() for sd in range(n_seeds)]


def r2_configs() -> list[StratConfig]:
    """HYP-0008 (DEC-0008): KB setups with stops never tighter than 1.5 x ATR14(1m); window W3 (09:30-11:30)."""
    out = []
    for setup, mg in itertools.product(("s1_bull_flag_5m", "s5_breakout_retest_pmh"), ("M1", "M3")):
        out.append(StratConfig(name=f"{setup}_atr|{mg}|W3", setup=setup, management=mg, window=(0, 120),
                               params={"atr_stop_mult": 1.5}))
    return out


def load_watchlists(start: dt.date, end: dt.date) -> dict[str, list[dict]]:
    wl = {}
    for f in sorted((ROOT / "watchlist").glob("*.json")):
        d = dt.date.fromisoformat(f.stem)
        if start <= d <= end:
            wl[f.stem] = json.loads(f.read_text())
    return wl


def main(exp_id: str, start: str, end: str) -> None:
    a = AlpacaREST()
    wls = load_watchlists(dt.date.fromisoformat(start), dt.date.fromisoformat(end))
    pm = pd.read_parquet(DATA_DIR / "pm" / "pm_agg.parquet")
    pmh = {(r.symbol, r.date): r.pm_high for r in pm.itertuples()}
    cfgs = control_configs() if CONTROL else (r2_configs() if "--r2" in sys.argv else configs())
    trades: dict[str, list] = {c.name: [] for c in cfgs}
    for day, doc in wls.items():
        d, top = dt.date.fromisoformat(day), doc["top"]
        if not top:
            continue
        for w in top:
            w["pm_high"] = w.get("pm_high") or pmh.get((w["symbol"], d))
        close = doc.get("early_close") or "16:00"
        hh, mm = map(int, close.split(":"))
        flatten_min = (hh * 60 + mm) - (9 * 60 + 30) - 10          # close - 10 min (plan rule, half-days too)
        bars = minute_bars(a, d, [w["symbol"] for w in top], close_hhmm=close)
        for c in cfgs:
            trades[c.name] += run_day(c, d, top, bars, flatten_min=flatten_min)
        print(day, {k: len(v) for k, v in list(trades.items())[:3]}, "...", flush=True)
    n_trials = len(cfgs)
    res = {}
    for name, tl in trades.items():
        r = np.array([t["R"] for t in tl])
        s = summarize(r)
        if s["n"] > 2:
            s["dsr_prob"] = deflated_sharpe_prob(s["per_trade_sharpe"], s["n"], n_trials, s["skew"], s["kurtosis"])
        res[name] = {"summary": s, "trades": tl}
    if CONTROL:
        fam_means: dict[str, list] = {}
        for name, v in res.items():
            if v["summary"].get("n", 0):
                fam_means.setdefault(name.split("|")[0], []).append(v["summary"]["expectancy_R"])
        res = {f"{fam}|control": {"control_means": m, "trades": []} for fam, m in fam_means.items()}
        n_trials = 0
    save_experiment(exp_id, cfgs, {"sessions": list(wls), "n_trials": n_trials, "results": res})
    rows = [(k, v["summary"].get("n", 0), v["summary"].get("expectancy_R", 0), v["summary"].get("win_rate", 0),
             v["summary"].get("profit_factor", 0), v["summary"].get("ci95_expectancy", [0, 0])) for k, v in res.items()]
    for row in sorted(rows, key=lambda x: -x[2]):
        print(f"{row[0]:<40} n={row[1]:<4} E={row[2]:+.3f}R win={row[3]:.0%} PF={row[4]:.2f} CI={row[5]}")


CONTROL = "--control" in sys.argv

if __name__ == "__main__":
    main(*[a for a in sys.argv[1:] if not a.startswith("--")][:3])
