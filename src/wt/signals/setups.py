"""Setup detectors (knowledge/strategy_components_catalog.md). Each returns the FIRST valid EntrySignal
of the session (one attempt per call; the runner may call again after an exit, max 2 attempts/symbol).

All detectors only read bars[: i+1] at decision index i (enforced by construction; property-tested).
Signal bar_index is always a 1-minute index; orders act from bar_index+1.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from wt.backtest.engine import EntrySignal
from wt.signals.common import bollinger, ema, resample_5m, rsi, session_vwap

TICK = 0.01


def _window_ok(bars: pd.DataFrame, i: int, window: tuple[int, int]) -> bool:
    """window in minutes after 09:30 (e.g. (0, 60) = 09:30-10:30)."""
    return window[0] <= i < window[1]


def s1_pm_high_break(bars, pm_high: float, window=(0, 120), max_stop_cents=0.20, start=0):
    """S1 Gap&Go: first 1m bar that trades above the pre-market high. Signal = bar before the break
    (the order rests at pm_high + 1c); stop = low of the signal bar, capped at 20c below trigger."""
    h, l = bars.h.to_numpy(), bars.l.to_numpy()
    for i in range(max(start, 0), len(bars) - 1):
        if not _window_ok(bars, i + 1, window):
            continue
        if h[: i + 1].max() >= pm_high:          # already broke earlier -> not a fresh break
            return None
        trig = pm_high + TICK
        stop = max(l[i], trig - max_stop_cents)
        if trig - stop >= TICK:
            return EntrySignal(i, trig, round(stop - TICK, 4), None, "S1_pm_high_break")
    return None


def _atr1m(bars, i, n=14) -> float:
    h, l = bars.h.to_numpy(), bars.l.to_numpy()
    return float(np.mean(h[max(0, i - n + 1): i + 1] - l[max(0, i - n + 1): i + 1]))


def s1_bull_flag_5m(bars, window=(0, 120), green_min=3, red_min=2, retrace_max=0.5, stop_mode="pullback_low",
                    max_stop_cents=None, start=0, atr_stop_mult: float | None = None):
    """S1 bull flag on 5m: >=green_min green 5m candles, then >=red_min red candles holding above
    retrace_max of the impulse and not breaking the impulse high; trigger = high of last red + 1c."""
    b5, last_done = resample_5m(bars)
    o, h, l, c = (b5[k].to_numpy() for k in "ohlc")
    for i in range(max(start, 0), len(bars) - 1):
        if not _window_ok(bars, i + 1, window) or (i % 5) != 4:
            continue
        k = last_done[i]
        if k < green_min + red_min:
            continue
        reds = 0
        while reds < 3 and k - reds >= 0 and c[k - reds] < o[k - reds]:
            reds += 1
        if reds < red_min:
            continue
        g_end = k - reds
        greens = 0
        while g_end - greens >= 0 and c[g_end - greens] > o[g_end - greens]:
            greens += 1
        if greens < green_min:
            continue
        imp_lo, imp_hi = l[g_end - greens + 1], h[g_end]
        pb_lo = l[g_end + 1: k + 1].min()
        if h[g_end + 1: k + 1].max() > imp_hi:
            continue
        if imp_hi - pb_lo > retrace_max * (imp_hi - imp_lo):
            continue
        trig = h[k] + TICK
        stop = pb_lo - TICK if stop_mode == "pullback_low" else l[k] - TICK
        if max_stop_cents:
            stop = max(stop, trig - max_stop_cents)
        if atr_stop_mult:                                   # HYP-0008: never tighter than k x ATR14(1m)
            stop = min(stop, trig - atr_stop_mult * _atr1m(bars, i))
        if trig - stop >= 2 * TICK:
            return EntrySignal(i, round(trig, 4), round(stop, 4), None, "S1_bull_flag_5m",
                               {"impulse_R": float(imp_hi - imp_lo)})
    return None


def s2_extreme_reversal(bars, window=(15, 330), down_min=3, rsi_max=20.0, rr_min=2.0, room_min=0.30, start=0):
    """S2 long reversal on 5m: >=down_min red 5m candles, last close below lower BB(20,2), RSI14<=rsi_max.
    Trigger = high of the exhaustion 5m bar + 1c; stop = low of day - 1c; target = EMA9(5m); meta vwap.
    Requires >= room_min $ and >= rr_min reward:risk to EMA9."""
    b5, last_done = resample_5m(bars)
    o, h, l, c = (b5[k].to_numpy() for k in "ohlc")
    vw = session_vwap(bars)
    lod = np.minimum.accumulate(bars.l.to_numpy())
    for i in range(max(start, 0), len(bars) - 1):
        if not _window_ok(bars, i + 1, window) or (i % 5) != 4:
            continue
        k = last_done[i]
        if k < 20:
            continue
        cc = c[: k + 1]
        lo_band, _, _ = bollinger(cc)
        r = rsi(cc)[-1]
        downs = 0
        while k - downs >= 0 and c[k - downs] < o[k - downs]:
            downs += 1
        if downs < down_min or not (cc[-1] < lo_band[-1]) or r > rsi_max:
            continue
        e9 = ema(cc, 9)[-1]
        trig, stop = h[k] + TICK, lod[i] - TICK
        if trig - stop <= 0 or e9 - trig < room_min or (e9 - trig) / (trig - stop) < rr_min:
            continue
        return EntrySignal(i, round(trig, 4), round(stop, 4), round(e9, 4), "S2_extreme_reversal", {"vwap": float(vw[i])})
    return None


def s3_vwap_pullback(bars, window=(15, 330), touch_tol=0.001, start=0):
    """S3: price trended above VWAP; a 1m bar's low touches VWAP (within tol) and closes above it ->
    trigger = that bar's high + 1c; stop = min(bar low, VWAP) - 1c."""
    h, l, c = bars.h.to_numpy(), bars.l.to_numpy(), bars.c.to_numpy()
    vw = session_vwap(bars)
    for i in range(max(start, 15), len(bars) - 1):
        if not _window_ok(bars, i + 1, window):
            continue
        above = (c[i - 15: i] > vw[i - 15: i]).mean() >= 0.8
        if above and l[i] <= vw[i] * (1 + touch_tol) and c[i] > vw[i]:
            trig, stop = h[i] + TICK, min(l[i], vw[i]) - TICK
            if trig - stop >= 2 * TICK:
                return EntrySignal(i, round(trig, 4), round(stop, 4), None, "S3_vwap_pullback")
    return None


def s5_breakout_retest(bars, level: float, window=(0, 330), retest_tol=0.002, start=0,
                       atr_stop_mult: float | None = None):
    """S5: a 1m close above `level` (pre-market high or prior-day high), then a later bar whose low comes
    back within tol of the level and closes above it -> trigger = retest high + 1c; stop = level - max(2c, 0.3*ATR(14,1m))."""
    h, l, c = bars.h.to_numpy(), bars.l.to_numpy(), bars.c.to_numpy()
    broke = None
    for i in range(max(start, 0), len(bars) - 1):
        if not _window_ok(bars, i + 1, window):
            continue
        if broke is None:
            if c[i] > level:
                broke = i
            continue
        if i > broke and l[i] <= level * (1 + retest_tol) and c[i] > level:
            atr = float(np.mean(h[max(0, i - 14): i + 1] - l[max(0, i - 14): i + 1]))
            trig, stop = h[i] + TICK, level - max(2 * TICK, 0.3 * atr)
            if atr_stop_mult:                               # HYP-0008
                stop = min(stop, trig - atr_stop_mult * atr)
            if trig - stop >= 2 * TICK:
                return EntrySignal(i, round(trig, 4), round(stop, 4), None, "S5_breakout_retest", {"level": level})
    return None


def random_entry(bars, window=(0, 120), seed: int = 0, atr_mult: float = 2.0, start=0):
    """CONTROL: random entry bar inside the same window; stop = trigger - atr_mult*ATR(14,1m).
    Same management/sizing/costs as the real strategy -> tests whether the setup adds value."""
    rng = np.random.default_rng(seed)
    lo, hi = max(window[0], start, 15), min(window[1], len(bars) - 2)
    if hi <= lo:
        return None
    i = int(rng.integers(lo, hi))
    h, l, c = bars.h.to_numpy(), bars.l.to_numpy(), bars.c.to_numpy()
    atr = float(np.mean(h[i - 14: i + 1] - l[i - 14: i + 1]))
    trig = c[i] + TICK
    stop = trig - max(2 * TICK, atr_mult * atr)
    return EntrySignal(i, round(trig, 4), round(stop, 4), None, "CONTROL_random")


def a_orb_5m(bars, stop_mode: str = "range_low", atr_daily: float | None = None, start=0, window=(5, 390)):
    """A — 5-minute opening-range breakout, LONG only (Zarattini/Barbon/Aziz 2023 adaptation).
    Needs a bullish first 5-min candle; trigger = its high + 1c (orders from 09:35);
    stop = range low (catalog S7) or entry - 0.10*ATR14(daily) (paper variant)."""
    if len(bars) < 10 or start > 4:
        return None
    o, h, l, c = bars.o.iloc[0], bars.h.iloc[:5].max(), bars.l.iloc[:5].min(), bars.c.iloc[4]
    if c <= o:
        return None
    trig = h + TICK
    stop = (l - TICK) if stop_mode == "range_low" else trig - 0.10 * (atr_daily or (h - l))
    if trig - stop < TICK:
        return None
    return EntrySignal(4, round(trig, 4), round(stop, 4), None, f"A_orb_5m_{stop_mode}")


def b_intraday_momentum(bars, sigma: float, prev_close: float, start=0, window=(30, 390), vm: float = 1.0):
    """B — intraday momentum 'noise area' (Zarattini/Aziz/Barbon 2024), LONG only.
    Upper boundary = max(open, prev_close) * (1 + vm*sigma), sigma = avg abs move from open to this
    time over the prior 14 days (caller supplies a single representative sigma). Checked on half-hour
    marks from 10:00; trigger = the bar close + 1c; stop = session VWAP at signal (trailed by M4-like mgmt)."""
    vw = session_vwap(bars)
    c = bars.c.to_numpy()
    upper = max(bars.o.iloc[0], prev_close) * (1 + vm * sigma)
    for i in range(max(start, window[0] - 1), min(window[1], len(bars) - 1)):
        if (i + 1) % 30 != 0:
            continue
        if c[i] > upper and c[i] > vw[i]:
            trig, stop = c[i] + TICK, min(vw[i], c[i] * (1 - sigma)) - TICK
            if trig - stop >= 2 * TICK:
                return EntrySignal(i, round(trig, 4), round(stop, 4), None, "B_intraday_momentum")
    return None
