"""Minimal OMS for one position at a time (Step 4 minimum safety set).

Rules (plan R1/R14/R15):
  * Entry = stop-limit buy. The moment it (partially) fills, a SERVER-SIDE stop sell rests at the broker
    for the filled quantity (resized on further partial fills).
  * Exactly ONE resting exit order at any time. Target / discretionary exit = cancel stop -> confirm
    cancel -> read broker position -> sell min(position, intended) with a marketable limit; if that
    doesn't fill in `sell_timeout_s`, re-place the protective stop and retry next loop.
  * Submit timeouts are resolved by looking the order up by client_order_id — never blind re-submit.
  * Broker is the source of truth (reconcile()).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from wt.brokers.base import Broker
from wt.core.ids import coid, is_ours
from wt.core.types import Order, OrderStatus


@dataclass
class TradePlan:
    date: str
    strategy: str
    symbol: str
    qty: int
    trigger: float
    limit: float
    stop: float
    target: float
    attempt: int = 0
    entry_id: str = ""
    stop_id: str = ""
    exit_id: str = ""
    filled_qty: int = 0
    avg_entry: float | None = None
    state: str = "planned"      # planned|entry_working|in_position|exiting|closed|aborted
    log: list = field(default_factory=list)


class OMS:
    def __init__(self, broker: Broker, sell_timeout_s: float = 10.0, sleep=time.sleep):
        self.b, self.sell_timeout_s, self.sleep = broker, sell_timeout_s, sleep

    # ---- helpers ------------------------------------------------------------------------------
    def _submit(self, order: Order) -> Order:
        try:
            return self.b.place(order)
        except Exception as e:  # noqa: BLE001 — timeout/unknown: resolve by id, never blind-retry
            found = self.b.get_order(order.client_order_id)
            if found is not None:
                return found
            raise RuntimeError(f"submit failed and order not found: {order.client_order_id}") from e

    def _position_qty(self, symbol: str) -> int:
        return sum(p.qty for p in self.b.positions() if p.symbol == symbol)

    # ---- lifecycle ----------------------------------------------------------------------------
    def place_entry(self, p: TradePlan) -> None:
        p.entry_id = coid(p.date, p.strategy, p.symbol, "entry", p.attempt)
        self._submit(Order(p.entry_id, p.symbol, "buy", p.qty, "stop_limit", limit_price=p.limit, stop_price=p.trigger))
        p.state = "entry_working"
        p.log.append(("entry_placed", p.trigger, p.limit, p.qty))

    def sync(self, p: TradePlan) -> None:
        """Called every loop: react to fills; keep the protective stop sized to the position."""
        if p.state == "entry_working":
            e = self.b.get_order(p.entry_id)
            if e and e.filled_qty > p.filled_qty:
                p.filled_qty, p.avg_entry = e.filled_qty, e.avg_fill_price
                self._ensure_stop(p)
                if e.status == OrderStatus.FILLED:
                    p.state = "in_position"
            elif e and e.status in (OrderStatus.CANCELED, OrderStatus.REJECTED) and p.filled_qty == 0:
                p.state = "aborted"
        if p.state in ("in_position", "exiting"):
            if self._position_qty(p.symbol) == 0:
                p.state = "closed"
                p.log.append(("flat",))

    def _ensure_stop(self, p: TradePlan) -> None:
        if not p.stop_id:
            p.stop_id = coid(p.date, p.strategy, p.symbol, "stop", p.attempt)
            self._submit(Order(p.stop_id, p.symbol, "sell", p.filled_qty, "stop", stop_price=p.stop))
            p.log.append(("stop_placed", p.stop, p.filled_qty))
        else:
            s = self.b.get_order(p.stop_id)
            if s and not s.status.terminal and s.qty != p.filled_qty:     # resize after partial fill
                self.b.cancel(p.stop_id)
                p.stop_id = coid(p.date, p.strategy, p.symbol, f"stop_q{p.filled_qty}", p.attempt)
                self._submit(Order(p.stop_id, p.symbol, "sell", p.filled_qty, "stop", stop_price=p.stop))
                p.log.append(("stop_resized", p.filled_qty))

    def cancel_entry_remainder(self, p: TradePlan) -> None:
        e = self.b.get_order(p.entry_id)
        if e and not e.status.terminal:
            self.b.cancel(p.entry_id)
            p.log.append(("entry_remainder_canceled", e.qty - e.filled_qty))
        if p.filled_qty == 0:
            p.state = "aborted"

    def exit_now(self, p: TradePlan, limit_price: float, reason: str) -> bool:
        """Cancel stop -> confirm -> sell min(position, intended). Returns True when flat."""
        s = self.b.get_order(p.stop_id) if p.stop_id else None
        if s and not s.status.terminal:
            self.b.cancel(p.stop_id)
        for _ in range(20):                                       # confirm cancel (or stop already filled)
            s = self.b.get_order(p.stop_id) if p.stop_id else None
            if s is None or s.status.terminal:
                break
            self.sleep(0.25)
        qty = self._position_qty(p.symbol)
        if qty == 0:
            p.state = "closed"
            p.log.append(("exit_not_needed_stop_filled", reason))
            return True
        p.exit_id = coid(p.date, p.strategy, p.symbol, f"exit_{reason}", p.attempt)
        self._submit(Order(p.exit_id, p.symbol, "sell", min(qty, p.filled_qty), "limit", limit_price=limit_price))
        p.state = "exiting"
        waited = 0.0
        while waited < self.sell_timeout_s:
            x = self.b.get_order(p.exit_id)
            if x and x.status == OrderStatus.FILLED:
                p.state = "closed"
                p.log.append(("exited", reason, x.avg_fill_price))
                return True
            self.sleep(0.5)
            waited += 0.5
        # not filled: cancel exit, re-protect with a stop, caller retries next loop
        self.b.cancel(p.exit_id)
        rem = self._position_qty(p.symbol)
        if rem > 0:
            p.filled_qty = rem
            p.stop_id = coid(p.date, p.strategy, p.symbol, f"restop_{reason}_{int(waited)}", p.attempt)
            self._submit(Order(p.stop_id, p.symbol, "sell", rem, "stop", stop_price=p.stop))
            p.state = "in_position"
            p.log.append(("exit_unfilled_restopped", rem))
        return False


def reconcile(broker: Broker, known_symbols: set[str], stop_for: dict[str, float],
              managed: set[str] | None = None) -> list[str]:
    """Broker = source of truth. Fix drift: unprotected positions get a stop (or are flagged if unknown);
    stray orders with our prefix for symbols we don't manage are cancelled. Returns actions taken."""
    actions = []
    orders = broker.open_orders()
    protected = {o.symbol for o in orders if o.side == "sell" and o.type in ("stop", "stop_limit")}
    for pos in broker.positions():
        if pos.qty <= 0 or pos.symbol in protected:
            continue
        if managed is not None and pos.symbol not in managed:
            continue              # positions outside this strategy's symbols are not ours to manage
        if pos.symbol in stop_for:
            cid = coid("reconcile", "wt", pos.symbol, f"stop_{pos.qty}")
            broker.place(Order(cid, pos.symbol, "sell", pos.qty, "stop", stop_price=stop_for[pos.symbol]))
            actions.append(f"placed missing stop {pos.symbol} x{pos.qty} @ {stop_for[pos.symbol]}")
        else:
            actions.append(f"UNKNOWN unprotected position {pos.symbol} x{pos.qty} -> flatten required")
    for o in orders:
        if is_ours(o.client_order_id) and o.symbol not in known_symbols:
            broker.cancel(o.client_order_id)
            actions.append(f"cancelled stray order {o.client_order_id} {o.symbol}")
    return actions
