"""HYP-0007 (EXP-0014): intraday HOD-momentum scanner + entries, dev span.

Fetch superset (NOT a signal): stocks with prior close $2-30, day high >= +10% vs prior close, day volume >= 1M
(every stock that could satisfy the causal intraday trigger is in this set). Signals are causal:
  qualify at the first 1m bar t in 09:45-11:30 with close_t >= 1.10 * prev_close, price $2-30, and
  RVOL_t = cumvol_t / (ADV20 * f(t)) >= 5, where f(t) = average cumulative share of daily volume by minute
  (estimated from the liquid-universe cache, i.e. other stocks/days — no same-stock look-ahead).
Entries after qualification: (a) 5m bull flag (ATR stop), (b) first 1m pullback: after >=1 red 1m candle,
trigger = that candle's high + 1c; stop = min(pullback low, trigger - 1.5*ATR14(1m)). Mgmt M1, M3. 4 trials.

DEC-0011 H-LA: the day-volume filter is look-ahead, not a superset, because the trigger never required 1M shares by
the qualifying bar. This driver stays as EXP-0014 ran it; the forward trial runs as v2 (forward_test.hod_qualify).
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.engine import Costs, EntrySignal, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.stats import summarize  # noqa: E402
from wt.core.clock import et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR, ROOT  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.universe import load_daily  # noqa: E402
from wt.signals import setups  # noqa: E402

DEV0, DEV1 = dt.date(2019, 2, 1), dt.date(2025, 9, 25)
CACHE = DATA_DIR / "minute_intraday"
OUT = ROOT / "research/experiments/EXP-0014-r2-intraday-hod"
TICK = 0.01


def volume_curve() -> np.ndarray:
    fs = sorted((DATA_DIR / "minute_liquid").glob("*.parquet"))[::10]
    curves = []
    for f in fs:
        df = pd.read_parquet(f)
        for _, g in df.groupby("symbol"):
            v = g.sort_values("t").v.to_numpy()
            if len(v) >= 385:
                curves.append(np.cumsum(v[:390]) / v[:390].sum() if len(v) >= 390 else None)
    curves = [c for c in curves if c is not None]
    return np.mean(curves, axis=0)


def first_pullback(bars, start: int, window_end: int):
    o, h, l, c = (bars[k].to_numpy() for k in "ohlc")
    for i in range(start + 1, min(window_end, len(bars) - 1)):
        if c[i] < o[i]:                                  # red 1m candle = pullback bar
            trig = h[i] + TICK
            atr = float(np.mean(h[max(0, i - 13): i + 1] - l[max(0, i - 13): i + 1]))
            stop = min(l[i] - TICK, trig - 1.5 * atr)
            if trig - stop >= 2 * TICK:
                return EntrySignal(i, round(trig, 4), round(stop, 4), None, "HOD_first_pullback")
    return None


def main() -> None:
    a, daily = AlpacaREST(), load_daily().sort_values(["symbol", "date"])
    daily["pc"] = daily.groupby("symbol").c.shift(1)
    daily["adv20"] = daily.groupby("symbol").v.transform(lambda s: s.rolling(20).mean().shift(1))
    sup = daily[(daily.date >= DEV0) & (daily.date <= DEV1) & daily.pc.between(2, 30) & (daily.h / daily.pc - 1 >= 0.10)
                & (daily.v >= 1e6) & daily.adv20.notna()]
    f_t = volume_curve()
    cal = a.calendar(DEV0.isoformat(), DEV1.isoformat())
    early = {r.date: r.close for r in cal.itertuples() if r.close != "16:00"}
    CACHE.mkdir(parents=True, exist_ok=True)
    cfgs = [("bull_flag", "M1"), ("bull_flag", "M3"), ("first_pullback", "M1"), ("first_pullback", "M3")]
    trades = {f"HOD_{e}|{m}": [] for e, m in cfgs}
    days = sorted(sup.date.unique())
    for n, d in enumerate(days, 1):
        g = sup[sup.date == d].set_index("symbol")
        f = CACHE / f"{d}.parquet"
        if not f.exists():
            bars = a.bars(list(g.index), "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, early.get(d, "16:00"))), feed="sip")
            bars.to_parquet(f)
        bars = pd.read_parquet(f)
        close = early.get(d, "16:00")
        flat = (int(close[:2]) * 60 + int(close[3:])) - 570 - 10
        for sym, b in bars.groupby("symbol"):
            b = b.sort_values("t").reset_index(drop=True)
            if len(b) < 60:
                continue
            pc, adv = float(g.loc[sym, "pc"]), float(g.loc[sym, "adv20"])
            cum = np.cumsum(b.v.to_numpy())
            q = None
            for i in range(15, min(120, len(b) - 1)):          # 09:45-11:30
                rv = cum[i] / max(1.0, adv * f_t[min(i, len(f_t) - 1)])
                if b.c.iloc[i] >= 1.10 * pc and 2 <= b.c.iloc[i] <= 30 and rv >= 5:
                    q = i
                    break
            if q is None:
                continue
            for e, m in cfgs:
                sig = (setups.s1_bull_flag_5m(b, window=(q + 1, 120), start=q, atr_stop_mult=1.5) if e == "bull_flag"
                       else first_pullback(b, q, 120))
                if sig is None:
                    continue
                tr = simulate(b, sig, REGISTRY[m](), Costs(), sym, str(d), 6, 1e9, 1e9, flatten_idx=min(flat, len(b) - 1))
                if tr:
                    trades[f"HOD_{e}|{m}"].append({"date": str(d), "symbol": sym, "R": tr.r_multiple(Costs()),
                                                   "exit": tr.exits[-1][3], "mfe_R": tr.mfe, "q_min": q})
        if n % 100 == 0:
            print(f"{n}/{len(days)} {d}", {k: len(v) for k, v in trades.items()}, flush=True)
    res = {}
    for k, tl in trades.items():
        r = np.array([t["R"] for t in tl])
        s = summarize(r) if len(r) else {"n": 0}
        if len(r):
            yrs = pd.DataFrame(tl).assign(y=lambda x: x.date.str[:4]).groupby("y").R.sum()
            s["years_profitable"] = f"{int((yrs > 0).sum())}/{len(yrs)}"
        res[k] = {"summary": s, "trades": tl}
        print(k, {x: s.get(x) for x in ("n", "expectancy_R", "win_rate", "profit_factor", "ci95_expectancy", "years_profitable")}, flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps({"n_trials": 4, "results": res}, indent=1, default=str))


if __name__ == "__main__":
    main()
