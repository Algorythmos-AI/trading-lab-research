"""DEC-0077: Gap Hunter keeps managing a position when protecting it fails. Replayed on constructed days.

Before DEC-0077 the poll's "sync and protect" step had no guard of its own: a stop the broker refused (a sell stop
over the bid, after the market fell through the plan's stop while no stop rested) raised out of the poll, so the
exits, the end-of-day flatten and the flat check never ran, poll after poll, until the close.
"""
from __future__ import annotations

import pandas as pd
import pytest
from test_runner_s import at, events, flat_and_clean, journal
from test_runner_s import env as env  # noqa: F401 — the shared state fixture
from test_runner_s_gap import HALF, ORB, gap, session, tape_of  # noqa: F401 — gap is a fixture

from wt.brokers.base import BrokerRejected
from wt.live.replay import BarFillBroker, ReplayClock

pytestmark = pytest.mark.replay

# e2 fills 5.07 at 09:31, stop 4.94; 09:32 holds; from 09:34 the name trades at 4.80, under the stop
FELL = ORB + [(5.08, 5.10, 5.05, 5.08, 60_000), (5.08, 5.09, 5.04, 5.06, 60_000)] + \
    [(4.80, 4.82, 4.78, 4.80, 60_000)] * 30


def refusing(b: BarFillBroker, tape) -> None:
    """As a real broker: no sell stop over the bid."""
    real = b.place

    def place(o):
        q = tape.quote_at(o.symbol, b._rc.now())
        if o.side == "sell" and o.type == "stop" and q is not None and o.stop_price > q[0]:
            raise BrokerRejected("stop price above the market")
        return real(o)
    b.place = place


def lose_the_stop_at(when):
    """The broker drops the resting stop (an expiry, a cancel from outside) just before the name falls."""
    done = []

    def hook(now, b):
        if not done and now >= when:
            for cid, o in list(b.orders.items()):
                if o.side == "sell" and o.type == "stop" and not o.status.terminal:
                    b.cancel(cid)
                    done.append(cid)
    return hook


def test_a_stop_the_broker_refuses_while_bare_takes_the_exit_and_never_stops_the_poll(gap):  # noqa: F811
    tape = tape_of(FELL)
    b = BarFillBroker(ReplayClock(at(9, 25)), tape, HALF)
    refusing(b, tape)
    session(tape, broker=b, hook=lose_the_stop_at(at(9, 34, 0)))
    j = journal(gap, allow_errors=True)
    assert not events(j, "loop_error"), events(j, "loop_error")[:2]
    assert events(j, "protect_failed"), "the refusal is journaled"
    closed = [r for r in j if r["event"] == "trade_closed"]
    assert len(closed) == 1
    sells = [f for f in b.fills if f.side == "sell"]
    assert sells and sells[-1].t < pd.Timestamp(at(9, 37)), sells     # out within minutes, not at the close
    assert not events(j, "END_OF_DAY_NOT_FLAT")
    flat_and_clean(b)


# ---- two active plans: each reconcile must name both symbols ------------------------------------------------------
STEADY = ORB + [(5.08, 5.12, 5.06, 5.10, 60_000)] * 40                 # ABC: in the position, nothing exits it early
XYZ_DAY = [(6.00, 6.02, 5.98, 6.00, 40_000)] * 60


def test_an_adopted_orphan_and_the_days_plan_never_cancel_each_others_orders(gap):  # noqa: F811
    """XYZ appears in the account at 09:33 and its sale is refused until 09:38, so two plans are active at once."""
    from wt.core.types import Position
    tape = tape_of(STEADY, more={"XYZ": XYZ_DAY})
    b = BarFillBroker(ReplayClock(at(9, 25)), tape, HALF)
    real = b.place

    def place(o):
        if o.symbol == "XYZ" and o.side == "sell" and o.type != "stop" and b._rc.now() < at(9, 38):
            raise BrokerRejected("simulated: sell refused")
        return real(o)
    b.place = place
    seen = []

    def orphan(now, br):
        if not seen and now >= at(9, 33):
            br.pos["XYZ"] = Position("XYZ", 10, 6.00)
            seen.append(now)
    session(tape, broker=b, hook=orphan)
    j = journal(gap, allow_errors=True)
    acts = [a for r in events(j, "reconcile") for a in r["actions"]]
    assert not [a for a in acts if a.startswith("cancelled stray order")], acts
    assert not events(j, "unprotected") and not events(j, "loop_error")
    assert {r["symbol"] for r in events(j, "trade_closed")} == {"ABC", "XYZ"}
    flat_and_clean(b)
