"""DEC-0075 in Gap Hunter's whole session, replayed: a first-target sale and a stop move whose stop cancel the broker
accepts but reports only later. Constructed days only (the harness of test_runner_s_gap)."""
from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest
from test_runner_s import at, events, flat_and_clean, journal, one
from test_runner_s import env as env  # noqa: F401 — the shared state fixture
from test_runner_s_gap import TRAILED, same_trade, session, simulated, tape_of
from test_runner_s_gap import gap as gap  # noqa: F401 — Gap Hunter switched on (the fixture)

from wt.live.replay import BarFillBroker
from wt.oms.manager import EXIT_HOLD_S

pytestmark = pytest.mark.replay

LAND_S = 12.0                      # reported this long after it was sent: after the confirm window (20 replayed 0.5 s polls)


def slow_stop_cancels(nth: set[int]):
    """A hook that makes the broker report the nth cancels of a protective stop (1-based) only LAND_S later, and
    records, at every tick, how long the position has gone with no working stop at all."""
    state = {"n": 0, "pending": [], "bare_since": None, "longest": 0.0, "landed": []}

    def hook(now: dt.datetime, b: BarFillBroker) -> None:
        if not hasattr(b, "real_cancel"):
            b.real_cancel = b.cancel

            def cancel(cid: str) -> None:
                o = b.orders.get(cid)
                if o is not None and o.type == "stop" and not o.status.terminal:
                    state["n"] += 1
                    if state["n"] in nth:
                        state["pending"].append((b._rc.now() + dt.timedelta(seconds=LAND_S), cid))
                        return
                b.real_cancel(cid)
            b.cancel = cancel
        for due, cid in list(state["pending"]):
            if now >= due:
                state["pending"].remove((due, cid))
                state["landed"].append(now)
                b.real_cancel(cid)
        held = sum(p.qty for p in b.positions() if p.symbol == "ABC")
        cover = sum(o.qty - o.filled_qty for o in b.open_orders() if o.symbol == "ABC" and o.type == "stop")
        if held > 0 and cover == 0:
            state["bare_since"] = state["bare_since"] or now
            state["longest"] = max(state["longest"], (now - state["bare_since"]).total_seconds())
        else:
            state["bare_since"] = None
    return hook, state


def stops(b: BarFillBroker) -> list[tuple[str, int, float]]:
    return [(b.placed_at[c].tz_convert("America/New_York").strftime("%H:%M:%S"), b.orders[c].qty,
             b.orders[c].stop_price) for c in b.placed if b.orders[c].type == "stop"]


def test_a_deferred_first_target_sale_whose_bid_leaves_the_target_gets_its_stop_back_and_sells_on_the_next_touch(gap):  # noqa: F811
    """The X3 check (DEC-0073): the sale is deferred at 09:34:30, its cancel lands at 09:34:42, and the bid sits
    under the target from 09:34:35 to 09:35:30. No poll may find the position without a stop, and the stop is
    back at the next poll, not when the hold runs out."""
    tape = tape_of(TRAILED)
    q = tape.quotes["ABC"]
    off = (q.t >= pd.Timestamp(at(9, 34, 35))) & (q.t < pd.Timestamp(at(9, 35, 30)))
    q.loc[off, "bp"], q.loc[off, "ap"] = 5.29, 5.31                   # under the 5.33 first target for 55 s
    hook, st = slow_stop_cancels({1})
    b = session(tape, hook=hook)
    j = journal(gap)                                                  # no execution_stop, no unprotected row
    assert events(j, "execution_stop") == [] and events(j, "unprotected") == []
    assert st["landed"] and st["longest"] <= EXIT_HOLD_S
    held = [r for r in events(j, "reconcile") if any(a.startswith("held ABC") for a in r["actions"])]
    assert len(held) == 1                                             # the one poll inside the hold
    s = stops(b)
    assert s[0][1:] == (46, 4.94) and s[1][1:] == (46, 4.94)          # the entry's stop, then the same stop back
    assert "09:34:40" <= s[1][0] < "09:35:00"                         # at the next poll after the cancel landed
    part = one(j, "partial_filled")
    assert part["qty"] == 23 and part["limit"] == 5.33
    sale = next(f for f in b.fills if f.side == "sell")
    assert sale.t.tz_convert("America/New_York") >= pd.Timestamp(at(9, 35, 30))   # the next valid touch
    assert one(j, "trade_closed")["reason"] == "runner_prior_5m_low"
    flat_and_clean(b)


def test_a_winner_whose_first_target_sale_and_stop_move_are_each_deferred_once_still_ends_as_the_batch_trade(gap):  # noqa: F811
    _, sim = simulated("e2", TRAILED)
    hook, st = slow_stop_cancels({1, 2})                              # the sale's cancel, then breakeven's
    b = session(tape_of(TRAILED), hook=hook)
    closed = same_trade(gap, b, sim, "e2", allow_errors=True)
    j = journal(gap, allow_errors=True)
    assert closed["reason"] == "runner_prior_5m_low" and closed["partial_qty"] == 23
    assert events(j, "execution_stop") == [] and not events(j, "loop_error")
    # the breakeven move's old stop is reported gone between two polls: the next poll begins before reconcile puts
    # the stop back, and finds it bare once (X3 latches only at two in a row). The deferred sale adds none.
    assert [r["polls"] for r in events(j, "unprotected")] == [1]
    assert len(st["landed"]) == 2 and st["longest"] <= 10.0
    # one stop at each price, in order: no full-size stop between the sale's tries, and the stop that replaced the
    # deferred move's old one rests at breakeven, never at the old 4.94
    assert [x[1:] for x in stops(b)] == [(46, 4.94), (23, 4.94), (23, 5.07), (23, 5.37)]
    assert [r["stop"] for r in events(j, "stop_move_failed")] == [5.07]
    assert [r["stop"] for r in events(j, "stop_moved")] == [5.37]     # 5.07 landed in reconcile (the plan's log)
    assert closed["final_stop"] == 5.37
