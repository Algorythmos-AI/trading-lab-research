"""Fault-injection tests for the OMS audit fixes. Each test names the finding it pins down."""
from __future__ import annotations

import datetime as dt

import pytest

from wt.brokers.base import DuplicateOrder, TransportError
from wt.brokers.sim import SimBroker
from wt.core.ids import coid, is_ours
from wt.core.types import Order, OrderStatus, Position
from wt.oms.manager import OMS, PlanStore, TradePlan
from wt.risk.pretrade import Context, Limits, PreTradeGuard

ET_NOW = dt.datetime(2026, 9, 30, 10, 30, tzinfo=dt.timezone(dt.timedelta(hours=-4)))
LIMITS = Limits(allowlist=frozenset({"QQQM"}), max_qty=10, max_notional=5000, max_entries_per_day=1,
                max_orders_per_day=20)


def plan(qty: int = 4) -> TradePlan:
    return TradePlan(date="2026-09-30", strategy="B", symbol="QQQM", qty=qty, trigger=250.0, limit=250.2, stop=249.0,
                     target=252.0)


def mk(guard: bool = False, kill: bool = False, store: PlanStore | None = None):
    b = SimBroker()
    entries: list[str] = []

    def ctx(symbol: str) -> Context:
        return Context(now=ET_NOW, position_qty=sum(p.qty for p in b.positions() if p.symbol == symbol),
                       open_orders=b.open_orders(), kill=kill, latched=False,
                       session_open=ET_NOW.replace(hour=9, minute=30), session_close=ET_NOW.replace(hour=16, minute=0),
                       entries_today=0, orders_today=0, environ={"MODE": "paper"})
    oms = OMS(b, sell_timeout_s=1.0, sleep=lambda s: None, guard=PreTradeGuard(LIMITS) if guard else None,
              context=ctx if guard else None, persist=store.save if store else None,
              on_entry=lambda p: entries.append(p.trade_id), strategy="B")
    return b, oms, entries


def filled_plan(b: SimBroker, oms: OMS, qty: int = 4) -> TradePlan:
    p = plan(qty)
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    oms.sync(p)
    return p


# ---- C1: stop-outs are closes like any other, with the real fill price ----------------------------------------

def test_c1_stop_out_closes_the_plan_with_the_stop_fill_price():
    b, oms, entries = mk()
    p = filled_plan(b, oms)
    assert p.state == "in_position" and entries == [p.trade_id]
    b.fill(p.stop_id, 248.90)                      # the stop fills with slippage below 249.00
    oms.sync(p)
    assert p.state == "closed" and p.exit_fill_price == 248.90 and p.exit_reason == "stop"
    assert b.open_orders() == []


# ---- C2: a partial fill whose remainder is cancelled is a position, not a stuck entry ---------------------------

def test_c2_partial_fill_then_cancel_moves_to_in_position_with_a_sized_gtc_stop():
    b, oms, _ = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05, qty=2)
    oms.sync(p)
    oms.cancel_entry_remainder(p)
    assert p.state == "in_position" and p.filled_qty == 2
    stop = b.get_order(p.stop_id)
    assert stop.qty == 2 and stop.tif == "gtc"
    b.expire_day_orders()                           # the session ends: the GTC stop survives (audit M7)
    assert b.get_order(p.stop_id).status == OrderStatus.ACCEPTED


def test_c2_broker_expiring_a_partially_filled_entry_is_also_a_position():
    b, oms, _ = mk()
    p = plan()
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05, qty=1)
    oms.sync(p)
    b.orders[p.entry_id].status = OrderStatus.CANCELED        # expired by the broker
    oms.sync(p)
    assert p.state == "in_position" and b.get_order(p.stop_id).qty == 1


# ---- C3: uncertain submits resolve by id, never leave the plan in limbo -------------------------------------------

def test_c3_submit_that_never_reached_the_broker_aborts_cleanly():
    b, oms, _ = mk()
    b.fail_next_place = True
    p = plan()
    oms.place_entry(p)
    assert p.state == "aborted" and b.orders == {}


def test_c3_lost_response_is_resolved_by_id():
    b, oms, _ = mk()
    b.lose_next_response = True
    p = plan()
    oms.place_entry(p)
    assert p.state == "entry_working" and len(b.placed) == 1


def test_c3_failed_lookup_leaves_submitting_and_the_next_loop_protects_the_fill():
    b, oms, _ = mk()
    b.lose_next_response, b.fail_next_gets = True, 1
    p = plan()
    with pytest.raises(TransportError):
        oms.place_entry(p)                          # the lookup itself failed: outcome unknown
    assert p.state == "submitting"
    b.fill(p.entry_id, 250.05)                      # it was accepted and filled meanwhile
    oms.sync(p)
    assert p.state == "in_position" and b.get_order(p.stop_id).qty == 4


# ---- H2: every submission has its own id -------------------------------------------------------------------------

def test_h2_retries_and_restops_never_reuse_an_id():
    b, oms, _ = mk()
    p = filled_plan(b, oms)
    assert oms.exit_now(p, 260.0, "target") is False            # far limit: not filled, re-protected
    assert oms.exit_now(p, 260.0, "target") is False            # second attempt: new ids again
    assert len(b.placed) == len(set(b.placed)) == 6             # entry, stop, exit, restop, exit, restop
    stops = [o for o in b.open_orders() if o.type == "stop"]
    assert len(stops) == 1 and stops[0].qty == 4 and p.state == "in_position"


def test_h2_ids_are_scoped_by_strategy_and_sequence():
    a, c = coid("2026-09-30", "B", "QQQM", "exit", 0), coid("2026-09-30", "B", "QQQM", "exit", 1)
    assert a != c and a.startswith("wt-B-20260930-") and is_ours(a, "B") and not is_ours(a, "GG1")


def test_h2_sim_broker_rejects_a_duplicate_id():
    b = SimBroker()
    o = Order("wt-B-20260930-x", "QQQM", "buy", 1, "market")
    b.place(o)
    with pytest.raises(DuplicateOrder):
        b.place(o)


# ---- M4: an unconfirmed cancel is not a cancel -------------------------------------------------------------------

def test_m4_exit_is_deferred_when_the_stop_cancel_cannot_be_confirmed():
    b, oms, _ = mk()
    p = filled_plan(b, oms)
    real, calls = SimBroker.get_order, {"n": 0}

    def flaky(cid):                                # the first lookup works, every confirmation lookup fails
        calls["n"] += 1
        if calls["n"] >= 2:
            raise TransportError("lookup timeout")
        return real(b, cid)
    b.get_order = flaky
    assert oms.exit_now(p, 251.8, "target") is False
    assert not [o for o in b.orders.values() if o.type == "limit"]      # no sell was sent on a guess
    assert "exit_deferred" in str(p.log[-1])


# ---- M5 and shorts: reconcile stays in its lane and never leaves excess sells ------------------------------------

def test_m5_reconcile_only_cancels_its_own_strategy_orders():
    b, oms, _ = mk()
    b.place(Order(coid("2026-09-30", "GG-1", "ABCD", "entry", 0), "ABCD", "buy", 5, "limit", limit_price=3.0))
    b.place(Order(coid("2026-09-30", "B", "XYZ", "entry", 0), "XYZ", "buy", 1, "limit", limit_price=10.0))
    acts = oms.reconcile({"QQQM"}, {})
    assert any("stray" in a and "XYZ" in a for a in acts)
    assert [o.symbol for o in b.open_orders()] == ["ABCD"]            # the other strategy's order survives


def test_excess_resting_sells_are_cancelled_so_no_short_can_open():
    b, oms, _ = mk()
    p = filled_plan(b, oms)
    b.pos["QQQM"].qty = 0                           # position closed outside the plan (e.g. a manual flatten)
    acts = oms.reconcile({"QQQM"}, {}, plan=p)
    assert any("excess sell" in a for a in acts) and b.open_orders() == []


def test_reconcile_flags_a_short_and_protects_an_unplanned_long_with_the_fallback_stop():
    b, oms, _ = mk()
    b.pos["QQQM"] = Position("QQQM", -2, 250.0)
    assert any("SHORT" in a for a in oms.reconcile({"QQQM"}, {}))
    b.pos["QQQM"] = Position("QQQM", 3, 250.0)
    acts = oms.reconcile({"QQQM"}, {"QQQM": 247.5})
    assert any("fallback stop" in a for a in acts)
    assert [(o.qty, o.stop_price, o.tif) for o in b.open_orders()] == [(3, 247.5, "gtc")]


# ---- M3: the pre-trade guard ------------------------------------------------------------------------------------

def test_guard_blocks_entries_on_kill_but_never_blocks_protection():
    b, oms, _ = mk(guard=True, kill=True)
    p = plan()
    oms.place_entry(p)
    assert p.state == "aborted" and b.orders == {} and "kill" in str(p.log[-1])
    b.pos["QQQM"] = Position("QQQM", 4, 250.0)       # a position exists anyway: its stop must go through
    p2 = plan()
    p2.filled_qty, p2.state = 4, "in_position"
    oms.ensure_stop(p2)
    assert b.get_order(p2.stop_id).qty == 4


def test_guard_refuses_a_second_stop_that_would_oversell_and_reconcile_resizes_instead():
    from wt.oms.manager import GuardRejected
    b, oms, _ = mk(guard=True)
    p = filled_plan(b, oms)
    b.pos["QQQM"].qty = 2                          # broker says only 2 left; the 4-lot stop still rests
    old_stop = p.stop_id
    p.stop_id = ""                                 # a buggy caller forgets the resting stop...
    with pytest.raises(GuardRejected, match="sell within long position"):
        oms.ensure_stop(p)                         # ...the guard refuses 2 more on top of 4 resting
    p.stop_id = old_stop
    acts = oms.reconcile({"QQQM"}, {}, plan=p)     # the right path: cancel the excess, then resize
    assert any("excess sell" in a for a in acts)
    assert [o.qty for o in b.open_orders() if o.type == "stop"] == [2]


# ---- C4: persistence and restart ---------------------------------------------------------------------------------

def test_c4_plan_and_sequence_survive_a_restart(tmp_path):
    store = PlanStore(tmp_path / "plan.json")
    b, oms, _ = mk(store=store)
    p = filled_plan(b, oms)
    again = store.load()
    assert again is not None and again.state == "in_position" and again.seq == p.seq == 2
    oms2 = OMS(b, sell_timeout_s=1.0, sleep=lambda s: None, persist=store.save, strategy="B")
    assert oms2.reconcile({"QQQM"}, {}, plan=again) == []            # already protected: nothing to do
    b.orders[again.stop_id].status = OrderStatus.CANCELED            # stop lost while we were down
    acts = oms2.reconcile({"QQQM"}, {}, plan=again)
    assert any("protected QQQM" in a for a in acts) and b.get_order(again.stop_id).status == OrderStatus.ACCEPTED
    assert len(b.placed) == len(set(b.placed))


# ---- H1: end-of-day market exit ----------------------------------------------------------------------------------

def test_h1_market_exit_cancels_and_confirms_the_stop_first():
    b, oms, _ = mk()
    p = filled_plan(b, oms)
    orig = b.place

    def place_and_fill(o):
        r = orig(o)
        if o.type == "market":
            b.fill(o.client_order_id, 250.40)
        return r
    b.place = place_and_fill
    assert oms.exit_now(p, None, "eod_market", market=True) is True
    assert p.state == "closed" and p.exit_fill_price == 250.40 and b.open_orders() == []
