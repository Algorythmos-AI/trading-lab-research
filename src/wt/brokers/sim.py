"""In-memory broker for tests and fault injection (fills are driven explicitly by the test).

It behaves like Alpaca where it matters to the OMS:
  * a duplicate client order id raises DuplicateOrder, instead of being silently absorbed (audit H2: the silent
    dedupe hid id reuse from every test);
  * get_order returns None only for an unknown id;
  * positions are signed, so a sell larger than the position opens a short, as it would on a margin account.

Fault injection:
  fail_next_place        the next place raises TimeoutError *before* reaching the broker (order absent)
  lose_next_response     the next place reaches the broker, then raises TransportError (order present)
  fail_next_gets         the next N get_order calls raise TransportError
  fail_next_positions    the next N positions calls raise TransportError
  clock_fn               returns the broker's BrokerClock (the session tests drive it from the fake clock)
"""
from __future__ import annotations

import copy
from collections.abc import Callable

from wt.brokers.base import Broker, BrokerClock, DuplicateOrder, TransportError
from wt.core.types import AccountState, Order, OrderStatus, Position


class SimBroker(Broker):
    name = "sim"

    def __init__(self, cash: float = 25_000.0) -> None:
        self.cash = cash
        self.orders: dict[str, Order] = {}
        self.pos: dict[str, Position] = {}
        self.fail_next_place = False
        self.lose_next_response = False
        self.fail_next_gets = 0
        self.fail_next_positions = 0
        self.placed: list[str] = []            # every accepted client order id, in order
        self.clock_fn: Callable[[], BrokerClock] | None = None

    def account(self) -> AccountState:
        eq = self.cash + sum(p.qty * p.avg_price for p in self.pos.values())
        return AccountState(equity=eq, cash=self.cash, buying_power=self.cash, is_paper=True)

    def positions(self) -> list[Position]:
        if self.fail_next_positions:
            self.fail_next_positions -= 1
            raise TransportError("simulated positions timeout")
        return [copy.copy(p) for p in self.pos.values() if p.qty]

    def open_orders(self) -> list[Order]:
        return [copy.copy(o) for o in self.orders.values() if not o.status.terminal]

    def place(self, order: Order) -> Order:
        if self.fail_next_place:
            self.fail_next_place = False
            raise TimeoutError("simulated submit timeout (never reached the broker)")
        if order.client_order_id in self.orders:
            raise DuplicateOrder(f"client_order_id {order.client_order_id} already exists")
        o = copy.copy(order)
        o.status = OrderStatus.ACCEPTED
        self.orders[o.client_order_id] = o
        self.placed.append(o.client_order_id)
        if self.lose_next_response:
            self.lose_next_response = False
            raise TransportError("simulated lost response (order is at the broker)")
        return copy.copy(o)

    def cancel(self, client_order_id: str) -> None:
        o = self.orders.get(client_order_id)
        if o is not None and not o.status.terminal:
            o.status = OrderStatus.CANCELED

    def replace_stop(self, client_order_id: str, new_stop: float) -> Order:
        self.orders[client_order_id].stop_price = new_stop
        return copy.copy(self.orders[client_order_id])

    def get_order(self, client_order_id: str) -> Order | None:
        if self.fail_next_gets:
            self.fail_next_gets -= 1
            raise TransportError("simulated lookup timeout")
        o = self.orders.get(client_order_id)
        return copy.copy(o) if o is not None else None

    def clock(self) -> BrokerClock:
        if self.clock_fn is None:
            raise TransportError("simulated broker has no clock configured")
        return self.clock_fn()

    # --- test helpers ---
    def fill(self, cid: str, price: float, qty: int | None = None) -> None:
        o = self.orders[cid]
        q = qty or (o.qty - o.filled_qty)
        prev = o.filled_qty
        o.filled_qty += q
        o.avg_fill_price = price if prev == 0 or o.avg_fill_price is None else \
            (o.avg_fill_price * prev + price * q) / o.filled_qty
        o.status = OrderStatus.FILLED if o.filled_qty >= o.qty else OrderStatus.PARTIAL
        p = self.pos.setdefault(o.symbol, Position(o.symbol, 0, 0.0))
        if o.side == "buy":
            p.avg_price = (p.avg_price * p.qty + price * q) / (p.qty + q) if p.qty + q else 0.0
            p.qty += q
            self.cash -= price * q
        else:
            p.qty -= q
            self.cash += price * q

    def expire_day_orders(self) -> None:
        """The session ends: every DAY order that is still open expires (GTC orders survive)."""
        for o in self.orders.values():
            if not o.status.terminal and o.tif == "day":
                o.status = OrderStatus.CANCELED

    def own_sells(self, symbol: str) -> list[Order]:
        return [o for o in self.open_orders() if o.symbol == symbol and o.side == "sell"]
