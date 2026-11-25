"""A broker handle that can only look and cancel (plan R6, loophole L10).

`make rollback` must cancel this repo's resting orders before older code takes over, and nothing more. It gets a
CancelOnlyClient: positions, open orders and cancel. There is no place or replace, so a bug in the rollback path
can't open or enlarge exposure. The wrapped broker is held in a name-mangled slot and never returned.

Only wt.live (the runner) and this module may import the full paper broker; tests/unit/test_broker_isolation.py
enforces that across src/ and scripts/.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from wt.core.types import Order, Position


class CancelOnlyClient:
    __slots__ = ("__b",)

    def __init__(self, broker: Any) -> None:
        self.__b = broker

    def positions(self) -> list[Position]:
        out: list[Position] = self.__b.positions()
        return out

    def open_orders(self) -> list[Order]:
        out: list[Order] = self.__b.open_orders()
        return out

    def cancel(self, client_order_id: str) -> None:
        self.__b.cancel(client_order_id)


def connect(factory: Callable[[], Any] | None = None, keys: tuple[str, str] | None = None) -> CancelOnlyClient:
    """The paper broker (paper-only lock asserted at construction), wrapped. `keys`: another paper account's key
    pair (a desk's own account: Gap Hunter's APCA_S_, the clone's APCA_CLONE_); the default is the APCA_API_ pair's.
    `factory` is for tests."""
    if factory is None:
        from wt.brokers.alpaca_paper import AlpacaPaperBroker
        if keys is None:
            factory = AlpacaPaperBroker
        else:
            kid, secret = keys
            def factory() -> Any:
                return AlpacaPaperBroker(key_id=kid, secret=secret)
    return CancelOnlyClient(factory())
