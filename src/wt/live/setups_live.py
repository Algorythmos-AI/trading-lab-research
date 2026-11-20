"""Sleeve S: the registered reversal rule (HYP-0019's entry and exit, traded by HYP-0070), read live.

The batch simulation sees a whole day at once: it finds a signal, then lets `wt.backtest.engine.simulate` decide
whether the entry fills and how the trade ends. A live runner sees one closed bar at a time and has to carry those
engine rules itself. This module is those rules as small pure functions over closed bars, so the runner and the
tests share one statement of each:

  signal      `wt.signals.spec_setups.reversal_long`, unchanged, acted on only when it forms on the newest closed bar;
  the order   a buy stop-limit at the trigger with a limit 10% of R above it (the strict collar), valid until five
              minutes after the signal's five-minute bucket ended;
  no order    the spread at the signal is unknown or over US$0.05, or the collar is narrower than the slippage the
              simulation charges (it never fills such an entry, so the desk does not send one);
  cancelled   a bar after the signal trades under the stop before the entry fills, or reaches the trigger without
              filling the order (the simulation's "gapped through the collar": no trade), or the order expires;
  exit        all shares at the target fixed at the signal; the stagnation stop (under +0.5R once five minutes
              have passed); the protective stop at the low of the day when the signal formed.

A name gets two attempts a day. An attempt that is refused for its spread, or whose order does not fill, ends the
name for the day, as in `scripts/r3_intraday.py chains`. Nothing here places an order or reads a clock.

The registered gap entries (ENT-GG-1 to ENT-GG-4, traded by HYP-0071 in the day's primary name) are here too, under
the neutral codes e1 to e4. The batch detectors (`wt.signals.spec_setups`) read a whole day: they find an order's
expiry by bar index, skip a signal on the newest bar, and two of them decide a signal by looking at the bar it would
fill on. A live desk has closed bars and a clock. So each rule is restated as a function of the closed bars and the
minute in progress that answers one question: which order of this rule should be resting right now, if any.

  e1  from the 09:30 bar's close: a buy over the lowest pre-market level that bar left unbroken, until 10:00;
  e2  the 09:30 bar's high for the 09:31 minute only; then, from 09:35, the first five minutes' high until 09:50;
  e3  from 09:50: the first completed five-minute pattern (flag, flat top, ABCD), until 11:00;
  e4  once a bar has closed under the open: over the newest closed bar's high (never under the open), re-priced at
      every bar, until 10:00.

A rule's order is gone once a closed bar after its signal reached its trigger (it filled, or it never will), or
traded under its stop first, or its window ended. `gap_walk` is the batch outcome read this way, bar by bar, with
the engine's own fill arithmetic; tests/unit/test_gap_live.py holds each rule to the batch detector and the engine.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from wt.backtest.engine import EntrySignal
from wt.backtest.management import ema as _engine_ema
from wt.core.clock import ET
from wt.signals.bars import PM_OPEN, RTH_OPEN, bucket_complete_at, et_minutes, resample_clock
from wt.signals.common import ema
from wt.signals.musts import first_minute_volume_ok, nearest_above, reward_risk_ok, spread_ok
from wt.signals.patterns import Pattern, abcd, bull_flag, flat_top
from wt.signals.setups import TICK
from wt.signals.spec_setups import ATTEMPTS, bv_1m, bv_5m, reversal_long

TRIAL = "HYP-0070"
MAX_ATTEMPTS = ATTEMPTS["REV-1"]
COLLAR_FRAC_OF_R = 0.10          # wt.backtest.engine.Costs.collar_frac_of_R
MIN_SLIP = 0.01                  # scripts/r3_intraday.py: slippage = max(1 cent, half the spread)
ORDER_LIFE_MIN = 5               # the entry rests until five minutes after its bucket ended
STAGNATION_MIN = 5               # wt.backtest.management.MeanRevert5
STAGNATION_R = 0.5
PREV_MIN_BARS = 60               # reversal_long needs this much of the prior session to warm its indicators up


def rev_context(prev_rth: pd.DataFrame, daily_volumes: list[float], curve: np.ndarray) -> dict[str, Any]:
    """What `reversal_long` reads besides today's bars. `daily_volumes`: the prior sessions' volumes, oldest first,
    on today's share basis."""
    v = [float(x) for x in daily_volumes if x is not None and np.isfinite(x)]
    return {"prev_rth": prev_rth, "curve": curve,
            "adv5": float(np.mean(v[-5:])) if v else 0.0, "adv20": float(np.mean(v[-20:])) if v else 0.0}


def first_index_after(bars: pd.DataFrame, t: Any, inclusive: bool = False) -> int:
    """Index of the first bar that starts after `t` (or at it, if inclusive); len(bars) when there is none."""
    ts = pd.to_datetime(bars.t, utc=True)
    at = pd.Timestamp(t).tz_convert("UTC")
    return int(((ts < at) if inclusive else (ts <= at)).sum())


def fresh_signal(bars: pd.DataFrame, ctx: dict[str, Any], start: int) -> tuple[EntrySignal | None, bool]:
    """(signal, fresh). The first signal from bar `start` on, and whether it formed on the newest closed bar. A
    signal on an older bar was missed (a data gap, a late start): it is reported and never acted on."""
    if len(bars) <= start:
        return None, False
    sig = reversal_long(bars.reset_index(drop=True), ctx, start=start)
    if sig is None:
        return None, False
    return sig, sig.bar_index == len(bars) - 1


def bucket_end_minute(bars: pd.DataFrame, sig: EntrySignal) -> int:
    """The minute of day at which the signal's five-minute bucket ended."""
    t5, _ = resample_clock(bars, 5)
    done = bucket_complete_at(t5, bars, 5)
    hits = [k for k in range(len(t5)) if int(done[k]) == sig.bar_index
            and abs(round(float(t5.h.iloc[k]) + TICK, 4) - sig.trigger) < 1e-9]
    if not hits:
        m = int(et_minutes(bars)[sig.bar_index])
        return RTH_OPEN + ((m - RTH_OPEN) // 5 + 1) * 5
    return int(t5.end.iloc[hits[-1]])


@dataclass(frozen=True)
class Staged:
    """One entry the desk may rest: every price on the cent grid."""
    symbol: str
    attempt: int                 # 1 or 2
    signal_t: pd.Timestamp       # start of the bar the signal formed on
    trigger: float
    limit: float
    stop: float
    target: float
    expires_at: dt.datetime      # the order is cancelled at this time if it has not filled
    spread: float

    @property
    def risk(self) -> float:
        return self.trigger - self.stop


def stage(symbol: str, attempt: int, sig: EntrySignal, bars: pd.DataFrame, day: dt.date,
          spread: float | None) -> tuple[Staged | None, str]:
    """(order, "") or (None, why not). `spread`: the NBBO spread at the signal in dollars, None when unknown."""
    if not spread_ok(spread):
        return None, "spread"
    assert spread is not None
    trigger = math.ceil(round(sig.trigger * 100, 6)) / 100
    stop = math.floor(round(sig.stop * 100, 6)) / 100
    risk = trigger - stop
    if risk < 2 * TICK - 1e-9 or sig.target is None:
        return None, "risk"
    limit = math.floor(round((trigger + COLLAR_FRAC_OF_R * risk) * 100, 6)) / 100
    if trigger + max(MIN_SLIP, spread / 2) > limit + 1e-9:
        return None, "collar"                  # the simulation never fills this entry (strict collar, D38)
    end = bucket_end_minute(bars, sig) + ORDER_LIFE_MIN
    expires = dt.datetime.combine(day, dt.time(end // 60, end % 60), tzinfo=ET)
    return Staged(symbol, attempt, pd.Timestamp(bars.t.iloc[sig.bar_index]), round(trigger, 2), round(limit, 2),
                  round(stop, 2), round(float(sig.target), 2), expires, float(spread)), ""


def entry_verdict(bars: pd.DataFrame, s: Staged, filled_qty: int, now: dt.datetime) -> str | None:
    """Why a resting entry must be cancelled now, or None while it may keep resting. Read from closed bars after
    the signal bar, oldest first, in the simulation's order on each bar: the trigger before the stop."""
    after = bars[pd.to_datetime(bars.t, utc=True) > s.signal_t]
    for bar in after.itertuples():
        if float(bar.h) >= s.trigger - 1e-9:
            # the bar that reached the trigger has closed: what filled is the trade; nothing may fill later
            return "partial_fill" if filled_qty else "no_fill"
        if float(bar.l) < s.stop - 1e-9:
            return "stop_traded_first"
    if now >= s.expires_at:
        return "expired"
    return None


def entry_bar_time(bars: pd.DataFrame, s: Staged) -> pd.Timestamp | None:
    """Start of the bar the entry filled on: the first closed bar after the signal that reached the trigger. None
    until that bar has closed. Read from the bars, never from the time a poll noticed the fill, so it is the bar
    the simulation enters on and it survives a restart."""
    after = bars[pd.to_datetime(bars.t, utc=True) > s.signal_t]
    hit = after[after.h.astype(float) >= s.trigger - 1e-9]
    return pd.Timestamp(hit.t.iloc[0]) if len(hit) else None


def target_price(staged_target: float, entry: float, stop: float) -> float:
    """The exit target: the one fixed at the signal, or 2R above the fill if the fill came in over it."""
    return round(staged_target if staged_target > entry else entry + 2.0 * (entry - stop), 2)


def stagnant(bars: pd.DataFrame, entry_t: Any, entry: float, stop: float) -> bool:
    """The stagnation stop, asked at the close of the newest bar: at least five minutes since the entry bar began,
    and the close under +0.5R. Never on the entry bar itself."""
    if not len(bars) or entry <= stop:
        return False
    entry_bar = pd.Timestamp(entry_t).tz_convert("UTC").floor("min")
    last_t = pd.Timestamp(bars.t.iloc[-1]).tz_convert("UTC")
    if last_t <= entry_bar:
        return False
    minutes = (last_t - entry_bar).total_seconds() / 60 + 1
    return minutes >= STAGNATION_MIN and float(bars.c.iloc[-1]) - entry < STAGNATION_R * (entry - stop)


@dataclass
class NameState:
    """One universe name's day."""
    start_t: pd.Timestamp        # signals are read from the first bar at or after this time
    inclusive: bool = True       # False after a trade: from the bar after the one it exited on
    attempts: int = 0            # entries that filled
    done: str = ""               # why the name is finished for the day ("" while it is live)

    def start_index(self, bars: pd.DataFrame) -> int:
        return first_index_after(bars, self.start_t, inclusive=self.inclusive)

    def after_trade(self, exit_t: Any) -> None:
        self.attempts += 1
        if self.attempts >= MAX_ATTEMPTS:
            self.done = "attempts"
        self.start_t, self.inclusive = pd.Timestamp(exit_t).tz_convert("UTC").floor("min"), False


# ---- the registered gap exit, one closed bar at a time ----------------------------------------------------------------
# wt.backtest.management.WT ("SPEC-0001 EXT-01..06"), as the engine applies it bar by bar:
#   stop first; a failed breakout bar exits at the next open; then, on bars after the entry bar, the first target
#   sells half (the whole position when it is under two shares) and moves the stop to breakeven; before that target
#   the stagnation stop applies; after it the stop trails the low of each completed five-minute bucket and a
#   five-minute close under EMA9 exits at the next open.
WT_TARGET_R = 2.0
EMA_N = 9


@dataclass
class WTState:
    """What the gap exit remembers between bars. `stop` is where the protective stop should rest now."""
    entry: float
    stop0: float                 # the stop at entry: R is measured against it
    qty0: int
    t1: float                    # the first target
    entry_bar: pd.Timestamp      # start of the bar the entry filled on
    stop: float
    partial_done: bool = False
    last_bucket: int = -1        # the last completed five-minute bucket already applied
    stop_reason: str = "stop"    # what a stop-out is called: the engine renames it once the stop has trailed
    bv_fail: bool = False        # the breakout bar failed its volume check: out at the next open
    bv_bar: pd.Timestamp | None = None   # the bar at whose close that check is known (None: the entry bar)

    @property
    def risk(self) -> float:
        return self.entry - self.stop0

    @property
    def t1_price(self) -> float:
        """The first target as an order price: on the cent grid, never under the target itself."""
        return math.ceil(round(self.t1 * 100, 6)) / 100

    @property
    def partial_qty(self) -> int:
        """Shares the first target sells: half, or everything when the position is under two shares."""
        return self.qty0 if self.qty0 < 2 else self.qty0 // 2


def wt_start(entry: float, stop0: float, qty0: int, entry_bar: Any, signal_target: float | None,
             bv_fail: bool = False, bv_bar: Any = None) -> WTState:
    risk = entry - stop0
    t1 = signal_target if signal_target and signal_target > entry else entry + WT_TARGET_R * risk
    # t1 is kept exactly as the engine computes it (entry + 2 x (entry - stop), unrounded): the engine compares a
    # bar's high with that number, and a rounded copy would call a touch one bar sooner or later than it does
    return WTState(entry=entry, stop0=stop0, qty0=int(qty0), t1=float(t1),
                   entry_bar=pd.Timestamp(entry_bar).tz_convert("UTC").floor("min"), stop=stop0, bv_fail=bv_fail,
                   bv_bar=None if bv_bar is None else pd.Timestamp(bv_bar).tz_convert("UTC").floor("min"))


@dataclass(frozen=True)
class WTAction:
    """One thing the gap exit asks for at the close of the newest bar.
    kind: "exit" (the whole position, at the market, at the next open), "partial" (sell `qty` at `price` or
    better: the first target), or "stop" (raise the resting stop to `price`)."""
    kind: str
    reason: str
    qty: int = 0
    price: float = 0.0


def _ema(values: np.ndarray, n: int) -> np.ndarray:
    """The exit engine's own EMA (wt.backtest.management.ema), not an algebraically equal form: with equal closes
    the two differ in the last bit, and a close exactly on the EMA must exit in both or in neither."""
    return _engine_ema(np.asarray(values, float), n)


def wt_on_partial(s: WTState) -> WTAction:
    """The first target has sold: the stop goes to breakeven."""
    s.partial_done = True
    s.stop = max(s.stop, s.entry)
    return WTAction("stop", "breakeven", price=round(s.stop, 4))


def wt_step(bars: pd.DataFrame, s: WTState, warm_c5: list[float] | None = None) -> list[WTAction]:
    """What the exit asks for at the close of the newest closed bar, in the engine's order. `bars`: the session's
    closed bars. The stop itself rests at the broker and the first target is a price to sell at, so neither is
    decided here; this is everything else. The state is advanced as the engine advances its own."""
    if not len(bars):
        return []
    last_t = pd.Timestamp(bars.t.iloc[-1]).tz_convert("UTC")
    if last_t < s.entry_bar:
        return []
    if s.bv_fail and last_t == (s.entry_bar if s.bv_bar is None else s.bv_bar):
        return [WTAction("exit", "breakout_volume_fail")]     # before the target and the rule exits, as the engine
    if last_t == s.entry_bar:
        return []                                             # targets and rule exits start on the bar after entry
    if not s.partial_done:
        return [WTAction("exit", f"time_stop_{STAGNATION_MIN}m")] if stagnant(bars, s.entry_bar, s.entry, s.stop0) else []
    b5, done = resample_clock(bars, 5)
    k = int(done[-1])
    if k < 0 or k == s.last_bucket:
        return []
    s.last_bucket = k
    s.stop_reason = "runner_prior_5m_low"
    out: list[WTAction] = []
    low = float(b5.l.iloc[k])
    if low > s.stop + 1e-9:
        s.stop = low
        out.append(WTAction("stop", "runner_prior_5m_low", price=round(low, 4)))
    warm = np.asarray(warm_c5 or [], float)
    e5 = _ema(np.r_[warm, b5.c.to_numpy(float)], EMA_N)[len(warm):]
    if float(b5.c.iloc[k]) < float(e5[k]):
        out.append(WTAction("exit", "runner_5m_close_below_ema9"))
    return out


# ---- the registered gap entries, one closed bar at a time -------------------------------------------------------------
GAP_TRIAL = "HYP-0071"
GAP_CODES = ("e1", "e2", "e3", "e4")       # ENT-GG-1 .. ENT-GG-4; a journal row or a page carries the code only
GAP_FIRST_MIN_VOL = 100_000.0
GAP_MIN_RR = 2.0
E1_END, E1_STOP_CAP = 600, 0.20            # ENT-GG-1: until 10:00; the stop is at most 20 cents under the trigger
E2_ONE_MIN, E2_FIVE_FROM, E2_FIVE_END = RTH_OPEN + 1, RTH_OPEN + 5, 590
E3_FIRST, E3_LAST, E3_FRESH_AFTER = 590, 660, 585
E4_END = 600
GAP_LAST_MINUTE = max(E1_END, E2_FIVE_END, E3_LAST, E4_END)     # no gap entry rests at or after this minute


@dataclass(frozen=True)
class GapOrder:
    """The order one gap entry rule wants resting now. Prices are the batch signal's own (four decimals)."""
    code: str                    # e1..e4
    trigger: float
    stop: float
    signal_i: int                # index of the closed bar the batch detector calls the signal bar
    valid_until: int             # minute of day: the order may fill only on a bar that starts before it
    one_bar: bool = False        # re-decided at every bar: it rests for the minute in progress only
    bv: str = ""                 # the breakout-volume check its fill carries: "1m", "5m" or none

    @property
    def risk(self) -> float:
        return self.trigger - self.stop


def gap_context(row: Any, pm_bars: pd.DataFrame | None) -> dict[str, Any]:
    """What the gap entries read besides today's bars, from the primary's row of the 09:25 pool and its pre-market
    minute bars: the same dictionary `scripts/r3_run.py ctx_for` builds (a test holds the two together)."""
    def get(key: str) -> Any:
        return row.get(key) if hasattr(row, "get") else getattr(row, key, None)

    def num(v: Any) -> float | None:
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if math.isfinite(f) else None

    pat = None
    kind, trig, stop = get("pm_pattern"), num(get("pm_pattern_trigger")), num(get("pm_pattern_stop"))
    if isinstance(kind, str) and trig is not None and stop is not None:
        pat = Pattern(kind, trig, stop, -1, trig)
    levels = get("overhead_levels")
    overhead = [] if levels is None or isinstance(levels, (int, float, str)) else [float(x) for x in levels]
    pm = pm_bars if pm_bars is not None else pd.DataFrame(columns=["t", "o", "h", "l", "c", "v"])
    return {"pm_high": num(get("pm_high")), "pm_pattern": pat, "pm_bars": pm.reset_index(drop=True),
            "overhead": overhead}


def _ceiling(ctx: dict[str, Any], trig: float) -> float | None:
    """The nearest level over the trigger: daily overhead levels and the pre-market high (spec_setups._ceiling)."""
    levels = list(ctx.get("overhead") or [])
    pmh = ctx.get("pm_high")
    if pmh is not None and pmh > trig:
        levels.append(pmh)
    return nearest_above(levels, trig)


def _room(ctx: dict[str, Any], trig: float, stop: float) -> bool:
    return bool(reward_risk_ok(trig, stop, _ceiling(ctx, trig), GAP_MIN_RR))


def _opened(bars: pd.DataFrame, m: np.ndarray) -> bool:
    """The session's first bar is the 09:30 bar and it traded the first-minute volume."""
    return bool(len(bars) and int(m[0]) == RTH_OPEN and first_minute_volume_ok(float(bars.v.iloc[0]), GAP_FIRST_MIN_VOL))


def _still(order: GapOrder, bars: pd.DataFrame, m: np.ndarray, now_min: int) -> GapOrder | None:
    """The order, if it should still rest: no closed bar after its signal has reached its trigger (then it filled or
    it never will), none traded under its stop first, and its window is open. The engine's entry loop, bar by bar."""
    h, low = bars.h.to_numpy(float), bars.l.to_numpy(float)
    for k in range(order.signal_i + 1, len(bars)):
        if int(m[k]) >= order.valid_until or h[k] >= order.trigger or low[k] < order.stop:
            return None
    return order if now_min < order.valid_until else None


def gap_e1(bars: pd.DataFrame, ctx: dict[str, Any], now_min: int,
           m: np.ndarray | None = None) -> GapOrder | None:
    """ENT-GG-1 (`gg_level_break`): over the lowest pre-market level the 09:30 bar left unbroken."""
    m = et_minutes(bars) if m is None else m
    if not _opened(bars, m):
        return None
    h0, l0 = float(bars.h.iloc[0]), float(bars.l.iloc[0])
    levels: list[tuple[float, float | None]] = []
    pat = ctx.get("pm_pattern")
    if pat is not None:
        levels.append((float(pat.trigger), float(pat.stop)))
    if ctx.get("pm_high") is not None:
        levels.append((float(ctx["pm_high"]), None))
    unbroken = [x for x in levels if x[0] > h0 + 1e-9]
    if not unbroken:
        return None
    lvl, pstop = min(unbroken, key=lambda x: x[0])
    trig = round(lvl + TICK, 4)
    stop = round(max((pstop if pstop is not None else l0) - TICK, trig - E1_STOP_CAP), 4)
    if trig - stop < TICK or not _room(ctx, trig, stop):
        return None
    return _still(GapOrder("e1", trig, stop, 0, E1_END, bv="1m"), bars, m, now_min)


def gap_e2(bars: pd.DataFrame, ctx: dict[str, Any], now_min: int,
           m: np.ndarray | None = None) -> GapOrder | None:
    """ENT-GG-2 (`orb_ladder`): the 09:30 bar's high, for the 09:31 minute only; if that order did not trigger (or
    had no 2:1 room), the first five minutes' high from 09:35 to 09:50. The batch detector learns whether the
    one-minute order triggered by reading the 09:31 bar; here the order simply rests for that minute."""
    m = et_minutes(bars) if m is None else m
    if not _opened(bars, m):
        return None
    h, low = bars.h.to_numpy(float), bars.l.to_numpy(float)
    trig1, stop1 = round(h[0] + TICK, 4), round(low[0] - TICK, 4)
    if _room(ctx, trig1, stop1):
        if len(bars) == 1 and now_min == E2_ONE_MIN:
            return GapOrder("e2", trig1, stop1, 0, E2_ONE_MIN + 1, one_bar=True)
        if len(bars) > 1 and int(m[1]) == E2_ONE_MIN and h[1] >= trig1:
            return None                                        # it triggered: the ladder's one attempt is spent
    if now_min < E2_FIVE_FROM:
        return None
    first5 = m < E2_FIVE_FROM
    sig = int(np.nonzero(first5)[0][-1])
    trig5, stop5 = round(float(h[first5].max()) + TICK, 4), round(float(low[first5].min()) - TICK, 4)
    if not _room(ctx, trig5, stop5):
        return None
    return _still(GapOrder("e2", trig5, stop5, sig, E2_FIVE_END), bars, m, now_min)


def gap_e3(bars: pd.DataFrame, ctx: dict[str, Any], now_min: int,
           m: np.ndarray | None = None) -> GapOrder | None:
    """ENT-GG-3 (`continuation_5m`): the first five-minute bull flag, flat top or ABCD that completes between 09:50
    and 11:00 with its consolidation starting at or after 09:45. The rule has one signal a day: the first."""
    if now_min < E3_FIRST or not len(bars) or not first_minute_volume_ok(float(bars.v.iloc[0]), GAP_FIRST_MIN_VOL):
        return None
    pm = ctx.get("pm_bars")
    allb = pd.concat([pm, bars], ignore_index=True) if pm is not None and len(pm) else bars.reset_index(drop=True)
    off = len(allb) - len(bars)
    b5, _ = resample_clock(allb, 5, anchor=PM_OPEN)
    starts = b5.start.to_numpy()
    rth = np.nonzero(starts >= RTH_OPEN)[0]
    if not len(rth):
        return None
    rth0 = int(rth[0])
    done = bucket_complete_at(b5, allb, 5)
    e9 = ema(b5.c.to_numpy(float), 9)
    ends = b5.end.to_numpy()
    for k in range(rth0, len(b5)):
        end = int(ends[k])
        if end < E3_FIRST or end > E3_LAST or done[k] < 0:
            continue
        sig = int(done[k]) - off
        if sig < 0:
            continue
        pat = bull_flag(b5, k, ema_values=e9)
        cons_start = k - pat.meta["flag_bars"] + 1 if pat else None
        if pat is None:
            pat = flat_top(b5, k, ema_values=e9)
            cons_start = k - pat.meta["window_bars"] + 1 if pat else None
        if pat is None:
            pat = abcd(b5, k, start=rth0, ema_values=e9)
            cons_start = pat.meta["c_idx"] if pat else None
        if pat is None or cons_start is None or starts[cons_start] < E3_FRESH_AFTER:
            continue
        trig, stop = round(pat.trigger + TICK, 4), round(pat.stop - TICK, 4)
        if trig - stop < TICK or not _room(ctx, trig, stop):
            continue
        return _still(GapOrder("e3", trig, stop, sig, E3_LAST, bv="5m"), bars,
                      et_minutes(bars) if m is None else m, now_min)
    return None


def gap_e4(bars: pd.DataFrame, ctx: dict[str, Any], now_min: int,
           m: np.ndarray | None = None) -> GapOrder | None:
    """ENT-GG-4 (`red_to_green`): once a bar has closed under the opening price, a buy over the newest closed bar's
    high, never under the open, with the stop under the low of the day. Re-priced at every bar until 10:00. The
    batch detector names the bar that triggered; here the order rests one bar ahead of it."""
    m = et_minutes(bars) if m is None else m
    if not _opened(bars, m):
        return None
    o, h, low, c = (bars[k].to_numpy(float) for k in "ohlc")
    o0, n, was_below = float(o[0]), len(bars), False
    for j in range(1, n + 1):                                  # j: the bar that the order made at bar j-1's close acts on
        was_below = was_below or bool(c[j - 1] < o0)
        if j < n and int(m[j]) >= E4_END:
            return None
        if not was_below:
            continue
        trig = round(max(o0, float(h[j - 1])) + TICK, 4)
        stop = round(float(low[:j].min()) - TICK, 4)
        rests = trig - stop >= TICK and _room(ctx, trig, stop)
        if j == n:
            return GapOrder("e4", trig, stop, j - 1, E4_END, one_bar=True) if rests and now_min < E4_END else None
        if rests and h[j] >= trig:
            return None                                        # that order triggered: the rule's one attempt is spent
    return None


GAP_RULES = {"e1": gap_e1, "e2": gap_e2, "e3": gap_e3, "e4": gap_e4}


def gap_orders(bars: pd.DataFrame, ctx: dict[str, Any], now_min: int, codes: tuple[str, ...] = GAP_CODES,
               m: np.ndarray | None = None) -> list[GapOrder]:
    """Every rule's order that should rest during minute `now_min`, from the session's closed bars (all of them
    started before that minute). Nothing before the 09:30 bar has closed, nothing from 11:00. `m`: the bars'
    minutes of day, when the caller already has them."""
    if not len(bars) or now_min >= GAP_LAST_MINUTE:
        return []
    b = bars.reset_index(drop=True)
    m = et_minutes(b) if m is None else m
    out = [GAP_RULES[code](b, ctx, now_min, m) for code in codes]
    return [x for x in out if x is not None]


def gap_choose(orders: list[GapOrder]) -> GapOrder | None:
    """The one order that may rest: the lowest trigger among the valid ones, the first a rising price reaches
    (DEC-0068, note of 2026-11-20). Ties go to the lower rule number."""
    return min(orders, key=lambda x: (x.trigger, x.code)) if orders else None


def engine_entry(order: GapOrder, bar_open: float, slip: float) -> float | None:
    """The entry price `wt.backtest.engine.simulate` gives a bar that reached the trigger, or None when it gives no
    fill: the bar opened over the collar, or the expected fill is beyond it (the strict collar)."""
    limit = order.trigger + COLLAR_FRAC_OF_R * order.risk
    if bar_open > limit:
        return None
    want = max(order.trigger, bar_open) + slip
    if want > limit + 1e-9:
        return None
    return float(min(want, limit))


@dataclass(frozen=True)
class GapAttempt:
    """The bar that first reached the resting order's trigger: the day's one attempt."""
    bar_i: int
    order: GapOrder
    fill: float | None           # the engine's entry price; None when the engine gives no fill


def gap_walk(bars: pd.DataFrame, ctx: dict[str, Any], codes: tuple[str, ...] = GAP_CODES, slip: float = MIN_SLIP,
             start: int = 0, last_bar: int | None = None,
             seen: set[str] | None = None) -> GapAttempt | None:
    """The day read as the desk reads it: at each bar's close the lowest valid order rests for the next bar, and
    the first bar to reach it is the attempt. `start`: the first bar index whose close is decided on (bars before
    it were walked already). `last_bar`: no entry on a bar at or after this index (the end-of-day flatten).
    `seen` collects the codes that had a valid order at any time."""
    b = bars.reset_index(drop=True)
    m = et_minutes(b) if len(b) else np.array([], int)
    o, h = b.o.to_numpy(float), b.h.to_numpy(float)
    stop_at = len(b) if last_bar is None else min(len(b), last_bar)
    for i in range(max(start, 0), stop_at - 1):
        nxt = int(m[i + 1])
        if nxt >= GAP_LAST_MINUTE:
            break
        orders = gap_orders(b.iloc[: i + 1], ctx, nxt, codes, m[: i + 1])
        if seen is not None:
            seen.update(x.code for x in orders)
        order = gap_choose(orders)
        if order is not None and h[i + 1] >= order.trigger:
            return GapAttempt(i + 1, order, engine_entry(order, float(o[i + 1]), slip))
    return None


def gap_bv(kind: str, bars: pd.DataFrame, pm_bars: pd.DataFrame | None, entry_i: int) -> tuple[int, bool] | None:
    """The breakout-volume check of an entry filled on bar `entry_i`: (the bar at whose close it is known, whether
    it failed). None while it is not known yet, and for an entry that carries none. `bars`: closed bars."""
    if kind not in ("1m", "5m") or entry_i >= len(bars):
        return None
    info = (bv_1m if kind == "1m" else bv_5m)(bars.reset_index(drop=True), pm_bars)
    at = int(info["complete"][entry_i])
    return None if at < 0 else (at, not bool(info["ok"][entry_i]))


def gap_cents(order: GapOrder) -> tuple[float, float]:
    """(trigger, stop) on the cent grid: the trigger never under the rule's, the stop never over it."""
    return (round(math.ceil(round(order.trigger * 100, 6)) / 100, 2),
            round(math.floor(round(order.stop * 100, 6)) / 100, 2))


def gap_stage(symbol: str, attempt: int, order: GapOrder, bars: pd.DataFrame, day: dt.date, spread: float | None,
              now_min: int) -> tuple[Staged | None, str]:
    """(the order on the cent grid, "") or (None, why not): the spread must, at least two cents of risk, and a
    collar wide enough for the slippage the simulation charges. A one-bar order is cancelled when the minute it
    was decided for ends; the others when their window does."""
    if not spread_ok(spread):
        return None, "spread"
    assert spread is not None
    trigger, stop = gap_cents(order)
    risk = trigger - stop
    if risk < 2 * TICK - 1e-9:
        return None, "risk"
    limit = math.floor(round((trigger + COLLAR_FRAC_OF_R * risk) * 100, 6)) / 100
    if trigger + max(MIN_SLIP, spread / 2) > limit + 1e-9:
        return None, "collar"
    end = min(now_min + 1, order.valid_until) if order.one_bar else order.valid_until
    expires = dt.datetime.combine(day, dt.time(end // 60, end % 60), tzinfo=ET)
    return Staged(symbol, attempt, pd.Timestamp(bars.t.iloc[order.signal_i]), round(trigger, 2), round(limit, 2),
                  round(stop, 2), 0.0, expires, float(spread)), ""
