"""DEC-0075: a stop move and a first-target sale whose stop cancel is not confirmed (MultiOMS, Gap Hunter).

A deferred move keeps the old stop resting and saves the new price: the stop that replaces the old one once it is
gone rests at the new price. A deferred sale starts DEC-0071's hold, so the stop is not put back while the sale is
asked again. Each test runs on a broker that accepts a cancel and reports it only later (as test_oms_exit_hold)."""
from __future__ import annotations

import dataclasses
import json

from wt.brokers.base import BrokerRejected
from wt.brokers.sim import SimBroker
from wt.core.types import Order, OrderStatus
from wt.live import runner_s
from wt.oms.manager import EXIT_HOLD_S
from wt.oms.multi import MultiOMS, MultiPlan, MultiPlanStore


class SlowCancel(SimBroker):
    """A cancel the broker accepts but reports only later: the order stays working until `settle`. A limit sell
    fills at once at its limit; a stop over `refuse_over` is refused, as a broker refuses a stop over the bid."""

    def __init__(self) -> None:
        super().__init__()
        self.pending: set[str] = set()
        self.slow = True
        self.refuse_over: float | None = None
        self.refused: list[float] = []

    def cancel(self, client_order_id: str) -> None:
        o = self.orders.get(client_order_id)
        if not self.slow:
            super().cancel(client_order_id)
        elif o is not None and not o.status.terminal:
            self.pending.add(client_order_id)

    def settle(self) -> None:
        for cid in self.pending:
            if not self.orders[cid].status.terminal:
                self.orders[cid].status = OrderStatus.CANCELED
        self.pending.clear()

    def place(self, order: Order) -> Order:
        if order.type == "stop" and self.refuse_over is not None and (order.stop_price or 0) > self.refuse_over:
            self.refused.append(float(order.stop_price or 0))
            raise BrokerRejected("stop price above the market")
        r = super().place(order)
        if order.side == "sell" and order.type == "limit":
            self.fill(order.client_order_id, float(order.limit_price or 0))
        elif order.side == "sell" and order.type == "market":
            self.fill(order.client_order_id, 20.0)
        return r


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


def setup(store: MultiPlanStore | None = None) -> tuple[SlowCancel, MultiOMS, MultiPlan, Clock]:
    b, clock = SlowCancel(), Clock()
    oms = MultiOMS(b, sell_timeout_s=1.0, sleep=lambda s: None, strategy="S", clock=clock, confirm_polls=3,
                   unguarded=True,
                   persist=store.save if store else None)
    p = MultiPlan(date="2026-12-01", strategy="S", symbol="ABC", qty=10, trigger=20.0, limit=20.05, stop=19.5,
                  target=21.0)
    oms.place_entry(p)
    b.fill(p.entry_id, 20.0)
    oms.sync(p)
    assert p.state == "in_position" and p.stop_id
    return b, oms, p, clock


def stops(b: SimBroker) -> list[tuple[int, float | None]]:
    """Every stop the plan placed, in order: (shares, stop price)."""
    return [(b.orders[c].qty, b.orders[c].stop_price) for c in b.placed if b.orders[c].type == "stop"]


def resting(b: SimBroker) -> list[tuple[int, float | None]]:
    return [(o.qty - o.filled_qty, o.stop_price) for o in b.open_orders() if o.type == "stop"]


def loop(oms: MultiOMS, p: MultiPlan) -> list[str]:
    """The stock desk's loop order before its exit: sync, then reconcile."""
    oms.sync(p)
    return oms.reconcile_all([p]) if p.active else []


# ---- a deferred stop move -----------------------------------------------------------------------------------------
def test_a_deferred_move_whose_cancel_lands_late_is_replaced_at_the_new_price_with_one_stop():
    b, oms, p, _ = setup()
    assert oms.move_stop(p, 20.0) is False                              # the cancel is not confirmed yet
    assert p.stop == 19.5 and p.stop_deferred == 20.0 and resting(b) == [(10, 19.5)]   # the old stop still rests
    b.settle()                                                          # the broker reports it cancelled
    acts = loop(oms, p)
    assert acts == ["protected ABC: stop for 10 @ 20.0"]               # the journal's price is the one that rests
    assert stops(b) == [(10, 19.5), (10, 20.0)]                         # one replacement, never at the old price
    assert (p.stop, p.stop0, p.stop_deferred) == (20.0, 19.5, None) and p.initial_stop == 19.5
    assert b.orders[p.stop_id].stop_price == 20.0
    assert ["stop_moved", 19.5, 20.0, "deferred"] in p.log
    assert oms.move_stop(p, 20.0) is False and len(stops(b)) == 2       # the runner's next ask: nothing to cancel


def test_a_deferred_move_whose_cancel_is_still_pending_keeps_the_old_stop():
    b, oms, p, _ = setup()
    oms.move_stop(p, 20.0)
    assert loop(oms, p) == [] and resting(b) == [(10, 19.5)] and p.stop_deferred == 20.0


def test_a_deferred_move_refused_at_the_new_price_falls_back_to_the_old_price():
    b, oms, p, _ = setup()
    oms.move_stop(p, 20.0)
    b.settle()
    b.refuse_over = 19.8                                                # the market is already under 20.00
    acts = loop(oms, p)
    assert b.refused == [20.0]                                          # asked at the new price first
    assert acts == ["protected ABC: stop for 10 @ 19.5"] and resting(b) == [(10, 19.5)]   # never bare
    assert p.stop == 19.5 and p.stop_deferred is None and b.orders[p.stop_id].stop_price == 19.5
    assert any(row[0] == "stop_move_refused" for row in p.log)


def test_a_deferred_price_never_lowers_the_stop():
    b, oms, p, _ = setup()
    b.slow = False
    assert oms.move_stop(p, 20.4) is True
    p.stop_deferred = 20.0                                              # older and lower than the stop that rests
    b.cancel(p.stop_id)                                                 # the stop goes, by any path
    loop(oms, p)
    assert resting(b) == [(10, 20.4)] and p.stop == 20.4 and p.stop_deferred is None


def test_a_later_move_that_succeeds_clears_the_deferred_price():
    b, oms, p, _ = setup()
    oms.move_stop(p, 20.0)
    b.settle()
    b.slow = False
    assert oms.move_stop(p, 20.4) is True                               # before any reconcile: the old stop is gone
    assert p.stop_deferred is None and p.stop == 20.4 and stops(b) == [(10, 19.5), (10, 20.4)]


def test_a_stop_that_fills_while_its_move_is_deferred_closes_the_plan_and_drops_the_price():
    b, oms, p, _ = setup()
    oms.move_stop(p, 20.0)
    b.pending.clear()
    b.fill(p.stop_id, 19.45)                                            # the old stop traded before the cancel
    loop(oms, p)
    assert p.state == "closed" and p.exit_reason == "stop" and p.stop_deferred is None
    assert stops(b) == [(10, 19.5)] and b.positions() == []


def test_a_plan_that_closes_while_its_move_is_deferred_drops_the_price():
    b, oms, p, _ = setup()
    oms.move_stop(p, 20.0)
    b.settle()
    assert oms.exit_now(p, None, "runner", market=True) is True         # the old stop is gone: sold at once
    assert p.state == "closed" and p.stop_deferred is None and stops(b) == [(10, 19.5)]


def test_the_deferred_price_survives_a_restart(tmp_path):
    store = MultiPlanStore(tmp_path / "plans")
    b, oms, p, clock = setup(store)
    oms.move_stop(p, 20.0)
    (q,) = store.load_all()
    assert q.stop_deferred == 20.0 and q.stop == 19.5
    b.settle()
    oms2 = MultiOMS(b, sell_timeout_s=1.0, sleep=lambda s: None, strategy="S", clock=clock, confirm_polls=3,
                   unguarded=True,
                    persist=store.save)
    assert loop(oms2, q) == ["protected ABC: stop for 10 @ 20.0"] and stops(b)[-1] == (10, 20.0)


def test_a_plan_file_written_before_this_field_still_loads(tmp_path, monkeypatch):
    p = MultiPlan(date="2026-12-01", strategy="S", symbol="ABC", qty=10, trigger=20.0, limit=20.05, stop=19.5,
                  target=21.0, state="in_position", filled_qty=10, stop0=19.5)
    raw = dataclasses.asdict(p)
    del raw["stop_deferred"]
    folder = tmp_path / "plans"
    folder.mkdir()
    (folder / f"{p.trade_id}.json").write_text(json.dumps(raw))
    (loaded,) = MultiPlanStore(folder).load_all()
    assert loaded.stop_deferred is None and loaded.stop == 19.5 and loaded.state == "in_position"
    # the host loads Gap Hunter's plans through runner_s.load_plan, as GapPlan
    g = dataclasses.asdict(runner_s.GapPlan(date="2026-12-01", strategy="S", symbol="ABC", qty=10, trigger=20.0,
                                            limit=20.05, stop=19.5, target=21.0, code="e2"))
    del g["stop_deferred"]
    f = tmp_path / "gap.json"
    f.write_text(json.dumps(g))
    gp = runner_s.load_plan(f)
    assert isinstance(gp, runner_s.GapPlan) and gp.stop_deferred is None and gp.code == "e2"


# ---- a deferred first-target sale ---------------------------------------------------------------------------------
def test_a_deferred_partial_is_sold_on_the_next_poll_with_no_second_full_size_stop():
    b, oms, p, _ = setup()
    assert oms.partial_exit(p, 5, 21.0, "partial_t1") == 0              # the cancel is not confirmed yet
    assert oms.held_for_exit(p) and any(row[0] == "partial_deferred" for row in p.log)
    b.settle()
    acts = loop(oms, p)                                                 # the next poll, inside the hold
    assert acts == ["held ABC: stop cancelled for an exit that is due; not replaced"]
    assert oms.partial_exit(p, 5, 21.0, "partial_t1") == 5              # asked again: sold
    assert stops(b) == [(10, 19.5), (5, 19.5)]                          # no full-size stop between the two tries
    assert resting(b) == [(5, 19.5)] and p.partial_qty == 5 and not oms.held_for_exit(p)
    assert p.exit_hold_stop == "" and p.exit_hold_until == 0.0


def test_a_deferred_partial_not_asked_again_gets_its_stop_back_after_the_hold():
    b, oms, p, clock = setup()
    oms.partial_exit(p, 5, 21.0, "partial_t1")
    b.settle()
    assert loop(oms, p)[0].startswith("held ")                          # within the hold: left to the sale
    clock.t += EXIT_HOLD_S + 0.1                                        # the sale was not asked again
    assert loop(oms, p) == ["protected ABC: stop for 10 @ 19.5"]
    assert resting(b) == [(10, 19.5)] and p.state == "in_position" and len(stops(b)) == 2


def test_a_partial_whose_broker_cannot_be_read_starts_no_hold():
    b, oms, p, _ = setup()
    b.fail_next_gets = 1                                                # no cancel is sent
    assert oms.partial_exit(p, 5, 21.0, "partial_t1") == 0
    assert not oms.held_for_exit(p) and p.exit_hold_stop == ""


def test_the_hold_of_a_deferred_partial_is_never_extended():
    b, oms, p, clock = setup()
    oms.partial_exit(p, 5, 21.0, "partial_t1")
    until = p.exit_hold_until
    clock.t += 10
    oms.partial_exit(p, 5, 21.0, "partial_t1")                          # deferred again on the same stop
    assert p.exit_hold_until == until


def test_a_deferred_partial_at_the_close_is_ended_by_end_hold():
    b, oms, p, _ = setup()
    oms.partial_exit(p, 5, 21.0, "partial_t1")                          # the last poll's try: deferred
    b.settle()
    oms.ensure_stop(p)
    assert resting(b) == []                                             # inside the hold: nothing placed
    oms.end_hold(p)                                                     # the after-close step
    oms.ensure_stop(p)
    assert resting(b) == [(10, 19.5)] and not oms.held_for_exit(p)


def test_a_deferred_move_lands_on_a_resized_stop_too():
    b, oms, p, _ = setup()
    oms.move_stop(p, 20.0)                                              # deferred: the old stop still rests
    b.pending.clear()
    b.slow = False
    b.pos["ABC"].qty = 6                                                # four shares left by another way
    oms.ensure_stop(p)                                                  # the old stop is the wrong size
    assert resting(b) == [(6, 20.0)] and p.stop == 20.0 and p.stop_deferred is None
    assert ["stop_moved", 19.5, 20.0, "deferred"] in p.log
