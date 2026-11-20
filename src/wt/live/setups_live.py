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
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from wt.backtest.engine import EntrySignal
from wt.core.clock import ET
from wt.signals.bars import RTH_OPEN, bucket_complete_at, et_minutes, resample_clock
from wt.signals.musts import spread_ok
from wt.signals.setups import TICK
from wt.signals.spec_setups import ATTEMPTS, reversal_long

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
             bv_fail: bool = False) -> WTState:
    risk = entry - stop0
    t1 = signal_target if signal_target and signal_target > entry else entry + WT_TARGET_R * risk
    # t1 is kept exactly as the engine computes it (entry + 2 x (entry - stop), unrounded): the engine compares a
    # bar's high with that number, and a rounded copy would call a touch one bar sooner or later than it does
    return WTState(entry=entry, stop0=stop0, qty0=int(qty0), t1=float(t1),
                   entry_bar=pd.Timestamp(entry_bar).tz_convert("UTC").floor("min"), stop=stop0, bv_fail=bv_fail)


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
    out = np.empty(len(values), float)
    k, acc = 2.0 / (n + 1), float(values[0])
    for i, v in enumerate(values):
        acc = float(v) if i == 0 else acc + k * (float(v) - acc)
        out[i] = acc
    return out


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
    if s.bv_fail and last_t == s.entry_bar:
        return [WTAction("exit", "breakout_volume_fail")]
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
