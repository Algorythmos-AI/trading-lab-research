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
