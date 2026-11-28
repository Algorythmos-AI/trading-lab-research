"""DEC-0071: a stop an exit asked to cancel, without a confirmation, is not replaced while that exit is asked again.

On 2026-10-27 and 2026-11-11 the end-of-day exit could not confirm its stop's cancel; the next loop's reconcile put a
fresh stop back and the exit had to cancel that one too (one to two rounds, about a minute). Each test runs the
runners' loop order: sync, reconcile, then the exit."""
from __future__ import annotations

from wt.brokers.sim import SimBroker
from wt.core.types import Order, OrderStatus
from wt.oms.manager import EXIT_HOLD_S, OMS, PlanStore, TradePlan


class SlowCancel(SimBroker):
    """A cancel the broker accepts but reports only later: the order stays working until `settle`."""

    def __init__(self) -> None:
        super().__init__()
        self.pending: set[str] = set()

    def cancel(self, client_order_id: str) -> None:
        o = self.orders.get(client_order_id)
        if o is not None and not o.status.terminal:
            self.pending.add(client_order_id)

    def settle(self) -> None:
        for cid in self.pending:
            if not self.orders[cid].status.terminal:
                self.orders[cid].status = OrderStatus.CANCELED
        self.pending.clear()

    def place(self, order: Order) -> Order:
        r = super().place(order)
        if order.side == "sell" and order.type == "market":
            self.fill(order.client_order_id, 250.10)
        return r


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


def setup(store: PlanStore | None = None) -> tuple[SlowCancel, OMS, TradePlan, Clock]:
    b, clock = SlowCancel(), Clock()
    oms = OMS(b, sell_timeout_s=1.0, sleep=lambda s: None, strategy="B", clock=clock, unguarded=True,
              persist=store.save if store else None)
    p = TradePlan(date="2026-09-30", strategy="B", symbol="QQQM", qty=2, trigger=250.0, limit=250.2, stop=249.0,
                  target=252.0)
    oms.place_entry(p)
    b.fill(p.entry_id, 250.05)
    oms.sync(p)
    assert p.state == "in_position" and p.stop_id
    return b, oms, p, clock


def stops(b: SimBroker) -> list[str]:
    return [cid for cid in b.placed if b.orders[cid].type == "stop"]


def loop(oms: OMS, p: TradePlan) -> tuple[list[str], bool]:
    oms.sync(p)
    acts = oms.reconcile({p.symbol}, {}, plan=p) if p.active else []
    flat = oms.exit_now(p, None, "eod_market", market=True) if p.active else True
    return acts, flat


def test_a_cancel_confirmed_late_is_sold_on_the_next_loop_without_a_second_stop():
    b, oms, p, _ = setup()
    assert oms.exit_now(p, None, "eod_market", market=True) is False      # the cancel is not confirmed yet
    assert "exit_deferred" in str(p.log[-1])
    b.settle()                                                            # the broker reports it cancelled
    acts, flat = loop(oms, p)
    assert flat and p.state == "closed" and p.exit_reason == "eod_market"
    assert len(stops(b)) == 1                                             # no fresh stop to cancel once more
    assert acts == ["held QQQM: stop cancelled for an exit that is due; not replaced"]
    assert b.positions() == [] and b.open_orders() == []


def test_a_cancel_still_pending_keeps_the_old_stop_covering_the_position():
    b, oms, p, _ = setup()
    oms.exit_now(p, None, "eod_market", market=True)
    acts, flat = loop(oms, p)                                             # the broker has still not answered
    assert not flat and acts == [] and len(stops(b)) == 1
    assert b.orders[p.stop_id].status == OrderStatus.ACCEPTED             # the old stop still rests for the shares
    assert not [cid for cid in b.placed if b.orders[cid].side == "sell" and b.orders[cid].type != "stop"]


def test_an_exit_not_asked_again_gets_its_stop_back_after_the_hold():
    b, oms, p, clock = setup()
    oms.exit_now(p, None, "target", market=True)
    b.settle()
    oms.sync(p)
    assert oms.reconcile({p.symbol}, {}, plan=p)[0].startswith("held ")  # within the hold: left to the exit
    clock.t += EXIT_HOLD_S + 0.1                                          # the exit was not asked again
    oms.sync(p)
    acts = oms.reconcile({p.symbol}, {}, plan=p)
    assert acts == ["protected QQQM: stop for 2 @ 249.0"] and len(stops(b)) == 2
    assert b.orders[p.stop_id].status == OrderStatus.ACCEPTED and p.state == "in_position"


def test_the_hold_starts_once_per_stop_and_is_never_extended():
    b, oms, p, clock = setup()
    oms.exit_now(p, None, "eod_market", market=True)
    until = p.exit_hold_until
    clock.t += 10
    oms.exit_now(p, None, "eod_market", market=True)                      # deferred again on the same stop
    assert p.exit_hold_until == until
    clock.t += EXIT_HOLD_S
    b.settle()
    oms.sync(p)
    assert oms.reconcile({p.symbol}, {}, plan=p) == ["protected QQQM: stop for 2 @ 249.0"]
    assert not oms.held_for_exit(p)                                       # a stop placed since is never held


def test_a_restart_inside_the_hold_still_sells_and_after_it_protects(tmp_path):
    store = PlanStore(tmp_path / "plan.json")
    b, oms, p, clock = setup(store)
    oms.exit_now(p, None, "eod_market", market=True)
    b.settle()
    q = store.load()
    assert q is not None and q.exit_hold_stop == p.stop_id
    oms2 = OMS(b, sell_timeout_s=1.0, sleep=lambda s: None, strategy="B", clock=clock, unguarded=True, persist=store.save)
    acts, flat = loop(oms2, q)
    assert flat and q.state == "closed" and len(stops(b)) == 1 and acts[0].startswith("held ")
    # the same restart after the hold has run out: protected first, then the exit cancels that stop as usual
    b2, oms3, p3, clock3 = setup(PlanStore(tmp_path / "plan2.json"))
    oms3.exit_now(p3, None, "eod_market", market=True)
    b2.settle()
    clock3.t += EXIT_HOLD_S + 1
    oms3.sync(p3)
    assert oms3.reconcile({p3.symbol}, {}, plan=p3) == ["protected QQQM: stop for 2 @ 249.0"]


def test_a_stop_that_filled_instead_of_cancelling_closes_the_plan_as_a_stop():
    b, oms, p, _ = setup()
    oms.exit_now(p, None, "eod_market", market=True)
    b.pending.clear()
    b.fill(p.stop_id, 248.95)                                             # the stop traded before the cancel
    acts, flat = loop(oms, p)
    assert flat and p.state == "closed" and p.exit_reason == "stop" and p.exit_fill_price == 248.95
    assert not [cid for cid in b.placed if b.orders[cid].type == "market"]
    assert b.positions() == []


def test_a_hold_still_running_at_the_close_ends_so_the_overnight_stop_goes_in():
    """The after-close path (runner_s) ends the hold before it asks for the overnight stop: no exit is asked again
    after the session, so a hold begun in its last seconds must not leave the shares without a stop."""
    b, oms, p, clock = setup()
    oms.exit_now(p, None, "eod_verify", market=True)                      # the last poll: deferred
    b.settle()                                                            # the cancel lands as the session ends
    oms.ensure_stop(p)
    assert len(stops(b)) == 1 and b.orders[p.stop_id].status.terminal     # inside the hold: nothing placed
    oms.end_hold(p)
    oms.ensure_stop(p)
    assert len(stops(b)) == 2 and b.orders[p.stop_id].status == OrderStatus.ACCEPTED
    assert not oms.held_for_exit(p) and p.exit_hold_until == 0.0

