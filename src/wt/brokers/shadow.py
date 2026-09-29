"""The shadow host's broker: reads pass through, every order call raises (ADR 0004, shadow run).

During the shadow run the OCI host runs the real jobs against a second paper account to prove it behaves like the
Mac, and must never send an order. The runner also turns entries off for the whole session on a shadow host; this
wrapper is the second, independent guarantee that nothing can reach the broker's order endpoints.
"""
from __future__ import annotations

from wt.brokers.base import Broker, BrokerClock, BrokerRejected
from wt.core.types import AccountState, Order, Position


class ShadowRole(BrokerRejected):
    """An order call on the shadow host."""


class ShadowBroker(Broker):
    name = "shadow"

    def __init__(self, inner: Broker) -> None:
        self._inner = inner

    def account(self) -> AccountState:
        return self._inner.account()

    def positions(self) -> list[Position]:
        return self._inner.positions()

    def open_orders(self) -> list[Order]:
        return self._inner.open_orders()

    def get_order(self, client_order_id: str) -> Order | None:
        return self._inner.get_order(client_order_id)

    def clock(self) -> BrokerClock:
        return self._inner.clock()

    def place(self, order: Order) -> Order:
        raise ShadowRole(f"the shadow host never sends orders (refused {order.side} {order.symbol})")

    def cancel(self, client_order_id: str) -> None:
        raise ShadowRole("the shadow host never cancels orders")

    def replace_stop(self, client_order_id: str, new_stop: float) -> Order:
        raise ShadowRole("the shadow host never replaces orders")
