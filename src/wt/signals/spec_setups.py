"""SPEC-0001 entry setups: GG-1 to GG-4, MP-1 and REV-1 (spec.yaml `entries`). The G1 setups in setups.py stay
frozen for reproducibility.

Every setup returns the FIRST valid EntrySignal from 1-minute index `start` onward, or None. Triggers and
stops already include the $0.01 offsets. Orders act from bar_index + 1 until meta["expire_idx"], exclusive
(engine.simulate). A pending entry is cancelled if the stop trades first (existing engine rule, ENT-00).

bars: today's regular-session 1-minute bars (t, o, h, l, c, v), 0 = the 09:30 bar.
ctx keys used:
  pm_high, pm_pattern (Pattern | None), pm_bars (pre-market 1-minute bars)
  overhead (daily levels, as-of-d split-adjusted)
  mp_mask (bool per RTH bar; MP-1 universe)
  prev_rth (prior-session RTH 1-minute bars, REV-1 warm-up)
  adv5, adv20, curve (REV-1)

"Rolling" orders (the ORB ladder and red-to-green) are re-placed each bar: a stop-buy valid for the next bar
only. The setup returns the one that fills, which is the outcome of that causal process. Each order is
decided before the bar it acts on.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from wt.backtest.engine import EntrySignal
from wt.scanner.intraday import curve_at, rev_qualifies
from wt.signals.bars import PM_OPEN, RTH_OPEN, bucket_complete_at, et_minutes, resample_clock
from wt.signals.common import ema
from wt.signals.musts import first_minute_volume_ok, nearest_above, next_half_dollar_above, reward_risk_ok
from wt.signals.patterns import abcd, breakout_volume_ok, bull_flag, flat_top

TICK = 0.01


def idx_at(m: np.ndarray, minute: int) -> int:
    """First 1-minute index whose bar starts at or after `minute` (len(m) if none)."""
    return int(np.searchsorted(m, minute, side="left"))


def _ceiling(ctx: dict, trig: float) -> float | None:
    levels = list(ctx.get("overhead") or [])
    pmh = ctx.get("pm_high")
    if pmh is not None and pmh > trig:
        levels.append(pmh)
    return nearest_above(levels, trig)


def bv_1m(bars: pd.DataFrame, pm_bars: pd.DataFrame | None, n: int = 20, ratio: float = 2.0) -> dict:
    """PAT-08 on 1-minute bars: each bar is its own breakout bucket (complete at itself). Pre-market bars
    extend the 20-bar average at the open."""
    pv = pm_bars.v.to_numpy(float) if pm_bars is not None and len(pm_bars) else np.array([])
    v = np.r_[pv, bars.v.to_numpy(float)]
    off = len(pv)
    ok = np.array([breakout_volume_ok(v, off + i, n, ratio) for i in range(len(bars))])
    return {"complete": np.arange(len(bars)), "ok": ok}


def bv_5m(bars: pd.DataFrame, pm_bars: pd.DataFrame | None, n: int = 20, ratio: float = 2.0) -> dict:
    """PAT-08 on clock-aligned 5-minute buckets (pre-market buckets extend the average): for each RTH
    1-minute index, when its bucket completes (RTH index) and whether that bucket passes."""
    allb = pd.concat([pm_bars, bars], ignore_index=True) if pm_bars is not None and len(pm_bars) else bars.reset_index(drop=True)
    off = len(allb) - len(bars)
    b5, _ = resample_clock(allb, 5, anchor=PM_OPEN)
    done = bucket_complete_at(b5, allb, 5)
    vv = b5.v.to_numpy(float)
    ok_b = np.array([breakout_volume_ok(vv, k, n, ratio) for k in range(len(b5))])
    comp, ok = np.full(len(bars), -1), np.zeros(len(bars), bool)
    for k, r in b5.iterrows():
        lo, hi = max(int(r.first_i), off), int(r.last_i)
        if hi < off:
            continue
        d = done[k] - off if done[k] >= 0 else -1
        comp[lo - off: hi - off + 1] = d
        ok[lo - off: hi - off + 1] = ok_b[k]
    return {"complete": comp, "ok": ok}


# ---------------------------------------------------------------------------------------------- GG-1
def gg_level_break(bars: pd.DataFrame, ctx: dict, start: int = 0, window_end: int = 600, first_min_vol: float = 100_000,
                   stop_cap: float = 0.20, min_rr: float = 2.0) -> EntrySignal | None:
    """ENT-GG-1: at the 09:30 bar's close, rest a buy at the lowest pre-market level (PM pattern apex, PM high)
    the 09:30 bar has not already broken. Valid 09:31-10:00."""
    if start > 0 or len(bars) < 2:
        return None
    m = et_minutes(bars)
    if m[0] != RTH_OPEN or not first_minute_volume_ok(bars.v.iloc[0], first_min_vol):
        return None
    h0, l0 = float(bars.h.iloc[0]), float(bars.l.iloc[0])
    levels = []
    pat = ctx.get("pm_pattern")
    if pat is not None:
        levels.append(("pm_pattern", pat.trigger, pat.stop))
    if ctx.get("pm_high") is not None:
        levels.append(("pm_high", float(ctx["pm_high"]), None))
    unbroken = [x for x in levels if x[1] > h0 + 1e-9]
    if not unbroken:
        return None
    kind, lvl, pstop = min(unbroken, key=lambda x: x[1])
    trig = round(lvl + TICK, 4)
    base = pstop if pstop is not None else l0
    stop = round(max(base - TICK, trig - stop_cap), 4)
    if trig - stop < TICK or not reward_risk_ok(trig, stop, _ceiling(ctx, trig), min_rr):
        return None
    return EntrySignal(0, trig, stop, None, "GG-1", meta={"strict_collar": True, "expire_idx": idx_at(m, window_end), "level": kind,
                                                          "bv": bv_1m(bars, ctx.get("pm_bars"))})


# ---------------------------------------------------------------------------------------------- GG-2
def orb_ladder(bars: pd.DataFrame, ctx: dict, start: int = 0, orb5_end: int = 590, first_min_vol: float = 100_000,
               min_rr: float = 2.0) -> EntrySignal | None:
    """ENT-GG-2: 1-minute ORB valid on the 09:31 bar only (C9); if it doesn't trigger, a 5-minute ORB
    09:35-09:50 (C11). One attempt for the whole ladder."""
    if start > 0 or len(bars) < 2:
        return None
    m = et_minutes(bars)
    if m[0] != RTH_OPEN or not first_minute_volume_ok(bars.v.iloc[0], first_min_vol):
        return None
    h, l = bars.h.to_numpy(float), bars.l.to_numpy(float)
    trig1, stop1 = round(h[0] + TICK, 4), round(l[0] - TICK, 4)
    # the 1-minute ORB triggered on the 2nd candle, and its order passed the 2:1 check at 09:30. Without that room no
    # order rests, so the ladder goes on to the 5-minute ORB (it used to end the search: audit)
    if m[1] == RTH_OPEN + 1 and h[1] >= trig1 and reward_risk_ok(trig1, stop1, _ceiling(ctx, trig1), min_rr):
        return EntrySignal(0, trig1, stop1, None, "GG-2:orb_1m", meta={"strict_collar": True, "expire_idx": 2})
    first5 = m < RTH_OPEN + 5
    sig = int(np.nonzero(first5)[0][-1])
    exp = idx_at(m, orb5_end)
    if sig + 1 >= exp:
        return None
    trig5, stop5 = round(h[first5].max() + TICK, 4), round(l[first5].min() - TICK, 4)
    if not reward_risk_ok(trig5, stop5, _ceiling(ctx, trig5), min_rr):
        return None
    return EntrySignal(sig, trig5, stop5, None, "GG-2:orb_5m", meta={"strict_collar": True, "expire_idx": exp})


# ---------------------------------------------------------------------------------------------- GG-3
def continuation_5m(bars: pd.DataFrame, ctx: dict, start: int = 0, first: int = 590, last: int = 660,
                    fresh_after: int = 585, first_min_vol: float = 100_000, min_rr: float = 2.0) -> EntrySignal | None:
    """ENT-GG-3: a fresh 5-minute bull flag, flat top or ABCD completing 09:50-11:00 (C11). The consolidation
    begins at or after 09:45. One attempt."""
    if start > 0 or len(bars) < 25 or not first_minute_volume_ok(bars.v.iloc[0], first_min_vol):
        return None
    pm = ctx.get("pm_bars")
    allb = pd.concat([pm, bars], ignore_index=True) if pm is not None and len(pm) else bars.reset_index(drop=True)
    off = len(allb) - len(bars)
    b5, _ = resample_clock(allb, 5, anchor=PM_OPEN)
    done = bucket_complete_at(b5, allb, 5)
    e9 = ema(b5.c.to_numpy(float), 9)
    rth0 = int(np.nonzero(b5.start.to_numpy() >= RTH_OPEN)[0][0]) if (b5.start >= RTH_OPEN).any() else None
    if rth0 is None:
        return None
    m = et_minutes(bars)
    exp = idx_at(m, last)
    starts = b5.start.to_numpy()
    for k in range(rth0, len(b5)):
        end = int(b5.end.iloc[k])
        if end < first or end > last or done[k] < 0:
            continue
        sig = done[k] - off
        if sig < 0 or sig + 1 >= exp:
            continue
        pat = bull_flag(b5, k, ema_values=e9)
        cons_start = k - pat.meta["flag_bars"] + 1 if pat else None
        if pat is None:
            pat = flat_top(b5, k, ema_values=e9)
            cons_start = k - pat.meta["window_bars"] + 1 if pat else None
        if pat is None:
            pat = abcd(b5, k, start=rth0, ema_values=e9)
            cons_start = pat.meta["c_idx"] if pat else None
        if pat is None or starts[cons_start] < fresh_after:
            continue
        trig, stop = round(pat.trigger + TICK, 4), round(pat.stop - TICK, 4)
        if trig - stop < TICK or not reward_risk_ok(trig, stop, _ceiling(ctx, trig), min_rr):
            continue
        return EntrySignal(sig, trig, stop, None, f"GG-3:{pat.kind}",
                           meta={"strict_collar": True, "expire_idx": exp, "bv": bv_5m(bars, pm), "pattern": pat.meta})
    return None


# ---------------------------------------------------------------------------------------------- GG-4
def red_to_green(bars: pd.DataFrame, ctx: dict, start: int = 0, window_end: int = 600, first_min_vol: float = 100_000,
                 min_rr: float = 2.0) -> EntrySignal | None:
    """ENT-GG-4: after >= 1 close below the open, buy the first candle making a new high (above the prior candle's
    high) at or above the opening price. Stop = low of day. One attempt, 09:31-10:00."""
    if start > 0 or len(bars) < 3:
        return None
    m = et_minutes(bars)
    if m[0] != RTH_OPEN or not first_minute_volume_ok(bars.v.iloc[0], first_min_vol):
        return None
    o, h, l, c = (bars[k].to_numpy(float) for k in "ohlc")
    o0, exp = o[0], idx_at(m, window_end)
    was_below = False
    for j in range(1, min(len(bars), exp)):
        was_below = was_below or c[j - 1] < o0
        if not was_below:
            continue
        trig = round(max(o0, h[j - 1]) + TICK, 4)
        if h[j] >= trig:
            stop = round(l[:j].min() - TICK, 4)
            if trig - stop < TICK or not reward_risk_ok(trig, stop, _ceiling(ctx, trig), min_rr):
                continue            # this bar's order never rested; the next bar's may (it used to end the search: audit)
            return EntrySignal(j - 1, trig, stop, None, "GG-4", meta={"strict_collar": True, "expire_idx": j + 1})
    return None


# ---------------------------------------------------------------------------------------------- MP-1
def _atr1m(h: np.ndarray, l: np.ndarray, c: np.ndarray, n: int = 14) -> np.ndarray:
    tr = np.maximum(h - l, np.abs(np.r_[h[0], h[1:]] - np.r_[c[0], c[:-1]]))
    tr = np.maximum(tr, np.abs(np.r_[l[0], l[1:]] - np.r_[c[0], c[:-1]]))
    return pd.Series(tr).rolling(n, min_periods=1).mean().to_numpy()


def micro_pullback_1m(bars: pd.DataFrame, ctx: dict, start: int = 0, vol_min: float = 1_000_000,
                      body_max_of_prior_range: float = 0.5, wick_min_body: float = 2.0, fresh_hod_bars: int = 3,
                      near_atr: float = 0.5, expiry_bars: int = 2, min_rr: float = 2.0) -> EntrySignal | None:
    """ENT-MP-1 (1-minute fallback, C10): in the MP universe (ctx["mp_mask"]), a single small red candle or a
    bottom-wick candle within 3 bars of a new HOD, near EMA9/EMA20. Trigger = its high; stop = its low;
    target = next half/whole dollar, which must be >= 2R away. Entry valid for 2 bars."""
    mask = ctx.get("mp_mask")
    if mask is None or not mask.any():
        return None
    o, h, l, c, v = (bars[k].to_numpy(float) for k in "ohlcv")
    pm = ctx.get("pm_bars")
    pc = pm.c.to_numpy(float) if pm is not None and len(pm) else np.array([])
    e9 = ema(np.r_[pc, c], 9)[len(pc):]
    e20 = ema(np.r_[pc, c], 20)[len(pc):]
    atr = _atr1m(h, l, c)
    cum = np.cumsum(v)
    hod_prev = np.maximum.accumulate(np.r_[-np.inf, h[:-1]])
    for i in range(max(start, 1), len(bars) - 1):
        if not mask[i] or cum[i] < vol_min:
            continue
        if not any(h[k] >= hod_prev[k] for k in range(max(0, i - fresh_hod_bars), i)):
            continue
        if h[i] > hod_prev[i]:                                    # the pullback candle itself is below the high
            continue
        body, prior_rng = abs(c[i] - o[i]), h[i - 1] - l[i - 1]
        red_small = c[i] < o[i] and body <= body_max_of_prior_range * prior_rng
        wick = (min(o[i], c[i]) - l[i]) >= wick_min_body * max(body, TICK)
        if not (red_small or wick):
            continue
        if min(abs(l[i] - e9[i]), abs(l[i] - e20[i])) > near_atr * atr[i]:
            continue
        trig, stop = round(h[i] + TICK, 4), round(l[i] - TICK, 4)
        tgt = next_half_dollar_above(trig)
        if trig - stop < TICK or not reward_risk_ok(trig, stop, tgt, min_rr):
            continue
        return EntrySignal(i, trig, stop, tgt, "MP-1",
                           meta={"strict_collar": True, "expire_idx": i + 1 + expiry_bars, "bv": bv_1m(bars, pm)})
    return None


# ---------------------------------------------------------------------------------------------- REV-1
def reversal_long(bars: pd.DataFrame, ctx: dict, start: int = 0, window=(575, 930), min_target_usd: float = 0.30,
                  min_rr: float = 2.0) -> EntrySignal | None:
    """ENT-REV-1: at a completed 5-minute bucket where SCN-REV holds, rest a buy at that bucket's high for the next
    5 minutes (candle-over-candle). Stop = low of day. Target = EMA9(5m) at the signal, >= $0.30 and >= 2R."""
    prev = ctx.get("prev_rth")
    if prev is None or len(prev) < 60 or len(bars) < 10:
        return None
    p5, _ = resample_clock(prev, 5)
    p2, _ = resample_clock(prev, 2)
    t5, _ = resample_clock(bars, 5)
    t2, _ = resample_clock(bars, 2)
    done5 = bucket_complete_at(t5, bars, 5)
    m = et_minutes(bars)
    cum = np.cumsum(bars.v.to_numpy(float))
    l = bars.l.to_numpy(float)
    for k in range(len(t5)):
        end = int(t5.end.iloc[k])
        sig = int(done5[k])
        if sig < max(start, 0) or not (window[0] <= end <= window[1]):
            continue
        two = t2[t2.end <= end]
        ok, info = rev_qualifies(p5, t5, k, p2.c.to_numpy(float), two, cum[sig], ctx.get("adv5", 0.0),
                                 ctx.get("adv20", 0.0), float(curve_at(m[sig], ctx.get("curve"))))
        if not ok:
            continue
        trig = round(float(t5.h.iloc[k]) + TICK, 4)
        stop = round(float(l[: sig + 1].min()) - TICK, 4)
        tgt = info["ema9_5m"]
        risk = trig - stop
        if risk < TICK or tgt - trig < max(min_target_usd, min_rr * risk):
            continue
        return EntrySignal(sig, trig, stop, round(tgt, 4), "REV-1", meta={"strict_collar": True, "expire_idx": idx_at(m, end + 5)})
    return None


SETUPS = {"GG-1": gg_level_break, "GG-2": orb_ladder, "GG-3": continuation_5m, "GG-4": red_to_green,
          "MP-1": micro_pullback_1m, "REV-1": reversal_long}
ATTEMPTS = {"GG-1": 1, "GG-2": 1, "GG-3": 1, "GG-4": 1, "MP-1": 2, "REV-1": 2}
