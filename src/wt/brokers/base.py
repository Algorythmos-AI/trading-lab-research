"""Broker interface. Implementations: SimBroker (tests), AlpacaPaperBroker, WebullBroker (G3).

Error contract (audit C3/M4): the OMS must be able to tell "the broker says this order does not exist" from "we
could not reach the broker". Mixing the two made a transport error look like a confirmed cancel, and a failed
lookup look like "never placed".

  * get_order returns None only when the broker answers "not found". Anything else raises TransportError.
  * place raises DuplicateOrder when the client order id is already taken, BrokerRejected for any other broker
    refusal, and TransportError when the outcome is unknown (timeout, connection reset, 5xx). After a
    TransportError the order may or may not exist: resolve it by id, never resubmit blindly.
  * cancel is a no-op for an order that is already terminal or unknown; confirm with get_order.
  * Position.qty is signed. Negative means short, which the paper account must never be.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from wt.core.types import AccountState, Order, Position


class TransportError(Exception):
    """The broker could not be reached, or its answer was lost. The order state is unknown."""


class BrokerRejected(Exception):
    """The broker received the request and refused it."""


class DuplicateOrder(BrokerRejected):
    """The client order id is already in use."""


class Broker(ABC):
    name: str = "base"

    @abstractmethod
    def account(self) -> AccountState: ...

    @abstractmethod
    def positions(self) -> list[Position]: ...

    @abstractmethod
    def open_orders(self) -> list[Order]: ...

    @abstractmethod
    def place(self, order: Order) -> Order: ...

    @abstractmethod
    def cancel(self, client_order_id: str) -> None: ...

    @abstractmethod
    def replace_stop(self, client_order_id: str, new_stop: float) -> Order: ...

    @abstractmethod
    def get_order(self, client_order_id: str) -> Order | None: ...
