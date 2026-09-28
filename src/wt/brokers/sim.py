"""In-memory broker for tests and fault injection (fills driven explicitly by the test)."""
from __future__ import annotations

import copy

from wt.brokers.base import Broker
from wt.core.types import AccountState, Order, OrderStatus, Position


class SimBroker(Broker):
    name = "sim"

    def __init__(self, cash: float = 25_000.0):
        self.cash, self.orders, self.pos = cash, {}, {}
        self.fail_next_place = False

    def account(self):
        eq = self.cash + sum(p.qty * p.avg_price for p in self.pos.values())
        return AccountState(equity=eq, cash=self.cash, buying_power=self.cash, is_paper=True)

    def positions(self):
        return [copy.copy(p) for p in self.pos.values() if p.qty]

    def open_orders(self):
        return [copy.copy(o) for o in self.orders.values() if not o.status.terminal]

    def place(self, order):
        if self.fail_next_place:
            self.fail_next_place = False
            raise TimeoutError("simulated submit timeout")
        if order.client_order_id in self.orders:
            return copy.copy(self.orders[order.client_order_id])      # idempotent
        o = copy.copy(order)
        o.status = OrderStatus.ACCEPTED
        self.orders[o.client_order_id] = o
        return copy.copy(o)

    def cancel(self, cid):
        o = self.orders[cid]
        if not o.status.terminal:
            o.status = OrderStatus.CANCELED

    def replace_stop(self, cid, new_stop):
        self.orders[cid].stop_price = new_stop
        return copy.copy(self.orders[cid])

    def get_order(self, cid):
        return copy.copy(self.orders.get(cid)) if cid in self.orders else None

    # --- test helpers ---
    def fill(self, cid, price, qty=None):
        o = self.orders[cid]
        q = qty or (o.qty - o.filled_qty)
        o.filled_qty += q
        o.avg_fill_price = price
        o.status = OrderStatus.FILLED if o.filled_qty >= o.qty else OrderStatus.PARTIAL
        p = self.pos.setdefault(o.symbol, Position(o.symbol, 0, 0.0))
        if o.side == "buy":
            p.avg_price = (p.avg_price * p.qty + price * q) / (p.qty + q)
            p.qty += q
            self.cash -= price * q
        else:
            p.qty -= q
            self.cash += price * q
