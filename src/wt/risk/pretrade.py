"""Pre-trade guard enforced inside the OMS for every order (audit M3). Pattern: order_guard.evaluate() -> {ok, checks}.

Two kinds of order:
  * entry: every blocking check applies.
  * protective (stops, exits, flattens): risk-reducing orders must always get through, so kill, latch, market
    hours and order-count checks don't block them. The checks that stop a protective order from doing harm still
    do: allowlist, sell ≤ long position (no accidental short), and the paper lock.

Checks that would change strategy B's frozen execution (quote age, price collar, spread) are recorded but never
block, so paper results stay comparable with the backtest (G2 replay match). Making any of them blocking needs a
decision record.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from wt.core.config import CONFIG_DIR
from wt.core.safety import env_violations
from wt.core.types import Order


@dataclass(frozen=True)
class Limits:
    allowlist: frozenset[str]
    max_qty: int
    max_notional: float
    max_entries_per_day: int
    max_orders_per_day: int
    max_quote_age_s: float = 5.0
    max_collar_pct: float = 0.5
    max_spread_pct: float = 0.15


def load_limits(strategy: str, path: Path | None = None) -> Limits:
    cfg = yaml.safe_load((path or CONFIG_DIR / "risk.yaml").read_text())[strategy]
    return Limits(allowlist=frozenset(cfg["allowlist"]), max_qty=int(cfg["max_qty"]),
                  max_notional=float(cfg["max_notional"]), max_entries_per_day=int(cfg["max_entries_per_day"]),
                  max_orders_per_day=int(cfg["max_orders_per_day"]),
                  max_quote_age_s=float(cfg.get("max_quote_age_s", 5.0)),
                  max_collar_pct=float(cfg.get("max_collar_pct", 0.5)),
                  max_spread_pct=float(cfg.get("max_spread_pct", 0.15)))


@dataclass
class Context:
    now: dt.datetime
    position_qty: int                      # signed broker position in the order's symbol
    open_orders: list[Order]
    kill: bool
    latched: bool
    session_open: dt.datetime | None
    session_close: dt.datetime | None
    entries_today: int
    orders_today: int
    quote: tuple[float, float, dt.datetime] | None = None     # bid, ask, quote time
    environ: dict[str, str] | None = None                     # for tests; None = os.environ


@dataclass
class Check:
    name: str
    ok: bool
    blocking: bool
    detail: str = ""


@dataclass
class Result:
    ok: bool
    checks: list[Check] = field(default_factory=list)

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if c.blocking and not c.ok]

    def summary(self) -> dict[str, Any]:
        return {"ok": self.ok, "failed": [f"{c.name}: {c.detail}" for c in self.failed],
                "warnings": [f"{c.name}: {c.detail}" for c in self.checks if not c.blocking and not c.ok]}


class PreTradeGuard:
    def __init__(self, limits: Limits) -> None:
        self.limits = limits

    def evaluate(self, order: Order, ctx: Context, protective: bool) -> Result:
        L, checks = self.limits, []

        def add(name: str, ok: bool, blocking: bool, detail: str = "") -> None:
            checks.append(Check(name, ok, blocking, detail))

        paper = env_violations(ctx.environ)
        add("paper lock", not paper, True, "; ".join(paper))
        add("symbol allowlist", order.symbol in L.allowlist, True, order.symbol)
        if order.side == "sell":
            resting = sum(o.qty - o.filled_qty for o in ctx.open_orders
                          if o.symbol == order.symbol and o.side == "sell" and o.client_order_id != order.client_order_id)
            room = max(ctx.position_qty, 0) - resting
            add("sell within long position", order.qty <= room, True,
                f"sell {order.qty} vs long {ctx.position_qty} minus resting sells {resting}")
        add("hard quantity cap", 0 < order.qty <= L.max_qty, True, f"{order.qty} (cap {L.max_qty})")
        px = order.limit_price or order.stop_price or (ctx.quote[1] if ctx.quote else None)
        if px:
            add("hard notional cap", order.qty * px <= L.max_notional, True, f"{order.qty * px:.2f} (cap {L.max_notional:.0f})")
        if not protective:
            add("kill switch off", not ctx.kill, True)
            add("loss latch clear", not ctx.latched, True)
            is_open = ctx.session_open is not None and ctx.session_close is not None and \
                ctx.session_open <= ctx.now < ctx.session_close
            add("market open", is_open, True)
            add("entries per day", ctx.entries_today < L.max_entries_per_day, True,
                f"{ctx.entries_today} (max {L.max_entries_per_day})")
            add("orders per day", ctx.orders_today < L.max_orders_per_day, True,
                f"{ctx.orders_today} (max {L.max_orders_per_day})")
            dup = [o for o in ctx.open_orders if o.symbol == order.symbol and o.side == order.side]
            add("no duplicate open order", not dup, True, ", ".join(o.client_order_id for o in dup))
            add("flat before entry", ctx.position_qty == 0, True, f"position {ctx.position_qty}")
            if ctx.quote:
                bid, ask, t = ctx.quote
                age = (ctx.now - t).total_seconds()
                mid = (bid + ask) / 2 if bid and ask else None
                add("quote age", age <= L.max_quote_age_s, False, f"{age:.1f}s")
                if mid:
                    add("spread", (ask - bid) / mid * 100 <= L.max_spread_pct, False, f"{(ask - bid) / mid * 100:.3f}%")
                    if order.limit_price:
                        add("price collar", abs(order.limit_price / mid - 1) * 100 <= L.max_collar_pct, False,
                            f"limit {order.limit_price} vs mid {mid:.2f}")
            else:
                add("quote available", False, False, "no quote")
        ok = not any(c.blocking and not c.ok for c in checks)
        return Result(ok, checks)
