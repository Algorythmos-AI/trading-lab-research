"""Alpaca PAPER broker adapter. paper=True is hard-coded, and the paper-only lock (wt.core.safety) is asserted at
construction and before every order, so this class can't reach a live account.

Bracket/OCO orders are deliberately not used, so behaviour matches Webull (no OCO support).

Reliability (audit H1, C3):
  * Every HTTP call has a timeout and is tried once. alpaca-py's own retries are off, and the OMS decides what to
    do next.
  * Errors follow the Broker contract: None only for "not found", TransportError when the outcome is unknown,
    BrokerRejected or DuplicateOrder when the broker refused.
"""
from __future__ import annotations

from typing import Any

import requests
from alpaca.common.exceptions import APIError
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (GetOrdersRequest, LimitOrderRequest, MarketOrderRequest, ReplaceOrderRequest,
                                     StopLimitOrderRequest, StopOrderRequest)

from wt.brokers.base import Broker, BrokerRejected, DuplicateOrder, TransportError
from wt.core.config import env
from wt.core.safety import assert_paper, assert_paper_env
from wt.core.types import AccountState, Order, OrderStatus, Position

_MAP = {"new": OrderStatus.ACCEPTED, "accepted": OrderStatus.ACCEPTED, "pending_new": OrderStatus.ACCEPTED,
        "accepted_for_bidding": OrderStatus.ACCEPTED, "held": OrderStatus.ACCEPTED, "calculated": OrderStatus.ACCEPTED,
        "partially_filled": OrderStatus.PARTIAL, "filled": OrderStatus.FILLED, "done_for_day": OrderStatus.CANCELED,
        "canceled": OrderStatus.CANCELED, "expired": OrderStatus.CANCELED, "rejected": OrderStatus.REJECTED,
        "suspended": OrderStatus.REJECTED, "replaced": OrderStatus.CANCELED, "pending_cancel": OrderStatus.ACCEPTED,
        "pending_replace": OrderStatus.ACCEPTED, "stopped": OrderStatus.ACCEPTED}
TIMEOUT = (3.05, 10.0)         # connect, read (seconds)


def _status(e: APIError) -> int | None:
    try:
        return int(e.status_code)
    except (TypeError, ValueError, AttributeError):
        return None


class AlpacaPaperBroker(Broker):
    name = "alpaca_paper"

    def __init__(self, timeout: tuple[float, float] = TIMEOUT) -> None:
        self.c = TradingClient(env("APCA_API_KEY_ID"), env("APCA_API_SECRET_KEY"), paper=True)
        self.c._retry = 0                                   # single try; the OMS resolves by id
        orig = self.c._session.request

        def request(method: str, url: str, **kw: Any) -> Any:
            kw.setdefault("timeout", timeout)
            return orig(method, url, **kw)
        self.c._session.request = request                   # type: ignore[method-assign,assignment]
        acct: Any = self.c.get_account()
        base = getattr(self.c._base_url, "value", str(self.c._base_url))
        assert_paper(str(base), str(acct.account_number))

    @staticmethod
    def _to(o: Any) -> Order:
        return Order(client_order_id=o.client_order_id, symbol=o.symbol, side=o.side.value, qty=int(float(o.qty)),
                     type=o.order_type.value, limit_price=float(o.limit_price) if o.limit_price else None,
                     stop_price=float(o.stop_price) if o.stop_price else None,
                     tif=getattr(o.time_in_force, "value", "day"),
                     status=_MAP.get(o.status.value, OrderStatus.UNKNOWN), filled_qty=int(float(o.filled_qty or 0)),
                     avg_fill_price=float(o.filled_avg_price) if o.filled_avg_price else None, broker_id=str(o.id))

    def account(self) -> AccountState:
        try:
            a: Any = self.c.get_account()
        except (APIError, requests.RequestException) as e:
            raise TransportError(e.__class__.__name__) from e
        return AccountState(equity=float(a.equity), cash=float(a.cash), buying_power=float(a.buying_power),
                            is_paper=str(a.account_number).startswith("PA"),
                            blocked=bool(a.trading_blocked or a.account_blocked))

    def positions(self) -> list[Position]:
        try:
            raw: list[Any] = list(self.c.get_all_positions())
        except (APIError, requests.RequestException) as e:
            raise TransportError(e.__class__.__name__) from e
        out = []
        for p in raw:
            q = int(float(p.qty))
            if getattr(p.side, "value", str(p.side)) == "short" and q > 0:
                q = -q                                      # signed: short is negative
            out.append(Position(p.symbol, q, float(p.avg_entry_price)))
        return out

    def open_orders(self) -> list[Order]:
        try:
            raw: list[Any] = list(self.c.get_orders(GetOrdersRequest(status=QueryOrderStatus.OPEN)))
        except (APIError, requests.RequestException) as e:
            raise TransportError(e.__class__.__name__) from e
        return [self._to(o) for o in raw]

    def place(self, order: Order) -> Order:
        assert_paper_env()
        side = OrderSide.BUY if order.side == "buy" else OrderSide.SELL
        tif = TimeInForce.GTC if order.tif == "gtc" else TimeInForce.DAY
        kw: dict[str, Any] = dict(symbol=order.symbol, qty=order.qty, side=side, time_in_force=tif,
                                  client_order_id=order.client_order_id)
        req: Any
        if order.type == "market":
            req = MarketOrderRequest(**kw)
        elif order.type == "limit":
            req = LimitOrderRequest(limit_price=round(float(order.limit_price or 0), 2), **kw)
        elif order.type == "stop":
            req = StopOrderRequest(stop_price=round(float(order.stop_price or 0), 2), **kw)
        elif order.type == "stop_limit":
            req = StopLimitOrderRequest(stop_price=round(float(order.stop_price or 0), 2),
                                        limit_price=round(float(order.limit_price or 0), 2), **kw)
        else:
            raise ValueError(order.type)
        try:
            return self._to(self.c.submit_order(req))
        except APIError as e:
            code, msg = _status(e), str(e)[:200]
            if code == 422 and "client_order_id" in msg.lower():
                raise DuplicateOrder(msg) from e
            if code is not None and 400 <= code < 500:
                raise BrokerRejected(f"{code}: {msg}") from e
            raise TransportError(f"{code}: {msg}") from e
        except requests.RequestException as e:
            raise TransportError(e.__class__.__name__) from e

    def cancel(self, client_order_id: str) -> None:
        try:
            o: Any = self.c.get_order_by_client_id(client_order_id)
            self.c.cancel_order_by_id(o.id)
        except APIError as e:
            if _status(e) in (404, 422):                    # unknown, or no longer cancelable (filled/canceled)
                return
            raise TransportError(f"{_status(e)}: {str(e)[:120]}") from e
        except requests.RequestException as e:
            raise TransportError(e.__class__.__name__) from e

    def replace_stop(self, client_order_id: str, new_stop: float) -> Order:
        try:
            o: Any = self.c.get_order_by_client_id(client_order_id)
            return self._to(self.c.replace_order_by_id(o.id, ReplaceOrderRequest(stop_price=round(new_stop, 2))))
        except APIError as e:
            code = _status(e)
            if code is not None and 400 <= code < 500:
                raise BrokerRejected(f"{code}: {str(e)[:120]}") from e
            raise TransportError(f"{code}: {str(e)[:120]}") from e
        except requests.RequestException as e:
            raise TransportError(e.__class__.__name__) from e

    def get_order(self, client_order_id: str) -> Order | None:
        try:
            return self._to(self.c.get_order_by_client_id(client_order_id))
        except APIError as e:
            if _status(e) == 404:
                return None
            raise TransportError(f"{_status(e)}: {str(e)[:120]}") from e
        except requests.RequestException as e:
            raise TransportError(e.__class__.__name__) from e
