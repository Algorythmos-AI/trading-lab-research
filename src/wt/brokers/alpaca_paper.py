"""Alpaca PAPER broker adapter. paper=True is hard-coded; there is no way to point this at a live account.
Bracket/OCO orders are deliberately not used so behaviour matches Webull (no OCO support)."""
from __future__ import annotations

from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (GetOrdersRequest, LimitOrderRequest, MarketOrderRequest, ReplaceOrderRequest,
                                     StopLimitOrderRequest, StopOrderRequest)

from wt.brokers.base import Broker
from wt.core.config import env
from wt.core.types import AccountState, Order, OrderStatus, Position

_MAP = {"new": OrderStatus.ACCEPTED, "accepted": OrderStatus.ACCEPTED, "pending_new": OrderStatus.ACCEPTED,
        "partially_filled": OrderStatus.PARTIAL, "filled": OrderStatus.FILLED, "canceled": OrderStatus.CANCELED,
        "expired": OrderStatus.CANCELED, "rejected": OrderStatus.REJECTED, "replaced": OrderStatus.CANCELED,
        "pending_cancel": OrderStatus.ACCEPTED, "pending_replace": OrderStatus.ACCEPTED}


class AlpacaPaperBroker(Broker):
    name = "alpaca_paper"

    def __init__(self):
        self.c = TradingClient(env("APCA_API_KEY_ID"), env("APCA_API_SECRET_KEY"), paper=True)

    @staticmethod
    def _to(o) -> Order:
        return Order(client_order_id=o.client_order_id, symbol=o.symbol, side=o.side.value, qty=int(float(o.qty)),
                     type=o.order_type.value, limit_price=float(o.limit_price) if o.limit_price else None,
                     stop_price=float(o.stop_price) if o.stop_price else None,
                     status=_MAP.get(o.status.value, OrderStatus.UNKNOWN), filled_qty=int(float(o.filled_qty or 0)),
                     avg_fill_price=float(o.filled_avg_price) if o.filled_avg_price else None, broker_id=str(o.id))

    def account(self) -> AccountState:
        a = self.c.get_account()
        return AccountState(equity=float(a.equity), cash=float(a.cash), buying_power=float(a.buying_power),
                            is_paper=True, blocked=bool(a.trading_blocked or a.account_blocked))

    def positions(self) -> list[Position]:
        return [Position(p.symbol, int(float(p.qty)), float(p.avg_entry_price)) for p in self.c.get_all_positions()]

    def open_orders(self) -> list[Order]:
        return [self._to(o) for o in self.c.get_orders(GetOrdersRequest(status=QueryOrderStatus.OPEN))]

    def place(self, order: Order) -> Order:
        side = OrderSide.BUY if order.side == "buy" else OrderSide.SELL
        kw = dict(symbol=order.symbol, qty=order.qty, side=side, time_in_force=TimeInForce.DAY,
                  client_order_id=order.client_order_id)
        if order.type == "market":
            req = MarketOrderRequest(**kw)
        elif order.type == "limit":
            req = LimitOrderRequest(limit_price=round(order.limit_price, 2), **kw)
        elif order.type == "stop":
            req = StopOrderRequest(stop_price=round(order.stop_price, 2), **kw)
        elif order.type == "stop_limit":
            req = StopLimitOrderRequest(stop_price=round(order.stop_price, 2), limit_price=round(order.limit_price, 2), **kw)
        else:
            raise ValueError(order.type)
        return self._to(self.c.submit_order(req))

    def cancel(self, client_order_id: str) -> None:
        o = self.c.get_order_by_client_id(client_order_id)
        self.c.cancel_order_by_id(o.id)

    def replace_stop(self, client_order_id: str, new_stop: float) -> Order:
        o = self.c.get_order_by_client_id(client_order_id)
        return self._to(self.c.replace_order_by_id(o.id, ReplaceOrderRequest(stop_price=round(new_stop, 2))))

    def get_order(self, client_order_id: str) -> Order | None:
        try:
            return self._to(self.c.get_order_by_client_id(client_order_id))
        except Exception:  # noqa: BLE001 — not found
            return None
