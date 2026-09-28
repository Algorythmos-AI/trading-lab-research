"""Broker interface. Implementations: SimBroker (tests), AlpacaPaperBroker, WebullBroker (G3)."""
from __future__ import annotations

from abc import ABC, abstractmethod

from wt.core.types import AccountState, Order, Position


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
