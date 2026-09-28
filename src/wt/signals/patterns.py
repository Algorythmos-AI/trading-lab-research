"""Pattern detectors for SPEC-0001 (PAT-01..PAT-10). Pure and causal: a detector evaluated at bar index i
reads bars[: i + 1] only. Bars are DataFrames with columns o, h, l, c, v (plus t for clock helpers).

Operational definitions (spec.yaml `patterns`, conflicts.md K-03, K-09, K-15):
  bull flag  - 3-5 consecutive green pole bars, then 1-3 flag bars ending at i:
               - no flag bar trades above the pole high
               - at least one flag bar pulls back (red, or closes below the prior close)
               - flag low retraces <= 25% of the pole (pole low = first pole bar's low)
               - each flag bar's volume < 50% of the pole's peak-volume bar
               - every flag low >= EMA9
               trigger = the last flag bar's high ("first candle to make a new high")
               stop    = the flag low
  flat top   - a window of 2-6 bars ending at i, preceded by >= 3 green bars:
               - >= 2 highs within $0.01 of the window high (horizontal resistance)
               - lows non-decreasing (higher lows)
               - window lows >= EMA9
               trigger = resistance
               stop    = the last bar's low (ascending support)
  ABCD (5m)  - A = lowest low before B; B = the leg high; C = lowest low after B:
               - C > A (a higher low), (B - C) / (B - A) <= 0.618
               - the bar at i has a higher low than C and closes above EMA9
               - B is not yet broken
               trigger = B;  stop = C
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from wt.signals.common import ema


@dataclass(frozen=True)
class Pattern:
    kind: str                 # bull_flag | flat_top | abcd
    trigger: float            # price level whose break is the entry (trigger + $0.01 is the order)
    stop: float               # pattern low (stop - $0.01 is the stop)
    end_idx: int              # bar index where the pattern completed (signal bar)
    high: float               # pattern resistance / apex
    meta: dict = field(default_factory=dict, compare=False)


def _arr(bars: pd.DataFrame, i: int):
    s = bars.iloc[: i + 1]
    return s.o.to_numpy(float), s.h.to_numpy(float), s.l.to_numpy(float), s.c.to_numpy(float), s.v.to_numpy(float)


def bull_flag(bars: pd.DataFrame, i: int, pole=(3, 5), flag=(1, 3), retrace_max: float = 0.25,
              flag_vol_max: float = 0.50, high_conviction_vol: float = 0.30, ema_n: int = 9,
              ema_values: np.ndarray | None = None) -> Pattern | None:
    if i < pole[0] + flag[0]:
        return None
    o, h, l, c, v = _arr(bars, i)
    e = ema_values[: i + 1] if ema_values is not None else ema(c, ema_n)
    for m in range(flag[0], flag[1] + 1):                       # shortest flag first
        f0 = i - m + 1
        for n in range(pole[1], pole[0] - 1, -1):              # longest pole first
            p0 = f0 - n
            if p0 < 0:
                continue
            if not np.all(c[p0:f0] > o[p0:f0]):
                continue
            pole_high, pole_low = h[p0:f0].max(), l[p0]
            if pole_high <= pole_low:
                continue
            fh, fl = h[f0:i + 1], l[f0:i + 1]
            if fh.max() > pole_high:
                continue
            pulled = any(c[j] < o[j] or c[j] < c[j - 1] for j in range(f0, i + 1))
            if not pulled:
                continue
            retrace = (pole_high - fl.min()) / (pole_high - pole_low)
            if retrace > retrace_max:
                continue
            peak = v[p0:f0].max()
            if peak <= 0 or np.any(v[f0:i + 1] >= flag_vol_max * peak):
                continue
            if np.any(fl < e[f0:i + 1]):
                continue
            hc = bool(np.all(v[f0:i + 1] < high_conviction_vol * peak))
            return Pattern("bull_flag", trigger=float(h[i]), stop=float(fl.min()), end_idx=i, high=float(pole_high),
                           meta={"pole_bars": n, "flag_bars": m, "retrace": float(retrace), "high_conviction_volume": hc,
                                 "pole_low": float(pole_low), "flag_high": float(fh.max())})
    return None


def flat_top(bars: pd.DataFrame, i: int, window=(2, 6), tol: float = 0.01, touches: int = 2, greens_before: int = 3,
             ema_n: int = 9, ema_values: np.ndarray | None = None) -> Pattern | None:
    o, h, l, c, v = _arr(bars, i)
    e = ema_values[: i + 1] if ema_values is not None else ema(c, ema_n)
    for w in range(window[0], window[1] + 1):
        s = i - w + 1
        if s - greens_before < 0:
            continue
        if not np.all(c[s - greens_before:s] > o[s - greens_before:s]):
            continue
        res = h[s:i + 1].max()
        if (h[s:i + 1] >= res - tol).sum() < touches:
            continue
        if np.any(np.diff(l[s:i + 1]) < 0):
            continue
        if np.any(l[s:i + 1] < e[s:i + 1]):
            continue
        if h[s - 1] > res + tol:                               # resistance must be the top of the move so far
            continue
        return Pattern("flat_top", trigger=float(res), stop=float(l[i]), end_idx=i, high=float(res),
                       meta={"window_bars": w, "touches": int((h[s:i + 1] >= res - tol).sum())})
    return None


def abcd(bars: pd.DataFrame, i: int, start: int = 0, retrace_max: float = 0.618, ema_n: int = 9,
         ema_values: np.ndarray | None = None) -> Pattern | None:
    o, h, l, c, v = _arr(bars, i)
    e = ema_values[: i + 1] if ema_values is not None else ema(c, ema_n)
    if i - start < 3:
        return None
    seg_h = h[start:i]                                          # B must be before the signal bar
    b = start + int(np.argmax(seg_h))
    if b <= start or b >= i - 1:
        return None
    a = start + int(np.argmin(l[start:b]))
    if a >= b:
        return None
    cc = b + 1 + int(np.argmin(l[b + 1:i]))                     # C strictly after B, before the signal bar
    A, B, C = l[a], h[b], l[cc]
    if not (C > A and B > A):
        return None
    if (B - C) / (B - A) > retrace_max:
        return None
    if not (l[i] > C and c[i] > e[i] and h[i] <= B):
        return None
    return Pattern("abcd", trigger=float(B), stop=float(C), end_idx=i, high=float(B),
                   meta={"A": float(A), "B": float(B), "C": float(C), "a_idx": a, "b_idx": b, "c_idx": cc,
                         "retrace": float((B - C) / (B - A))})


def breakout_volume_ok(v: np.ndarray, idx: int, n: int = 20, ratio: float = 2.0) -> bool:
    """PAT-08: the breakout bar's volume >= ratio x the average of the n bars before it (known at its close)."""
    if idx < 1:
        return False
    prior = v[max(0, idx - n):idx]
    return len(prior) > 0 and prior.mean() > 0 and v[idx] >= ratio * prior.mean()


def pm_pattern(pm5: pd.DataFrame, price_0925: float, ema_n: int = 9) -> Pattern | None:
    """PAT-10: the pre-market pattern active at 09:25, on clock-aligned 5-minute pre-market bars that end by
    09:25. A bull flag or a flat top at the last bar. For a flag, the 09:25 price must sit in the upper half
    of the flag's range."""
    if len(pm5) < 5:
        return None
    i = len(pm5) - 1
    e = ema(pm5.c.to_numpy(float), ema_n)
    p = bull_flag(pm5, i, ema_values=e)
    if p is not None:
        mid = (p.stop + p.meta["flag_high"]) / 2
        return p if price_0925 >= mid else None
    return flat_top(pm5, i, ema_values=e)
