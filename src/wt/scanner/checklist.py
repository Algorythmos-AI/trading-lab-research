"""Chart musts and tags for SPEC-0001 (CHT-01..07, FUN-07). Everything is point-in-time for day d. Daily inputs are
one symbol's history STRICTLY BEFORE d, already split-adjusted to d's share basis
(corpactions.SplitFactors.adjust_asof). Pre-market inputs are d's 1-minute bars 04:00-09:24.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from wt.signals.bars import et_minutes
from wt.signals.common import ema


@dataclass(frozen=True)
class Trend:
    close: float
    ema20: float
    ema50: float
    ema200: float
    bars: int

    @property
    def ok(self) -> bool:
        """CHT-01: prior close above EMA20, EMA50 and EMA200, with >= 200 bars of history."""
        return self.bars >= 200 and self.close > self.ema20 and self.close > self.ema50 and self.close > self.ema200


def trend(hist: pd.DataFrame) -> Trend | None:
    if hist.empty:
        return None
    c = hist.c.to_numpy(float)
    return Trend(float(c[-1]), float(ema(c, 20)[-1]), float(ema(c, 50)[-1]), float(ema(c, 200)[-1]), len(c))


def atr14(hist: pd.DataFrame, n: int = 14) -> float | None:
    """Wilder-style simple mean of the true range over the last n days (prior days only)."""
    if len(hist) < n + 1:
        return None
    h, l, c = (hist[k].to_numpy(float) for k in "hlc")
    tr = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])))
    return float(tr[-n:].mean())


def overhead_levels(hist: pd.DataFrame, lookback: int = 90, swing_each_side: int = 2) -> list[float]:
    """CHT-02 level set over the last `lookback` sessions: daily opens and closes, swing highs (a high above the
    `swing_each_side` highs on each side), plus the prior day's high and close (D15)."""
    h = hist.tail(lookback)
    if h.empty:
        return []
    hi = h.h.to_numpy(float)
    levels = list(h.o.to_numpy(float)) + list(h.c.to_numpy(float))
    k = swing_each_side
    for i in range(k, len(hi) - k):
        if hi[i] > hi[i - k:i].max() and hi[i] > hi[i + 1:i + k + 1].max():
            levels.append(hi[i])
    levels += [float(h.h.iloc[-1]), float(h.c.iloc[-1])]
    return sorted(set(round(x, 4) for x in levels if x > 0))


def window_ok(price: float, levels: list[float], atr: float | None) -> tuple[bool, float | None]:
    """CHT-02/03: the distance from `price` to the nearest level above it must exceed ATR14. Blue sky (no level
    above) passes. Returns (ok, room)."""
    if atr is None or atr <= 0:
        return False, None
    above = [x for x in levels if x > price + 1e-9]
    if not above:
        return True, None
    room = min(above) - price
    return room > atr, room


def pm_consolidation(pm_bars: pd.DataFrame, check=(550, 565), range_window=(240, 565), top_fraction: float = 0.25) -> bool:
    """CHT-06: every 1-minute low of bars starting 09:10-09:24 is in the top `top_fraction` of the 04:00-09:24 range.
    Requires at least one bar in the check window."""
    if pm_bars is None or pm_bars.empty:
        return False
    m = et_minutes(pm_bars)
    rng = (m >= range_window[0]) & (m < range_window[1])
    chk = (m >= check[0]) & (m < check[1])
    if not chk.any() or not rng.any():
        return False
    hi, lo = pm_bars.h.to_numpy(float)[rng].max(), pm_bars.l.to_numpy(float)[rng].min()
    if hi <= lo:
        return False
    floor = hi - top_fraction * (hi - lo)
    return bool(np.all(pm_bars.l.to_numpy(float)[chk] >= floor - 1e-9))


def former_runner(hist: pd.DataFrame, lookback: int = 250, window: int = 5, ratio: float = 2.0) -> bool:
    """CHT-05 / FUN-07 (score booster only): within `lookback` sessions, a move of >= 100% inside any `window`
    sessions (max high / min low before it), or one day whose high was >= ratio x its low."""
    h = hist.tail(lookback)
    if h.empty:
        return False
    hi, lo = h.h.to_numpy(float), h.l.to_numpy(float)
    if np.any((lo > 0) & (hi >= ratio * lo)):
        return True
    for i in range(len(hi)):
        s = max(0, i - window + 1)
        base = lo[s:i + 1].min()
        if base > 0 and hi[i] >= ratio * base:
            return True
    return False
