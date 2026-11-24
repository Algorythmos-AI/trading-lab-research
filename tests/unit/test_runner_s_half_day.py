"""wt.live.runner_s on a half day (a 13:00 close, as on Fri 2026-11-27), replayed.

The runner takes its close from the calendar row, so every end-of-day time moves with it: no new entry from 12:30,
the flatten limit from 12:50, a market exit from 12:55, the flat check at 12:58. These replays prove it with the
same harness and tapes as test_runner_s; nothing in the runner is changed for them.
"""
from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest
import test_runner_s as base
from spec_bars import flat
from test_runner_s import DAY, KEYS, NEXT, PREV, at, events, flat_and_clean, journal, one, tape_of

from wt.core.clock import ET
from wt.live import runner_s
from wt.live.replay import BarFillBroker, ReplayClock, ReplayREST, Tape

pytestmark = pytest.mark.replay

env = base.env                                                       # the same isolated state folders
HALF = {PREV: ("09:30", "16:00"), DAY: ("09:30", "13:00"), NEXT: ("09:30", "16:00")}


def replay(tape: Tape, sessions: dict[dt.date, tuple[str, str]]) -> tuple[BarFillBroker, list[dt.datetime]]:
    """A whole session from 09:25 on the given calendar. Returns the broker and every time the clock showed."""
    clock = ReplayClock(at(9, 25))
    broker = BarFillBroker(clock, tape, sessions)
    seen: list[dt.datetime] = []
    clock.hooks.append(seen.append)
    runner_s.run(DAY, poll_s=10.0, broker=broker, rest=ReplayREST(clock, tape, sessions), now_fn=clock.now,
                 sleep_fn=clock.sleep, environ=KEYS)
    return broker, seen


def late_flush() -> list[tuple]:
    """The test_runner_s flush, 110 minutes later: the signal forms when the 12:39 bar closes, after a half day's
    12:30 cutoff and long before a full day's 15:30 one; then the same fill and run-up."""
    rows = flat(170, 50.0, v=20_000, spread=0.05) + base.flush_rows()[60:] + [base.FILL, *base.UP]
    last = rows[-1][3]
    return rows + [(last, last + 0.02, last - 0.02, last, 20_000)] * (390 - len(rows))


def test_a_position_held_into_a_half_day_close_is_flattened_from_12_50_and_the_session_ends_by_13_05(env):
    b, seen = replay(tape_of({"ABC": base.day_rows(base.HOLDS)}), HALF)
    j = journal(env)
    assert one(j, "entry_placed")["symbol"] == "ABC"
    closed = one(j, "trade_closed")
    assert closed["reason"] == "eod_flatten"
    exit_t = b.fills[-1].t.tz_convert(ET)
    assert dt.time(12, 50) <= exit_t.time() < dt.time(12, 55), exit_t     # the limit fills before the market step
    one(j, "session_end")
    assert not events(j, "END_OF_DAY_NOT_FLAT")
    assert max(seen) < at(13, 5), max(seen)                                # the runner was done soon after 13:00
    flat_and_clean(b)


def test_a_signal_after_a_half_days_12_30_cutoff_is_not_traded(env):
    b, _ = replay(tape_of({"ABC": late_flush()}), HALF)
    j = journal(env)
    assert not events(j, "entry_placed") and not events(j, "entry_filled")
    one(j, "session_end")
    flat_and_clean(b)


def test_the_same_late_signal_is_traded_on_a_full_day(env):
    """The control: the tape above is a valid entry; only the half day's earlier cutoff refused it."""
    full = {d: ("09:30", "16:00") for d in (PREV, DAY, NEXT)}
    replay(tape_of({"ABC": late_flush()}), full)
    placed = one(journal(env), "entry_placed")
    assert pd.Timestamp(placed["signal_t"]).tz_convert(ET).time() >= dt.time(12, 30)


def test_a_holiday_logs_no_session_and_places_nothing(env):
    """Thu 2026-11-26 (Thanksgiving): no calendar row for the day. The runner says so and returns."""
    b, _ = replay(tape_of({"ABC": base.day_rows(base.HOLDS)}), {PREV: ("09:30", "16:00"), NEXT: ("09:30", "16:00")})
    j = journal(env)
    one(j, "no_session")
    assert not events(j, "entry_placed") and not events(j, "armed")
    flat_and_clean(b)
