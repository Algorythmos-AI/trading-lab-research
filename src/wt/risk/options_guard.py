"""The options clone's pre-trade guard and its loss latches (DEC-0030, config/risk.yaml key O).

Every order the clone sends passes `check` first; a refusal raises GuardRejected and nothing is sent. Exits are
refused only when they could do harm (sell more than the clone's own lots, sell with nothing held, a buy that is
not an entry); limits and latches never block an exit.

Latches are files, written and fsynced before anything else happens, so a crash can never forget one. The day
latch ends with the session; the week latch with the week; the drawdown latch only when the owner removes it.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from wt.core.safety import env_violations
from wt.core.types import Order

KINDS = ("day", "week", "drawdown")


class GuardRejected(Exception):
    """The guard refused the order. Nothing was sent. `code` names the check that refused it and `detail` holds its
    numbers, for the decision log (the message is for people)."""

    def __init__(self, msg: str, code: str = "other", detail: Mapping[str, Any] | None = None) -> None:
        super().__init__(msg)
        self.code = code
        self.detail = dict(detail or {})


@dataclass(frozen=True)
class Limits:
    max_contracts: int
    max_premium: float
    max_limit_price: float
    max_entries_per_day: int
    max_attempts_per_name: int
    max_orders_per_day: int
    max_open_positions: int
    day_loss_latch: float
    week_loss_latch: float
    drawdown_latch: float

    @classmethod
    def from_risk(cls, risk: Mapping[str, Any]) -> Limits:
        o = risk["O"]
        return cls(int(o["max_contracts"]), float(o["max_premium"]), float(o["max_limit_price"]),
                   int(o["max_entries_per_day"]), int(o["max_attempts_per_name"]), int(o["max_orders_per_day"]),
                   int(o["max_open_positions"]), float(o["day_loss_latch"]), float(o["week_loss_latch"]),
                   float(o["drawdown_latch"]))


@dataclass
class Context:
    """What the guard needs to know at the moment of an order, gathered by the runner."""
    now: dt.datetime
    names_today: set[str]
    entries_today: int = 0
    attempts: dict[str, int] = field(default_factory=dict)       # filled entries per underlying today
    orders_today: int = 0
    open_positions: int = 0
    unknown_outstanding: bool = False                              # an order whose outcome is not yet known
    account_holds: set[str] = field(default_factory=set)           # every option symbol the account holds
    own_qty: dict[str, int] = field(default_factory=dict)          # the clone's own lots per symbol
    kill: bool = False
    latched: str | None = None
    entries_off: str | None = None                                 # any other reason the runner closed entries
    market_open: bool = True
    last_entry: dt.datetime | None = None


def check(order: Order, ctx: Context, lim: Limits, entry: bool, root: str = "") -> None:
    """Refuse `order` with the reason, or return. `entry`: a buy to open; otherwise a sell to close."""
    if v := env_violations():
        raise GuardRejected("paper lock: " + "; ".join(v), "paper-lock")
    if order.qty < 1 or order.qty > lim.max_contracts:
        raise GuardRejected(f"quantity {order.qty}: the clone trades {lim.max_contracts} contract", "quantity",
                            {"qty": order.qty, "max": lim.max_contracts})
    if not entry:
        if order.side != "sell":
            raise GuardRejected("an exit is a sell")
        held = ctx.own_qty.get(order.symbol, 0)
        if held <= 0:
            raise GuardRejected(f"no lot of the clone's in {order.symbol}")
        if order.qty > held:
            raise GuardRejected(f"sell {order.qty} but the clone holds {held}")
        return
    if ctx.orders_today >= lim.max_orders_per_day:                 # an entry's cap: it never strands an exit
        raise GuardRejected(f"{ctx.orders_today} orders today: the cap is {lim.max_orders_per_day}", "max-orders",
                            {"orders": ctx.orders_today, "max": lim.max_orders_per_day})
    if order.side != "buy" or order.type != "limit" or order.limit_price is None:
        raise GuardRejected("an entry is a limit buy", "not-a-limit-buy")
    if order.limit_price > lim.max_limit_price or order.limit_price * 100 * order.qty > lim.max_premium:
        raise GuardRejected(f"limit {order.limit_price}: the cap is {lim.max_limit_price}", "limit-over-cap",
                            {"limit": order.limit_price, "max": lim.max_limit_price, "max_premium": lim.max_premium})
    for why, code in ((("KILL" if ctx.kill else None), "kill"), (ctx.latched and f"latched: {ctx.latched}", "latch"),
                      (ctx.entries_off, "entries-off"), ((None if ctx.market_open else "the market is closed"),
                                                         "market-closed"),
                      (("an order's outcome is still unknown" if ctx.unknown_outstanding else None), "outcome-unknown")):
        if why:
            raise GuardRejected(why, code)
    if ctx.last_entry is not None and ctx.now > ctx.last_entry:
        raise GuardRejected("past the last entry time", "past-last-entry")
    if root not in ctx.names_today:
        raise GuardRejected(f"{root} is not one of today's names", "not-todays-name")
    if order.symbol in ctx.account_holds:
        raise GuardRejected(f"the account already holds {order.symbol}", "already-held")
    if ctx.open_positions >= lim.max_open_positions:
        raise GuardRejected("a position is already open", "open-position",
                            {"open": ctx.open_positions, "max": lim.max_open_positions})
    if ctx.entries_today >= lim.max_entries_per_day:
        raise GuardRejected(f"{ctx.entries_today} entries today: the cap is {lim.max_entries_per_day}", "max-entries",
                            {"entries": ctx.entries_today, "max": lim.max_entries_per_day})
    if ctx.attempts.get(root, 0) >= lim.max_attempts_per_name:
        raise GuardRejected(f"{ctx.attempts.get(root, 0)} entries in {root} today: the cap is {lim.max_attempts_per_name}",
                            "max-attempts", {"attempts": ctx.attempts.get(root, 0), "max": lim.max_attempts_per_name})


def week_key(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


class Latches:
    """The three loss latches as files under `root` (var/options/latches). Writing is durable before it returns."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, kind: str) -> Path:
        if kind not in KINDS:
            raise ValueError(kind)
        return self.root / kind

    def trip(self, kind: str, key: str, reason: str, at: dt.datetime) -> None:
        p = self._path(kind)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".{p.name}.tmp")
        with open(tmp, "w") as fh:
            fh.write(json.dumps({"key": key, "reason": reason, "at": at.isoformat()}))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
        dfd = os.open(p.parent, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)

    def active(self, day: dt.date) -> str | None:
        """The latch in force on `day`, or None. A latch file that cannot be read counts as in force: a latch is
        never assumed away."""
        for kind in ("drawdown", "week", "day"):
            p = self._path(kind)
            if not p.exists():
                continue
            try:
                key = str(json.loads(p.read_text())["key"])
            except (OSError, ValueError, KeyError, TypeError):
                return f"{kind} (unreadable latch file)"
            if kind == "drawdown" or (kind == "week" and key == week_key(day)) or (kind == "day" and key == day.isoformat()):
                return kind
        return None

    def check(self, day: dt.date, now: dt.datetime, lim: Limits, day_pnl: float, week_pnl: float,
              from_peak: float) -> str | None:
        """Trip whichever latch the numbers reach (losses are negative) and return the one in force."""
        if from_peak <= -lim.drawdown_latch and self.active(day) != "drawdown":
            self.trip("drawdown", "since " + day.isoformat(), f"{from_peak:.2f} from the high-water mark", now)
        if week_pnl <= -lim.week_loss_latch and self.active(day) not in ("drawdown", "week"):
            self.trip("week", week_key(day), f"week {week_pnl:.2f}", now)
        if day_pnl <= -lim.day_loss_latch and self.active(day) is None:
            self.trip("day", day.isoformat(), f"day {day_pnl:.2f}", now)
        return self.active(day)
