"""DEC-0073 in the stock desk's whole session, replayed: each execution stop latches the book, entries stay off in
the next session while exits still run, and the faults the desk treats as normal do not latch. Constructed tapes only
(the harness of test_runner_s)."""
from __future__ import annotations

import pytest
from test_runner_s import (DAY, FILL, QUIET_DAY, SESSIONS, TO_TARGET, Rec, at, clean, day_rows, events, journal,
                           one, session, tape_of)
from test_runner_s import env as _env_fixture

from wt.brokers.base import BrokerRejected
from wt.core.types import Position
from wt.live import runner_s
from wt.live.replay import BarFillBroker, ReplayClock
from wt.risk.virtual_account import VirtualAccount

pytestmark = pytest.mark.replay
env = _env_fixture                     # the session harness's own state folder and record (test_runner_s)

GAP_THROUGH_STOP = [FILL, (40.40, 40.45, 40.20, 40.30, 30_000)]     # 10:51 opens 28 cents under the 40.68 stop


def broker_for(tape, **pos: int) -> BarFillBroker:
    b = BarFillBroker(ReplayClock(at(9, 25)), tape, SESSIONS)
    for sym, qty in pos.items():
        b.pos[sym] = Position(sym, qty, 50.0)
    return b


def refuse_sells(b: BarFillBroker, stops_too: bool) -> None:
    """The broker takes no sale (a halted name); with `stops_too`, no protective stop either."""
    orig = b.place

    def place(o):
        if o.side == "sell" and (stops_too or o.type in ("market", "limit")):
            raise BrokerRejected("simulated: halted")
        return orig(o)
    b.place = place


def latched() -> VirtualAccount:
    return VirtualAccount.load(runner_s.VA_PATH)


def buys(b: BarFillBroker) -> list[str]:
    return [cid for cid in b.placed if b.orders[cid].side == "buy"]


def test_a_short_latches_the_book_and_the_next_session_takes_no_entry(env):
    tape = tape_of({"ABC": QUIET_DAY})
    rec = Rec()
    session(tape, broker=broker_for(tape, ABC=-7), alerts=rec)
    rows = journal(env, allow_errors=True)
    x = one(rows, "execution_stop")
    assert x["code"] == "X1" and x["decision"] == "DEC-0073" and x["arming"] is False
    va = latched()
    assert va.latched and va.latch_reason.startswith("stop rule X1:") and "(DEC-0073)" in va.latch_reason
    assert "ABC" not in va.latch_reason
    assert rec.page("paper-s:execution-stop", "once_per_day")[2] == 5
    clean(rec, "ABC")
    # the next session: the short is gone and the tape has a valid setup; the latch keeps entries off
    b2 = session(tape_of({"ABC": day_rows(TO_TARGET)}))
    rows = journal(env, allow_errors=True)
    assert [r for r in events(rows, "refuse_to_arm") if r["reason"].startswith("execution stop X1 (DEC-0073)")]
    assert events(rows, "execution_stop")[-1]["arming"] is True
    assert buys(b2) == []


def test_a_position_left_without_a_stop_latches_and_is_journaled_unprotected_at_the_close(env):
    tape = tape_of({"ABC": QUIET_DAY})
    b = broker_for(tape, ABC=10)                                      # a long the desk did not open: adopted
    refuse_sells(b, stops_too=True)
    session(tape, broker=b)
    rows = journal(env, allow_errors=True)
    assert one(rows, "execution_stop")["code"] == "X3"               # the second unprotected poll in a row
    polls = [r["polls"] for r in events(rows, "unprotected")]
    assert polls[:2] == [1, 2]
    assert events(rows, "END_OF_DAY_NOT_FLAT")[-1]["protected"] is False
    assert latched().latched


def test_a_halted_name_on_its_stop_overnight_does_not_latch(env):
    tape = tape_of({"ABC": QUIET_DAY})
    b = broker_for(tape, ABC=10)
    refuse_sells(b, stops_too=False)                                  # no sale fills, the stop rests
    session(tape, broker=b)
    rows = journal(env, allow_errors=True)
    assert events(rows, "execution_stop") == [] and not latched().latched
    assert events(rows, "unprotected") == []
    assert events(rows, "END_OF_DAY_NOT_FLAT")[-1]["protected"] is True
    assert [o for o in b.open_orders() if o.symbol == "ABC" and o.type == "stop" and o.tif == "gtc"]


def test_a_position_left_for_the_owner_is_not_the_desks_and_does_not_latch(env):
    tape = tape_of({"ABC": QUIET_DAY})
    session(tape, broker=broker_for(tape, BIG=5000))                 # over the hard caps: left for the owner
    rows = journal(env, allow_errors=True)
    assert events(rows, "execution_stop") == [] and not latched().latched
    assert one(rows, "END_OF_DAY_NOT_FLAT")["protected"] is None


def test_a_second_stop_fill_far_under_its_stop_latches_from_the_stop_orders_own_fill(env):
    runner_s.log("trade_closed", day="2024-02-29", trade_id="2024-02-29-S-XYZ-0", entry=10.0, stop=9.80, exit=9.65,
                 stop_fill=9.65, stop_price=9.80, origin="entry", R=-1.75)   # an earlier session's 0.75R slip
    session(tape_of({"ABC": day_rows(GAP_THROUGH_STOP)}))
    rows = journal(env, allow_errors=True)
    t = [r for r in events(rows, "trade_closed") if r["trade_id"].startswith(DAY.isoformat())][-1]
    assert (t["stop_fill"], t["stop_price"]) == (40.39, 40.68)       # min(stop, open) less a cent of slippage
    x = one(rows, "execution_stop")
    assert x["code"] == "X5" and x["detail"].startswith("2 stop exits") and latched().latched


def test_one_stop_fill_far_under_its_stop_is_the_names_risk_and_does_not_latch(env):
    session(tape_of({"ABC": day_rows(GAP_THROUGH_STOP)}))
    rows = journal(env, allow_errors=True)
    assert events(rows, "execution_stop") == [] and not latched().latched


def test_a_latch_set_in_the_session_cancels_the_resting_entry(env):
    tape = tape_of({"ABC": day_rows(TO_TARGET)})
    shorted = []

    def hook(now, broker):
        if not shorted and any(o.side == "buy" for o in broker.open_orders()):
            broker.pos["ZZZ"] = Position("ZZZ", -1, 5.0)              # a short appears while the entry rests
            shorted.append(now)
    b = session(tape, hook=hook)
    rows = journal(env, allow_errors=True)
    assert shorted and one(rows, "execution_stop")["code"] == "X1"
    assert one(rows, "entry_cancelled")["why"] == "latched"
    assert not [cid for cid in buys(b) if b.orders[cid].filled_qty]


def test_the_execution_stops_are_read_at_arming_from_the_journal_and_an_old_one_is_not_after_a_reset(env):
    runner_s.log("short_position", symbol="ABC", qty=-1)              # a fault journaled in an earlier session
    b = session(tape_of({"ABC": day_rows(TO_TARGET)}))
    assert buys(b) == [] and latched().latched
    from wt.ops import control
    code, msg = control.reset_latch_s("DEC-0071: the cause is fixed", va_path=runner_s.VA_PATH,
                                      lock_root=env / "locks")
    assert code == 0, msg
    b = session(tape_of({"ABC": day_rows(TO_TARGET)}))               # the old row is before the reset
    assert buys(b) and not latched().latched
