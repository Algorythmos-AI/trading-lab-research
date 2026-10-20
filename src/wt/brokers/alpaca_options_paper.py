"""The options clone's Alpaca PAPER adapter (DEC-0030). Only the clone's runner (wt.live.runner_o) may import it.

Paper only, three ways: the trading client is built with `paper=True`; at construction the paper lock checks the
endpoint and that the account number is a paper one; before every order it checks the environment again. It can
buy to open and sell to close a single option contract with a limit, market or stop order, cancel an order and read
orders and option positions. It never closes all positions, exercises, replaces or sends a multi-leg order.

Keys: the clone's own account (`APCA_CLONE_KEY_ID` / `APCA_CLONE_SECRET_KEY`) when both are set, otherwise the
second paper account (`APCA_OPTIONS_KEY_ID` / `APCA_OPTIONS_SECRET_KEY`), which the owner also trades by hand.

Errors follow the Broker contract (wt.brokers.base): None from get_order only for "not found", TransportError when
the outcome is unknown, BrokerRejected or DuplicateOrder when the broker refused.
"""
from __future__ import annotations

import os
from typing import Any

import requests
from alpaca.common.exceptions import APIError
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import GetOrdersRequest, LimitOrderRequest, MarketOrderRequest, StopOrderRequest

from wt.brokers.base import Broker, BrokerClock, BrokerRejected, DuplicateOrder, TransportError
from wt.core.safety import assert_paper, assert_paper_env
from wt.core.types import AccountState, Order, OrderStatus, Position

# The broker's order statuses, as the stock adapter maps them (kept apart so this module never imports it).
_MAP = {"new": OrderStatus.ACCEPTED, "accepted": OrderStatus.ACCEPTED, "pending_new": OrderStatus.ACCEPTED,
        "accepted_for_bidding": OrderStatus.ACCEPTED, "held": OrderStatus.ACCEPTED, "calculated": OrderStatus.ACCEPTED,
        "partially_filled": OrderStatus.PARTIAL, "filled": OrderStatus.FILLED, "done_for_day": OrderStatus.CANCELED,
        "canceled": OrderStatus.CANCELED, "expired": OrderStatus.CANCELED, "rejected": OrderStatus.REJECTED,
        "suspended": OrderStatus.REJECTED, "replaced": OrderStatus.CANCELED, "pending_cancel": OrderStatus.ACCEPTED,
        "pending_replace": OrderStatus.ACCEPTED, "stopped": OrderStatus.ACCEPTED}
TIMEOUT = (3.05, 10.0)         # connect, read (seconds)
CLONE_KEYS = ("APCA_CLONE_KEY_ID", "APCA_CLONE_SECRET_KEY")
SHARED_KEYS = ("APCA_OPTIONS_KEY_ID", "APCA_OPTIONS_SECRET_KEY")


def _status(e: APIError) -> int | None:
    try:
        return int(e.status_code)
    except (TypeError, ValueError, AttributeError):
        return None


def keys(environ: dict[str, str] | None = None) -> tuple[str, str, bool] | None:
    """The key pair to trade with and whether the account is the clone's own, or None when neither pair is set."""
    e = os.environ if environ is None else environ
    for pair, own in ((CLONE_KEYS, True), (SHARED_KEYS, False)):
        k, s = e.get(pair[0], "").strip(), e.get(pair[1], "").strip()
        if k and s:
            return k, s, own
    return None


class AlpacaOptionsPaperBroker(Broker):
    name = "alpaca_options_paper"

    def __init__(self, key_id: str, secret: str, own_account: bool, timeout: tuple[float, float] = TIMEOUT) -> None:
        self.own_account = own_account
        self.c = TradingClient(key_id, secret, paper=True)
        self.c._retry = 0                                   # single try; the OMS resolves by id
        orig = self.c._session.request

        def request(method: str, url: str, **kw: Any) -> Any:
            kw.setdefault("timeout", timeout)
            kw["allow_redirects"] = False                   # a redirect would carry the key headers elsewhere
            return orig(method, url, **kw)
        self.c._session.request = request                   # type: ignore[method-assign,assignment]
        acct: Any = self.c.get_account()
        base = getattr(self.c._base_url, "value", str(self.c._base_url))
        assert_paper(str(base), str(acct.account_number))
        self._level = acct

    def options_level(self) -> int | None:
        """The account's approved options trading level as the broker reports it, or None if it does not say."""
        for name in ("options_trading_level", "options_approved_level"):
            v = getattr(self._level, name, None)
            if v is not None:
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return None
        return None

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
        self._level = a
        return AccountState(equity=float(a.equity), cash=float(a.cash), buying_power=float(a.buying_power),
                            is_paper=str(a.account_number).startswith("PA"),
                            blocked=bool(a.trading_blocked or a.account_blocked))

    def clock(self) -> BrokerClock:
        try:
            c: Any = self.c.get_clock()
        except (APIError, requests.RequestException) as e:
            raise TransportError(e.__class__.__name__) from e
        return BrokerClock(timestamp=c.timestamp, is_open=bool(c.is_open), next_open=c.next_open,
                           next_close=c.next_close)

    def positions(self) -> list[Position]:
        """Every position in the account, options and stock alike (a stock position after an exercise must be
        seen). Quantities are signed: a short is negative."""
        try:
            raw: list[Any] = list(self.c.get_all_positions())
        except (APIError, requests.RequestException) as e:
            raise TransportError(e.__class__.__name__) from e
        out = []
        for p in raw:
            q = int(float(p.qty))
            if getattr(p.side, "value", str(p.side)) == "short" and q > 0:
                q = -q
            out.append(Position(p.symbol, q, float(p.avg_entry_price)))
        return out

    def marks(self) -> dict[str, float]:
        """Each option position's current price per share, as the broker marks it (the second source of the mark)."""
        try:
            raw: list[Any] = list(self.c.get_all_positions())
        except (APIError, requests.RequestException) as e:
            raise TransportError(e.__class__.__name__) from e
        out: dict[str, float] = {}
        for p in raw:
            try:
                out[str(p.symbol)] = float(p.current_price)
            except (TypeError, ValueError):
                continue
        return out

    def open_orders(self) -> list[Order]:
        try:
            raw: list[Any] = list(self.c.get_orders(GetOrdersRequest(status=QueryOrderStatus.OPEN)))
        except (APIError, requests.RequestException) as e:
            raise TransportError(e.__class__.__name__) from e
        return [self._to(o) for o in raw]

    def place(self, order: Order) -> Order:
        assert_paper_env()
        if order.qty != 1:
            raise BrokerRejected("the clone trades one contract")           # the guard refuses it first
        side = OrderSide.BUY if order.side == "buy" else OrderSide.SELL
        kw: dict[str, Any] = dict(symbol=order.symbol, qty=order.qty, side=side, time_in_force=TimeInForce.DAY,
                                  client_order_id=order.client_order_id)
        req: Any
        if order.type == "market":
            req = MarketOrderRequest(**kw)
        elif order.type == "limit":
            req = LimitOrderRequest(limit_price=round(float(order.limit_price or 0), 2), **kw)
        elif order.type == "stop" and order.side == "sell":
            req = StopOrderRequest(stop_price=round(float(order.stop_price or 0), 2), **kw)
        else:
            raise ValueError(f"{order.side} {order.type}")
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
            if _status(e) in (404, 422):                    # unknown, or no longer cancelable
                return
            raise TransportError(f"{_status(e)}: {str(e)[:120]}") from e
        except requests.RequestException as e:
            raise TransportError(e.__class__.__name__) from e

    def replace_stop(self, client_order_id: str, new_stop: float) -> Order:
        raise BrokerRejected("the clone never replaces an order: it cancels, confirms and sends a new one")

    def get_order(self, client_order_id: str) -> Order | None:
        try:
            return self._to(self.c.get_order_by_client_id(client_order_id))
        except APIError as e:
            if _status(e) == 404:
                return None
            raise TransportError(f"{_status(e)}: {str(e)[:120]}") from e
        except requests.RequestException as e:
            raise TransportError(e.__class__.__name__) from e
