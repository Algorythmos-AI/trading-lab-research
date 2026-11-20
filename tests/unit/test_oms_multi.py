"""wt.oms.multi: selling part of a position and moving its stop, with a fault at every step.

Every test runs behind the real pre-trade guard, so "sell <= position - resting sells" is checked on each order:
the invariant throughout is that resting sells never exceed the position, and a long position always has a stop.
"""
from __future__ import annotations

import datetime as dt

import pytest

from wt.brokers.sim import SimBroker
from wt.core.types import OrderStatus
from wt.oms.multi import MultiOMS, MultiPlan, MultiPlanStore
from wt.risk.pretrade import Context, Limits, PreTradeGuard

NOW = dt.datetime(2026, 12, 1, 10, 30, tzinfo=dt.timezone(dt.timedelta(hours=-5)))
LIMITS = Limits(allowlist=frozenset({"ABC", "XYZ"}), max_qty=50, max_notional=5000, max_entries_per_day=6,
                max_orders_per_day=60)


class Rig:
    def __init__(self, tmp_path, fill_partials_at: float | None = None):
        self.b = SimBroker()
        self.store = MultiPlanStore(tmp_path / "plans")
        self.fill_at = fill_partials_at
        self.on_sleep = None

        def ctx(symbol: str) -> Context:
            return Context(now=NOW, position_qty=sum(p.qty for p in self.b.positions() if p.symbol == symbol),
                           open_orders=self.b.open_orders(), kill=False, latched=False,
                           session_open=NOW.replace(hour=9), session_close=NOW.replace(hour=16), entries_today=0,
                           orders_today=0, environ={"MODE": "paper"})

        def sleep(_s: float) -> None:
            if self.on_sleep is not None:
                self.on_sleep()
            if self.fill_at is not None:                       # the market takes a resting partial sell
                for o in self.b.open_orders():
                    if o.side == "sell" and o.type == "limit":
                        self.b.fill(o.client_order_id, self.fill_at)

        self.oms = MultiOMS(self.b, guard=PreTradeGuard(LIMITS), context=ctx, persist=self.store.save, strategy="S",
                            sleep=sleep, sell_timeout_s=2.0, confirm_polls=3, poll_s=0.0)

    def held(self, symbol: str = "ABC", qty: int = 10, entry: float = 20.0, stop: float = 19.5) -> MultiPlan:
        p = MultiPlan(date="2026-12-01", strategy="S", symbol=symbol, qty=qty, trigger=entry, limit=entry + 0.05,
                      stop=stop, target=entry + 1.0)
        self.oms.place_entry(p)
        self.b.fill(p.entry_id, entry)
        self.oms.sync(p)
        assert p.state == "in_position" and self.stops(symbol) == [qty]
        return p

    def stops(self, symbol: str = "ABC") -> list[int]:
        return [o.qty - o.filled_qty for o in self.b.own_sells(symbol) if o.type == "stop"]

    def limits(self, symbol: str = "ABC") -> list[int]:
        return [o.qty - o.filled_qty for o in self.b.own_sells(symbol) if o.type == "limit"]

    def pos(self, symbol: str = "ABC") -> int:
        return sum(p.qty for p in self.b.positions() if p.symbol == symbol)

    def safe(self, symbol: str = "ABC") -> None:
        """Resting sells never exceed the position, and a long position is fully stopped."""
        resting = sum(o.qty - o.filled_qty for o in self.b.own_sells(symbol))
        assert resting <= self.pos(symbol)
        assert sum(self.stops(symbol)) == self.pos(symbol)


# ---- partial exit ----------------------------------------------------------------------------------------------------
def test_half_is_sold_and_the_stop_is_sized_to_what_remains(tmp_path):
    r = Rig(tmp_path, fill_partials_at=21.0)
    p = r.held()
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 5
    assert p.partial_qty == 5 and p.state == "in_position" and r.pos() == 5
    assert r.stops() == [5] and r.limits() == []
    r.safe()


def test_the_remainders_stop_rests_before_the_sell_is_sent(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    seen = []
    r.on_sleep = lambda: seen.append((r.stops(), r.limits()))
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 0                    # nobody takes it: it times out
    assert ([5], [5]) in seen                                          # while it worked: stop for 5, sell for 5
    assert r.stops() == [10] and r.limits() == [] and p.partial_qty == 0
    r.safe()


def test_a_partial_that_fills_only_in_part_is_counted_and_the_stop_follows(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    done = []

    def take_two():
        resting = [o for o in r.b.open_orders() if o.type == "limit" and o.side == "sell"]
        if resting and not done:
            done.append(1)
            r.b.fill(resting[0].client_order_id, 21.0, 2)

    r.on_sleep = take_two
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 2
    assert p.partial_qty == 2 and r.pos() == 8 and r.stops() == [8] and r.limits() == []
    r.safe()


def test_asking_for_the_whole_position_is_an_ordinary_exit(tmp_path):
    r = Rig(tmp_path, fill_partials_at=21.0)
    p = r.held(qty=1)
    assert r.oms.partial_exit(p, 1, 21.0, "target_all") == 1
    assert p.state == "closed" and p.exit_reason == "target_all" and r.pos() == 0 and r.b.open_orders() == []


def test_the_exit_price_is_the_average_over_the_partial_and_the_rest(tmp_path):
    r = Rig(tmp_path, fill_partials_at=21.0)
    p = r.held()
    r.oms.partial_exit(p, 5, 21.0, "t1")
    r.fill_at = 20.0
    assert r.oms.exit_now(p, 20.0, "runner") is True
    assert p.state == "closed" and p.exit_fill_price == pytest.approx(20.5)


# ---- a fault at each step ---------------------------------------------------------------------------------------------
def test_step_1_an_unconfirmed_stop_cancel_changes_nothing(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    r.b.fail_next_gets = 99                                             # the broker cannot be read
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 0
    r.b.fail_next_gets = 0
    assert p.partial_ids == [] and r.limits() == []
    r.oms.reconcile_all([p])
    r.safe()


def test_step_2_a_refused_remainder_stop_puts_the_whole_stop_back(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    r.b.fail_next_place = True                                          # the stop for the remainder never arrives
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 0
    assert r.stops() == [10] and r.limits() == [] and p.partial_ids == []
    r.safe()


def test_step_3_a_refused_sell_puts_the_whole_stop_back(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    calls = []
    real = r.b.place

    def place(order):
        calls.append(order.type)
        if order.type == "limit" and order.side == "sell":
            r.b.fail_next_place = True
        return real(order)

    r.b.place = place
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 0
    assert r.stops() == [10] and r.limits() == []
    r.safe()


def test_step_3_a_lost_response_still_finds_the_sell_by_its_id(tmp_path):
    r = Rig(tmp_path, fill_partials_at=21.0)
    p = r.held()
    real = r.b.place

    def place(order):
        if order.type == "limit" and order.side == "sell":
            r.b.lose_next_response = True
        return real(order)

    r.b.place = place
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 5
    assert r.stops() == [5] and r.pos() == 5
    r.safe()


def test_a_crash_with_the_partial_resting_is_settled_by_reconcile(tmp_path):
    r = Rig(tmp_path)
    p = r.held()

    class Crash(BaseException):
        pass

    def die():
        if r.limits():                                                  # the partial sell is resting: die here
            raise Crash

    r.on_sleep = die
    with pytest.raises(Crash):
        r.oms.partial_exit(p, 5, 21.0, "t1")
    assert r.stops() == [5] and r.limits() == [5]                       # died here: half stopped, half for sale
    r2 = Rig(tmp_path)
    r2.b = r.b
    r2.oms.b = r.b
    (loaded,) = r2.store.load_all()                                     # the restart reads the plan from disk
    assert loaded.partial_ids == p.partial_ids and loaded.state == "in_position"
    acts = r2.oms.reconcile_all([loaded])
    assert any("cancelled resting partial" in a for a in acts)
    assert [o.qty for o in r.b.own_sells("ABC")] == [10] and loaded.partial_qty == 0
    r.safe()


def test_a_partial_that_filled_while_the_runner_was_down_is_counted_on_restart(tmp_path):
    r = Rig(tmp_path)
    p = r.held()

    class Crash(BaseException):
        pass

    def die():
        if r.limits():                                                  # the partial sell is resting: die here
            raise Crash

    r.on_sleep = die
    with pytest.raises(Crash):
        r.oms.partial_exit(p, 5, 21.0, "t1")
    (o,) = [o for o in r.b.open_orders() if o.type == "limit"]
    r.b.fill(o.client_order_id, 21.0)                                   # it filled with nobody watching
    r.on_sleep = None
    r.oms.reconcile_all([p])
    assert p.partial_qty == 5 and r.stops() == [5] and r.pos() == 5
    r.safe()


def test_a_stop_out_during_the_partial_closes_the_plan_without_a_short(tmp_path):
    r = Rig(tmp_path)
    p = r.held()

    def stop_out():
        for o in r.b.open_orders() if r.limits() else []:
            if o.type == "stop":
                r.b.fill(o.client_order_id, 19.4)                       # the remainder's stop fills first
            elif o.type == "limit" and o.side == "sell":
                r.b.fill(o.client_order_id, 21.0)

    r.on_sleep = stop_out
    assert r.oms.partial_exit(p, 5, 21.0, "t1") == 5
    assert r.pos() == 0 and p.state == "closed" and p.exit_reason == "stop" and r.b.open_orders() == []
    assert p.exit_fill_price == pytest.approx((5 * 19.4 + 5 * 21.0) / 10)


# ---- moving the stop --------------------------------------------------------------------------------------------------
def test_the_stop_moves_up_and_r_keeps_its_first_stop(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    assert p.initial_stop == 19.5
    assert r.oms.move_stop(p, 20.0) is True
    assert p.stop == 20.0 and p.stop0 == 19.5 and p.initial_stop == 19.5
    assert [o.stop_price for o in r.b.own_sells("ABC")] == [20.0]
    assert r.oms.move_stop(p, 20.4) is True and p.stop0 == 19.5         # the first stop is remembered once
    r.safe()


def test_the_stop_never_moves_down_or_sideways(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    placed = len(r.b.placed)
    assert r.oms.move_stop(p, 19.5) is False and r.oms.move_stop(p, 19.0) is False
    assert len(r.b.placed) == placed and p.stop == 19.5 and p.stop0 is None


def test_an_unconfirmed_cancel_leaves_the_old_stop_and_price(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    r.b.fail_next_gets = 99
    assert r.oms.move_stop(p, 20.0) is False
    r.b.fail_next_gets = 0
    assert p.stop == 19.5 and p.stop0 is None
    r.oms.reconcile_all([p])
    r.safe()


def test_a_refused_new_stop_puts_the_old_one_back(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    r.b.fail_next_place = True
    assert r.oms.move_stop(p, 20.0) is False
    assert p.stop == 19.5 and [o.stop_price for o in r.b.own_sells("ABC")] == [19.5]
    r.safe()


def test_the_moved_stop_survives_a_restart(tmp_path):
    r = Rig(tmp_path)
    p = r.held()
    r.oms.move_stop(p, 20.0)
    (loaded,) = r.store.load_all()
    assert (loaded.stop, loaded.stop0, loaded.stop_id) == (20.0, 19.5, p.stop_id)


def test_after_a_partial_the_moved_stop_covers_only_the_remainder(tmp_path):
    r = Rig(tmp_path, fill_partials_at=21.0)
    p = r.held()
    r.oms.partial_exit(p, 5, 21.0, "t1")
    assert r.oms.move_stop(p, 20.0) is True
    assert [(o.qty, o.stop_price) for o in r.b.own_sells("ABC")] == [(5, 20.0)]
    r.safe()


# ---- several plans ----------------------------------------------------------------------------------------------------
def test_two_plans_are_reconciled_without_touching_each_others_orders(tmp_path):
    r = Rig(tmp_path)
    a, x = r.held("ABC"), r.held("XYZ", qty=6, entry=30.0, stop=29.0)
    before = sorted(o.client_order_id for o in r.b.open_orders())
    assert r.oms.reconcile_all([a, x]) == []
    assert sorted(o.client_order_id for o in r.b.open_orders()) == before
    r.safe("ABC")
    r.safe("XYZ")


def test_a_missing_stop_on_one_plan_is_replaced_and_the_other_is_left_alone(tmp_path):
    r = Rig(tmp_path)
    a, x = r.held("ABC"), r.held("XYZ", qty=6, entry=30.0, stop=29.0)
    r.b.cancel(a.stop_id)
    xyz_stop = x.stop_id
    acts = r.oms.reconcile_all([a, x])
    assert acts == ["protected ABC: stop for 10 @ 19.5"]
    assert x.stop_id == xyz_stop and r.b.get_order(xyz_stop).status is OrderStatus.ACCEPTED
    r.safe("ABC")
    r.safe("XYZ")


def test_a_closed_plan_is_not_reconciled_and_its_leftover_order_is_a_stray(tmp_path):
    r = Rig(tmp_path)
    a, x = r.held("ABC"), r.held("XYZ", qty=6, entry=30.0, stop=29.0)
    r.b.fill(x.stop_id, 28.9)
    r.oms.sync(x)
    assert x.state == "closed"
    assert r.oms.reconcile_all([a, x]) == []
    r.safe("ABC")


def test_the_plan_store_keeps_one_file_per_trade(tmp_path):
    r = Rig(tmp_path)
    r.held("ABC")
    r.held("XYZ", qty=6, entry=30.0, stop=29.0)
    assert sorted(f.name for f in (tmp_path / "plans").iterdir()) == ["2026-12-01-S-ABC-0.json", "2026-12-01-S-XYZ-0.json"]
    assert [p.symbol for p in r.store.load_all()] == ["ABC", "XYZ"]
    assert MultiPlanStore(tmp_path / "none").load_all() == []
