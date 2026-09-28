"""Broker-neutral types. Strategy/risk/OMS code must only use these (never broker SDK types)."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class OrderStatus(str, Enum):
    NEW = "new"
    ACCEPTED = "accepted"
    PARTIAL = "partial"
    FILLED = "filled"
    CANCELED = "canceled"
    REJECTED = "rejected"
    UNKNOWN = "unknown"

    @property
    def terminal(self) -> bool:
        return self in (OrderStatus.FILLED, OrderStatus.CANCELED, OrderStatus.REJECTED)


@dataclass
class Order:
    client_order_id: str
    symbol: str
    side: str                      # "buy" | "sell"
    qty: int
    type: str                      # "market" | "limit" | "stop" | "stop_limit"
    limit_price: float | None = None
    stop_price: float | None = None
    tif: str = "day"
    status: OrderStatus = OrderStatus.NEW
    filled_qty: int = 0
    avg_fill_price: float | None = None
    broker_id: str | None = None


@dataclass
class Position:
    symbol: str
    qty: int
    avg_price: float


@dataclass
class AccountState:
    equity: float
    cash: float
    buying_power: float
    is_paper: bool
    blocked: bool = False
    extra: dict = field(default_factory=dict)
