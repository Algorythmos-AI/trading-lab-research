"""wt.live.runner_s trading HYP-0072 (DEC-0076): Gap Hunter's entries in the best-ranked tier-2 name with a valid
order, replayed on constructed days. No market data is read.

The rule is the one the shadow ran (`rotation_walk`); these tests hold the live desk to it: the same resting name
and order each minute as the shadow journaled on the same day, the day's one attempt in the resting name only, one
resting order at a time across the names, and every other part of HYP-0071 (gates, exit, booking) unchanged.
"""
from __future__ import annotations

import pandas as pd
import pytest
from test_runner_s import at, events, flat_and_clean, journal, one
from test_runner_s import env as env  # noqa: F401 — the shared state fixture
from test_runner_s_gap import BACK, ORB, QUIET, RED_XYZ, RUN, THIN, crashed, session, tape_of
from test_runner_s_gap import gap as gap  # noqa: F401 — the pool fixture: ABC rank 1, XYZ rank 2

from wt.live import runner_s
from wt.live.replay import BarFillBroker

pytestmark = pytest.mark.replay


@pytest.fixture
def rotating(gap, monkeypatch):  # noqa: F811
    monkeypatch.setattr(runner_s, "switched_on", lambda: frozenset({"HYP-0072"}))
    return gap


def hm(t) -> str:
    return pd.Timestamp(t).tz_convert("America/New_York").strftime("%H:%M")


def buys(b: BarFillBroker) -> list[tuple[str, str]]:
    return [(b.orders[c].symbol, hm(b.placed_at[c])) for c in b.placed if b.orders[c].side == "buy"]


def one_order_at_a_time(b: BarFillBroker) -> None:
    """Never two resting entries: each buy order was placed after the one before it had ended."""
    ids = [c for c in b.placed if b.orders[c].side == "buy"]
    for prev, nxt in zip(ids, ids[1:], strict=False):
        o = b.orders[prev]
        assert o.status.terminal, o
        assert b.placed_at[nxt] >= b.placed_at[prev]


def test_the_rotation_trades_rank_two_when_it_alone_has_a_valid_order(rotating):
    tape = tape_of([THIN] + [QUIET] * 100, more={"XYZ": ORB + RUN[2:]})
    b = session(tape)
    j = journal(rotating)
    names = one(j, "gap_names")
    assert names["names"] == [[1, "ABC"], [2, "XYZ"]] and names["trial"] == "HYP-0072"
    assert one(j, "armed")["trial"] == "HYP-0072" and one(j, "armed")["entries_off"] == []
    [placed] = events(j, "entry_placed")
    assert (placed["symbol"], placed["rank"], placed["code"], placed["trigger"], placed["stop"]) == \
        ("XYZ", 2, "e2", 5.06, 4.94)
    filled, closed = one(j, "entry_filled"), one(j, "trade_closed")
    assert filled["symbol"] == "XYZ" and closed["symbol"] == "XYZ"
    assert closed["trial"] == "HYP-0072" and closed["booked"] is True and closed["code"] == "e2"
    done = one(j, "gap_day_done")
    assert done["reason"] == "traded" and done["symbol"] == "XYZ"
    assert not events(j, "rotation_shadow")                            # trading it: the shadow does not run
    assert {b.orders[c].symbol for c in b.placed} == {"XYZ"}
    assert done["rank"] == 2
    flat_and_clean(b)


def test_the_resting_order_moves_between_names_and_back_and_the_day_takes_one_trade(rotating):
    tape = tape_of(BACK + RUN[2:], more={"XYZ": RED_XYZ})
    b = session(tape)
    j = journal(rotating)
    moves = [(c["minute"], c["rank"], c["symbol"], c["code"]) for c in events(j, "rotation_live")]
    assert moves == [("09:31", 1, "ABC", "e2"), ("09:32", 2, "XYZ", "e4"), ("09:35", 1, "ABC", "e2")]
    assert [(r["symbol"], r["code"]) for r in events(j, "entry_placed")][:2] == [("ABC", "e2"), ("XYZ", "e4")]
    assert events(j, "entry_placed")[-1]["symbol"] == "ABC"
    assert {r["why"] for r in events(j, "entry_cancelled")} <= {"replaced", "withdrawn", "expired"}
    one_order_at_a_time(b)
    assert [f.side for f in b.fills].count("buy") == 1
    closed = one(j, "trade_closed")
    assert closed["symbol"] == "ABC" and closed["trial"] == "HYP-0072"
    assert one(j, "gap_day_done")["reason"] == "traded"
    flat_and_clean(b)


def test_no_name_with_a_valid_order_is_no_order_and_no_signal(rotating):
    tape = tape_of([THIN] + [QUIET] * 100, more={"XYZ": [THIN] + [QUIET] * 100})
    b = session(tape)
    j = journal(rotating)
    assert b.placed == [] and not events(j, "rotation_live")
    assert one(j, "gap_day_done")["reason"] == "no_signal"
    assert one(j, "session_end")["rotation"]["done"] == "no_attempt"


@pytest.mark.parametrize("ranks, more", [
    ("rank two alone", {"XYZ": ORB + RUN[2:]}),
    ("back to the primary", {"XYZ": RED_XYZ}),
])
def test_the_desk_rests_what_the_shadow_journaled_on_the_same_day(gap, monkeypatch, ranks, more):  # noqa: F811
    """The same day under HYP-0071 (the shadow beside it) and under HYP-0072 (trading it): each minute's resting
    name and order are the same, and so is the day's attempt."""
    rows = [THIN] + [QUIET] * 100 if ranks == "rank two alone" else BACK + RUN[2:]
    session(tape_of(rows, more=more))
    shadow_rows = journal(gap)
    seen = [(c["minute"], c["rank"], c["symbol"], c["code"], c["trigger"], c["stop"])
            for c in events(shadow_rows, "rotation_shadow") if c["kind"] == "change"]
    att = next(c for c in events(shadow_rows, "rotation_shadow") if c["kind"] == "attempt")

    import shutil
    (gap / "live" / "smallcap_journal.jsonl").unlink()                 # the same day again, from nothing
    shutil.rmtree(gap / "var" / "smallcap", ignore_errors=True)
    monkeypatch.setattr(runner_s, "switched_on", lambda: frozenset({"HYP-0072"}))
    b = session(tape_of(rows, more=more))
    j = journal(gap)
    live = [(c["minute"], c["rank"], c["symbol"], c["code"], c["trigger"], c["stop"])
            for c in events(j, "rotation_live")]
    assert live == seen
    assert one(j, "trade_closed")["symbol"] == att["symbol"]
    assert one(j, "gap_day_done")["rank"] == att["rank"]
    flat_and_clean(b)


def test_a_bar_in_a_name_whose_order_was_not_resting_is_not_the_days_attempt(rotating):
    # 09:31: ABC's e2 order rests (rank 1, not reached); XYZ's own e2 order is reached that minute but did not rest
    tape = tape_of([(5.00, 5.05, 4.95, 5.02, 150_000)] + [QUIET] * 100, more={"XYZ": ORB + RUN[2:]})
    b = session(tape)
    j = journal(rotating)
    assert {b.orders[c].symbol for c in b.placed} <= {"ABC"}       # XYZ never had the resting order
    assert {c["rank"] for c in events(j, "rotation_live")} <= {1, None}
    assert not [r for r in events(j, "entry_filled") if r["symbol"] == "XYZ"]
    flat_and_clean(b)


def test_a_crash_while_the_order_rests_in_rank_two_resumes_it_without_a_second_choice(rotating):
    tape = tape_of([THIN] + [QUIET] * 100, more={"XYZ": RED_XYZ[:5] + [(4.97, 5.05, 4.96, 5.04, 60_000)] +
                                                 [(5.04, 5.06, 5.02, 5.04, 30_000)] * 20})
    b = crashed(tape, at(9, 33, 30))                                   # XYZ's e4 order rests from 09:32
    assert events(journal(rotating), "entry_placed")[-1]["symbol"] == "XYZ"
    session(tape, start=(9, 34), broker=b)
    j = journal(rotating)
    assert len(events(j, "gap_names")) == 1 and len(events(j, "gap_primary")) == 1
    assert [f.side for f in b.fills].count("buy") <= 1
    one_order_at_a_time(b)
    done = one(j, "gap_day_done")
    assert done["symbol"] == "XYZ"
    flat_and_clean(b)


def test_both_gap_trials_switched_on_is_no_entry(gap, monkeypatch):  # noqa: F811
    monkeypatch.setattr(runner_s, "switched_on", lambda: frozenset({"HYP-0071", "HYP-0072"}))
    b = session(tape_of([THIN] + [QUIET] * 100, more={"XYZ": ORB + RUN[2:]}))
    j = journal(gap)
    assert any("both switched on" in r for r in one(j, "armed")["entries_off"]) and b.placed == []


def test_the_trial_a_session_runs_includes_the_rotation():
    assert runner_s.session_trial(frozenset({"HYP-0072"})) == ("HYP-0072", None)
    trial, why = runner_s.session_trial(frozenset({"HYP-0070", "HYP-0071", "HYP-0072"}))
    assert trial == "HYP-0071" and "all switched on" in why
