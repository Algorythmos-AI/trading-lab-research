"""Intraday qualifiers: SCN-HOD (high-of-day momentum) and SCN-REV (reversal hybrid, long side).

Both are causal: the value at 1-minute index i (or 5-minute bucket k) uses bars up to and including i
(or k) only, plus prior-session data.

Time-of-day volume curve (plan D37): the share of a session's volume traded by each clock minute. It is
estimated once from 2019 liquid-universe minute bars (the warm-up year, before the 2020+ out-of-sample
span), indexed by clock minute, not by bar position.
"""
from __future__ import annotations

import datetime as dt
from functools import lru_cache

import numpy as np
import pandas as pd

from wt.core.config import DATA_DIR
from wt.signals.bars import RTH_OPEN, et_minutes
from wt.signals.common import bollinger, ema, rsi

CURVE_FILE = DATA_DIR / "intraday_volume_curve_2019.npy"
SESSION_MIN = 390


def build_volume_curve(year: int = 2019) -> np.ndarray:
    """Mean cumulative volume share by clock minute offset 0..389 from 09:30, from liquid names in `year`."""
    curves = []
    for f in sorted((DATA_DIR / "minute_liquid").glob(f"{year}-*.parquet")):
        df = pd.read_parquet(f)
        for _, g in df.groupby("symbol"):
            g = g.sort_values("t")
            off = et_minutes(g) - RTH_OPEN
            ok = (off >= 0) & (off < SESSION_MIN)
            if ok.sum() < 300:
                continue
            per_min = np.zeros(SESSION_MIN)
            np.add.at(per_min, off[ok], g.v.to_numpy(float)[ok])
            tot = per_min.sum()
            if tot > 0:
                curves.append(np.cumsum(per_min) / tot)
    if not curves:
        raise RuntimeError(f"no {year} minute_liquid data to build the volume curve")
    curve = np.mean(curves, axis=0)
    np.save(CURVE_FILE, curve)
    return curve


@lru_cache(maxsize=1)
def volume_curve() -> np.ndarray:
    return np.load(CURVE_FILE) if CURVE_FILE.exists() else build_volume_curve()


def curve_at(minute_of_day: np.ndarray | int, curve: np.ndarray | None = None) -> np.ndarray:
    """Cumulative expected share of the day's volume by the END of the bar starting at `minute_of_day`."""
    cv = volume_curve() if curve is None else curve
    off = np.clip(np.asarray(minute_of_day) - RTH_OPEN, 0, SESSION_MIN - 1)
    return cv[off]


def hod_mask(bars: pd.DataFrame, adv20: float, float_shares: float | None, catalyst_times: list,
             window=(575, 690), price=(1.0, 10.0), vol_min=1_000_000, rvol_min=2.0, surge_min=20.0,
             float_max=20_000_000, curve: np.ndarray | None = None) -> np.ndarray:
    """SCN-HOD-01..06, 08, 09 per 1-minute bar (spread, SCN-HOD-07, is checked at the signal by the runner).
    catalyst_times: sorted UTC timestamps of qualifying headlines; one must be <= the bar's end."""
    n = len(bars)
    out = np.zeros(n, bool)
    if n == 0 or not adv20 or adv20 <= 0 or float_shares is None or float_shares > float_max:
        return out
    m = et_minutes(bars)
    h, c, v = bars.h.to_numpy(float), bars.c.to_numpy(float), bars.v.to_numpy(float)
    cum = np.cumsum(v)
    share = curve_at(m, curve)
    prev_share = curve_at(m - 5, curve) * (m - 5 >= RTH_OPEN)
    hod_before = np.maximum.accumulate(np.r_[-np.inf, h[:-1]])
    bar_end = pd.to_datetime(bars.t, utc=True) + pd.Timedelta(minutes=1)
    if catalyst_times:
        first_cat = min(pd.Timestamp(t, tz="UTC") if pd.Timestamp(t).tzinfo is None else pd.Timestamp(t) for t in catalyst_times)
        cat = (bar_end >= first_cat).to_numpy()
    else:
        cat = np.zeros(n, bool)
    for i in range(n):
        if not (window[0] <= m[i] < window[1]) or not (price[0] <= c[i] <= price[1]):
            continue
        if cum[i] < vol_min or h[i] < hod_before[i] or not cat[i]:
            continue
        if cum[i] / (adv20 * max(share[i], 1e-6)) < rvol_min:
            continue
        vol5 = cum[i] - (cum[i - 5] if i >= 5 else 0.0)
        exp5 = adv20 * max(share[i] - prev_share[i], 1e-6)
        if vol5 / exp5 < surge_min:
            continue
        out[i] = True
    return out


def rev_qualifies(prev5: pd.DataFrame, today5: pd.DataFrame, k: int, prev2c: np.ndarray, today2: pd.DataFrame,
                  cum_vol: float, adv5: float, adv20: float, curve_share: float,
                  price=(15.0, 250.0), vol_min=500_000, adv5_min=300_000, rvol_min=1.0, reds=3,
                  bb_n=20, bb_k=2.0, rsi_n=14, rsi_max=20.0) -> tuple[bool, dict]:
    """SCN-REV at completed 5-minute bucket k of today (prior-session buckets warm up the indicators, D8).
    today2: today's completed 2-minute buckets up to the same moment (the runner passes the right slice)."""
    c5 = np.r_[prev5.c.to_numpy(float), today5.c.to_numpy(float)[: k + 1]]
    o_t, c_t, l_t = today5.o.to_numpy(float), today5.c.to_numpy(float), today5.l.to_numpy(float)
    info = {}
    if not (price[0] <= c_t[k] <= price[1]) or cum_vol < vol_min or adv5 < adv5_min:
        return False, info
    if not adv20 or cum_vol / (adv20 * max(curve_share, 1e-6)) < rvol_min:
        return False, info
    if k + 1 < reds or not np.all(c_t[k - reds + 1: k + 1] < o_t[k - reds + 1: k + 1]):
        return False, info
    if l_t[k] > l_t[: k + 1].min() + 1e-9:
        return False, info
    lower, _, _ = bollinger(c5, bb_n, bb_k)
    if np.isnan(lower[-1]) or c5[-1] > lower[-1]:
        return False, info
    if len(c5) <= rsi_n or rsi(c5, rsi_n)[-1] >= rsi_max:
        return False, info
    c2 = np.r_[prev2c, today2.c.to_numpy(float)]
    if len(c2) <= rsi_n or rsi(c2, rsi_n)[-1] >= rsi_max:
        return False, info
    info["ema9_5m"] = float(ema(c5, 9)[-1])
    return True, info
