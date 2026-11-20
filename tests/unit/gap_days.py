"""Synthetic gap days for the Gap Hunter tests (tests/unit/test_gap_live.py, test_runner_s_gap.py). No market data."""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
from spec_bars import flat, minute_bars

from wt.signals.patterns import Pattern

POOL_DAY = dt.date(2024, 3, 1)


# ---- a 09:25 pool, as scripts/build_pool.py writes the columns Gap Hunter reads -----------------------------------------
def pool_row(symbol: str, **kw) -> dict:
    """A pool row that passes Gap Hunter's hard filters with no headline (volume carries it)."""
    base = {"date": POOL_DAY, "symbol": symbol, "price_0925": 5.0, "gap_pct": 20.0, "pm_volume": 300_000.0, "rvol_pm": 5.0,
            "float_shares": 10_000_000.0, "catalyst_status": "none", "catalyst_category": "", "catalyst_score": 0.0,
            "former_runner": False, "headlines_n": 0, "trend_ok": False, "window_ok": False, "pm_consolidation": False,
            "suspect_split": False, "pm_high": float("nan"), "pm_pattern": None, "pm_pattern_trigger": float("nan"),
            "pm_pattern_stop": float("nan"), "overhead_levels": [99.0]}
    return {**base, **kw}


def write_pool(root, *rows: dict, pm: pd.DataFrame | None = None, day: dt.date = POOL_DAY) -> None:
    (root / "candidates").mkdir(exist_ok=True)
    pd.DataFrame(list(rows)).to_parquet(root / "candidates" / f"{day}.parquet")
    if pm is not None:
        (root / "pm_bars").mkdir(exist_ok=True)
        pm.to_parquet(root / "pm_bars" / f"{day}.parquet")


def bucket(o: float, h: float, low: float, c: float, v: float) -> list[tuple]:
    """Five one-minute rows that make one five-minute bar with this open, high, low, close and volume."""
    pts = [o, low, h, (h + c) / 2, c, c] if c >= o else [o, h, low, (low + c) / 2, c, c]
    pts = [round(x, 2) for x in pts]
    return [(a, max(a, b), min(a, b), b, int(v / 5)) for a, b in zip(pts[:-1], pts[1:], strict=True)]


def pad(rows: list[tuple], n: int = 150, v: int = 6_000) -> list[tuple]:
    last = rows[-1][3]
    return rows + [(last, last, last, last, v)] * max(0, n - len(rows))


def random_day(seed: int) -> tuple[pd.DataFrame, dict, float]:
    """(bars, ctx, slippage): a random walk with uneven volume, sometimes with minutes that did not print, and a
    random pre-market context around the first bar."""
    rng = np.random.default_rng(seed)
    px = round(float(rng.uniform(3.0, 12.0)), 2)
    drift = float(rng.choice([-0.01, 0.0, 0.005, 0.015]))
    vol = float(rng.choice([0.04, 0.06, 0.10]))
    rows = []
    for i in range(130):
        c = max(1.0, px + rng.normal(drift, vol))
        hi, lo = max(px, c) + abs(rng.normal(0, vol / 2)), min(px, c) - abs(rng.normal(0, vol / 2))
        v = int(rng.choice([150_000, 150_000, 150_000, 90_000])) if i == 0 else \
            int(rng.choice([2_000, 8_000, 20_000, 60_000, 250_000]))
        rows.append((round(px, 2), round(hi, 2), round(lo, 2), round(c, 2), v))
        px = c
    bars = minute_bars(rows)
    if rng.random() < 0.45:                                    # a thin name: some minutes never print
        drop = set(rng.choice(np.arange(1, 100), size=int(rng.integers(1, 12)), replace=False).tolist())
        if rng.random() < 0.3:
            drop |= {1}                                        # the 09:31 minute
        if rng.random() < 0.3:
            drop |= {4, 19, 24}                                # the last minute of a five-minute bar
        if rng.random() < 0.08:
            drop |= {0}                                        # no 09:30 bar at all
        bars = bars.drop(index=sorted(drop)).reset_index(drop=True)
    h0 = float(bars.h.iloc[0])
    ctx: dict = {"overhead": [], "pm_high": None, "pm_pattern": None, "pm_bars": None}
    if rng.random() < 0.8:
        ctx["pm_high"] = round(h0 + float(rng.choice([-0.05, 0.02, 0.04, 0.08, 0.15, 0.40])), 2)
    if rng.random() < 0.4:
        trig = round(h0 + float(rng.choice([-0.03, 0.03, 0.08, 0.20])), 2)
        ctx["pm_pattern"] = Pattern("bull_flag", trig, round(trig - float(rng.choice([0.08, 0.15, 0.45])), 2), -1, trig)
    if rng.random() < 0.5:
        ctx["overhead"] = sorted(round(h0 + float(x), 2) for x in rng.uniform(0.05, 1.5, size=int(rng.integers(1, 4))))
    if rng.random() < 0.5:
        ctx["pm_bars"] = minute_bars([(r[0], r[1], r[2], r[3], int(rng.choice([500, 5_000, 40_000])))
                                      for r in flat(60, round(h0 - 0.05, 2), spread=0.02)], start_et="08:30")
    return bars, ctx, float(rng.choice([0.01, 0.01, 0.01, 0.02, 0.025]))


# ---- hand-built days for the five-minute continuation (e3) ------------------------------------------------------------
PM = minute_bars(flat(60, 4.00, v=5_000), start_et="08:30")


def flag_setup() -> tuple[list[tuple], float, float]:
    """09:30-09:45 quiet, three green five-minute bars, a light flag 10:00-10:05. (rows to 10:05, trigger, stop)"""
    rows = [(4.00, 4.05, 3.98, 4.04, 150_000)] + flat(14, 4.04, v=20_000)
    for lo, hi in [(4.04, 4.20), (4.20, 4.36), (4.36, 4.52)]:
        rows += [(round(lo + (hi - lo) * i / 5, 2), round(lo + (hi - lo) * (i + 1) / 5, 2),
                  round(lo + (hi - lo) * i / 5, 2), round(lo + (hi - lo) * (i + 1) / 5, 2), 60_000) for i in range(5)]
    rows += [(4.52, 4.52, 4.41, 4.50, 6_000)] * 5
    return rows, 4.53, 4.40


def flat_top_setup() -> tuple[list[tuple], float, float]:
    """Three green five-minute bars from the open, then two heavy bars with the same high and rising lows."""
    rows = [(5.00, 5.05, 4.99, 5.04, 150_000)] + bucket(5.04, 5.12, 5.03, 5.10, 200_000)[1:]
    rows += bucket(5.10, 5.22, 5.09, 5.20, 250_000) + bucket(5.20, 5.32, 5.19, 5.30, 250_000)
    rows += bucket(5.30, 5.40, 5.27, 5.36, 240_000) + bucket(5.36, 5.40, 5.31, 5.38, 240_000)
    return rows, 5.41, 5.30


def abcd_setup() -> tuple[list[tuple], float, float]:
    """Up, a dip, a leg to B, a higher low C from 09:45, and a bar that holds over it. No three greens in a row."""
    rows = [(5.00, 5.06, 4.99, 5.05, 150_000)] + bucket(5.05, 5.20, 5.04, 5.18, 100_000)[1:]
    rows += bucket(5.18, 5.19, 5.12, 5.14, 60_000) + bucket(5.14, 5.42, 5.13, 5.38, 120_000)
    rows += bucket(5.38, 5.39, 5.26, 5.30, 60_000) + bucket(5.30, 5.38, 5.29, 5.36, 60_000)
    return rows, 5.43, 5.25


def after(kind: str, trigger: float, stop: float, v: int = 300_000) -> list[tuple]:
    """What follows the signal bar. `v`: the volume of the minute that breaks out."""
    t, quiet = trigger, [(trigger - 0.03, trigger - 0.02, trigger - 0.04, trigger - 0.03, 4_000)]
    if kind == "fill":                    # a quiet minute, then through the trigger and on
        rows = quiet + [(t - 0.03, t + 0.06, t - 0.03, t + 0.05, v)]
        px = t + 0.05
        for _ in range(12):
            rows.append((px, px + 0.05, px - 0.01, px + 0.04, 30_000))
            px = round(px + 0.04, 2)
        return rows + [(px, px + 0.01, px - 0.30, px - 0.28, 30_000)] * 2
    if kind == "gap":                     # opens over the collar: never fills
        return quiet + [(t + 0.20, t + 0.30, t + 0.18, t + 0.25, v)]
    if kind == "stop_first":              # trades under the stop before the trigger, then runs
        return quiet + [(t - 0.03, t - 0.02, stop - 0.05, stop - 0.02, v), (stop, t + 0.20, stop, t + 0.15, v)]
    if kind == "stall":                   # fills and goes nowhere
        return quiet + [(t - 0.03, t + 0.02, t - 0.03, t + 0.01, v)] + [(t + 0.01, t + 0.02, t - 0.01, t + 0.01, 9_000)] * 12
    if kind == "stopped":                 # fills and falls through the stop
        return quiet + [(t - 0.03, t + 0.02, t - 0.03, t + 0.01, v), (t + 0.01, t + 0.01, stop - 0.10, stop - 0.08, v)]
    return quiet * 3                      # "never": the trigger is not reached


E3_SETUPS = {"flag": flag_setup, "flat_top": flat_top_setup, "abcd": abcd_setup}
AFTERS = ("fill", "gap", "stop_first", "stall", "stopped", "never")


def e3_day(setup: str, what: str, v: int = 300_000) -> tuple[pd.DataFrame, dict]:
    rows, trigger, stop = E3_SETUPS[setup]()
    return minute_bars(pad(rows + after(what, trigger, stop, v))), {"pm_bars": PM, "overhead": []}
