"""wt.live.setups_live: the reversal rule's entry and exit, one closed bar at a time, as the simulation decides them."""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import pytest
from spec_bars import flat, minute_bars

import wt.signals.spec_setups as ss
from wt.core.clock import ET
from wt.live import setups_live as sl
from wt.signals.setups import EntrySignal

DAY = dt.date(2024, 3, 1)
SIGNAL_BAR = 79                                   # the 10:49 bar closes the 10:45 bucket


def flush_rows() -> list[tuple]:
    """A flat hour at 50, three big red five-minute buckets to 41, then a small-range bucket at the low of the day
    (40.69). The signal forms when the 10:49 bar closes: trigger 41.02, stop 40.68, so R is 34 cents."""
    rows = flat(60, 50.0, v=20_000, spread=0.05)
    px = 50.0
    for _ in range(15):
        rows.append((px, px + 0.02, px - 0.62, px - 0.60, 40_000))
        px -= 0.60
    for _ in range(5):
        rows.append((px, px + 0.01, px - 0.07, px - 0.06, 40_000))
        px -= 0.06
    return rows


def after(*rows: tuple) -> pd.DataFrame:
    return minute_bars(flush_rows() + list(rows))


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setattr(ss, "curve_at", lambda m, curve=None: 0.5)
    prev = minute_bars(flat(390, 50.0, v=20_000, spread=0.05), day="2024-02-29")
    return sl.rev_context(prev, [1_000_000.0] * 15 + [8_000_000.0] * 5, np.ones(390))


def staged(ctx, spread=0.02) -> sl.Staged:
    bars = after()
    sig, fresh = sl.fresh_signal(bars, ctx, 0)
    assert sig is not None and fresh
    s, why = sl.stage("ABC", 1, sig, bars, DAY, spread)
    assert s is not None, why
    return s


def test_the_context_averages_the_last_five_and_twenty_sessions(ctx):
    assert ctx["adv5"] == 8_000_000 and ctx["adv20"] == pytest.approx((15 * 1e6 + 5 * 8e6) / 20)
    assert sl.rev_context(ctx["prev_rth"], [], np.ones(390))["adv20"] == 0.0


def test_a_signal_is_acted_on_only_on_the_bar_that_just_closed(ctx):
    bars = after()
    assert len(bars) == SIGNAL_BAR + 1
    assert sl.fresh_signal(bars.iloc[:SIGNAL_BAR], ctx, 0) == (None, False)          # the bucket is not complete yet
    sig, fresh = sl.fresh_signal(bars, ctx, 0)
    assert fresh and sig.bar_index == SIGNAL_BAR and sig.trigger == 41.02 and sig.stop == 40.68
    late = after(*[(40.70, 40.80, 40.69, 40.75, 30_000)] * 3)
    sig2, fresh2 = sl.fresh_signal(late, ctx, 0)
    assert sig2.bar_index == SIGNAL_BAR and not fresh2                               # seen late: reported, not traded
    assert sl.fresh_signal(bars, ctx, SIGNAL_BAR + 1) == (None, False)               # the name joined after it


def test_later_bars_never_change_what_was_staged(ctx):
    base = staged(ctx)
    wild = after(*[(40.70, 45.0, 30.0, 44.0, 900_000)] * 6)
    sig, _ = sl.fresh_signal(wild, ctx, 0)
    again, _ = sl.stage("ABC", 1, sig, wild, DAY, 0.02)
    assert again == base


def test_the_order_is_on_the_cent_grid_with_the_strict_collar_and_a_five_minute_life(ctx):
    s = staged(ctx)
    assert (s.trigger, s.stop, s.limit) == (41.02, 40.68, 41.05)                     # collar: 10% of 34 cents, floored
    assert s.target >= s.trigger + 2 * s.risk and s.attempt == 1
    assert s.expires_at == dt.datetime.combine(DAY, dt.time(10, 55), tzinfo=ET)
    assert s.signal_t == pd.Timestamp("2024-03-01 10:49", tz="America/New_York").tz_convert("UTC")


@pytest.mark.parametrize("spread, why", [(None, "spread"), (float("nan"), "spread"), (0.06, "spread")])
def test_an_unknown_or_wide_spread_stages_nothing(ctx, spread, why):
    bars = after()
    sig, _ = sl.fresh_signal(bars, ctx, 0)
    assert sl.stage("ABC", 1, sig, bars, DAY, spread) == (None, why)


def test_a_collar_narrower_than_the_charged_slippage_stages_nothing(ctx):
    bars = after()
    tight = EntrySignal(SIGNAL_BAR, 41.02, 40.95, 42.0, "REV-1")                     # R 7 cents: collar under a cent
    assert sl.stage("ABC", 1, tight, bars, DAY, 0.02) == (None, "collar")
    wide_spread = staged(ctx, spread=0.05)                                           # slippage 2.5 cents, collar 3
    assert wide_spread.limit == 41.05
    r20 = EntrySignal(SIGNAL_BAR, 41.02, 40.82, 42.0, "REV-1")                       # collar 2 cents < 2.5
    assert sl.stage("ABC", 1, r20, bars, DAY, 0.05) == (None, "collar")


def at(h: int, m: int) -> dt.datetime:
    return dt.datetime.combine(DAY, dt.time(h, m), tzinfo=ET)


def test_a_resting_entry_keeps_resting_until_something_ends_it(ctx):
    s = staged(ctx)
    quiet = (40.75, 40.90, 40.70, 40.80, 30_000)
    assert sl.entry_verdict(after(), s, 0, at(10, 50)) is None
    assert sl.entry_verdict(after(quiet, quiet), s, 0, at(10, 52)) is None
    assert sl.entry_verdict(after(quiet, quiet), s, 0, at(10, 55)) == "expired"


def test_the_stop_trading_before_the_trigger_cancels_the_entry(ctx):
    s = staged(ctx)
    under = (40.75, 40.80, 40.67, 40.70, 30_000)
    assert sl.entry_verdict(after(under), s, 0, at(10, 51)) == "stop_traded_first"
    at_stop = (40.75, 40.80, 40.68, 40.70, 30_000)                                   # the stop itself is not under it
    assert sl.entry_verdict(after(at_stop), s, 0, at(10, 51)) is None


def test_a_bar_that_reached_the_trigger_ends_the_entry_filled_or_not(ctx):
    s = staged(ctx)
    gap = (41.20, 41.40, 41.10, 41.30, 30_000)                                       # opened over the collar
    assert sl.entry_verdict(after(gap), s, 0, at(10, 51)) == "no_fill"
    assert sl.entry_verdict(after(gap), s, 3, at(10, 51)) == "partial_fill"
    both = (40.90, 41.10, 40.60, 40.70, 30_000)                                      # trigger and stop on one bar:
    assert sl.entry_verdict(after(both), s, 0, at(10, 51)) == "no_fill"              # the trigger is read first


def test_the_entry_bar_is_read_from_the_bars_not_from_when_a_poll_saw_the_fill(ctx):
    s = staged(ctx)
    quiet = (40.75, 40.90, 40.70, 40.80, 30_000)
    hit = (40.80, 41.10, 40.78, 41.00, 30_000)
    assert sl.entry_bar_time(after(quiet), s) is None
    got = sl.entry_bar_time(after(quiet, hit, hit), s)
    assert got == pd.Timestamp("2024-03-01 10:51", tz="America/New_York").tz_convert("UTC")


def test_the_target_is_the_staged_one_unless_the_fill_came_in_over_it():
    assert sl.target_price(41.80, 41.03, 40.68) == 41.80
    assert sl.target_price(41.00, 41.03, 40.68) == pytest.approx(41.73)


def test_the_stagnation_stop_waits_five_minutes_and_asks_for_half_an_r(ctx):
    entry_t = pd.Timestamp("2024-03-01 10:50:20", tz="America/New_York")             # filled inside the 10:50 bar
    slow = (41.03, 41.10, 41.00, 41.05, 30_000)                                      # +2 cents: under 0.5R (17 cents)
    fast = (41.03, 41.40, 41.00, 41.30, 30_000)
    assert not sl.stagnant(after(slow), entry_t, 41.03, 40.68)                       # the entry bar itself
    assert not sl.stagnant(after(*[slow] * 4), entry_t, 41.03, 40.68)                # 10:53 closes: four minutes
    assert sl.stagnant(after(*[slow] * 5), entry_t, 41.03, 40.68)                    # 10:54 closes: five
    assert not sl.stagnant(after(*[slow] * 4, fast), entry_t, 41.03, 40.68)          # resolved: +27 cents
    assert sl.stagnant(after(*[slow] * 4, fast, slow), entry_t, 41.03, 40.68)        # and it applies on later bars
    assert not sl.stagnant(after(slow).iloc[:0], entry_t, 41.03, 40.68)


def test_a_name_gets_two_attempts_and_the_second_reads_from_the_bar_after_its_exit():
    bars = after(*[(40.75, 40.90, 40.70, 40.80, 30_000)] * 10)
    joined = pd.Timestamp("2024-03-01 10:40:07", tz="America/New_York")
    st = sl.NameState(joined)
    assert st.start_index(bars) == 71                                                # the 10:41 bar: first after joining
    st.after_trade(pd.Timestamp("2024-03-01 10:53:30", tz="America/New_York"))
    assert st.attempts == 1 and not st.done and st.start_index(bars) == 84           # the 10:54 bar
    st.after_trade(pd.Timestamp("2024-03-01 10:56:00", tz="America/New_York"))
    assert st.attempts == 2 and st.done == "attempts"
