"""The options clone's order management (DEC-0030): one contract, one plan per trade, one way out.

Rules this module keeps, whatever the runner asks:
  * The plan is saved before an order is sent and after every change, so a restart resumes from what was last true
    and never sends an order twice. Every submission gets a fresh client id from the plan's own sequence.
  * An order whose outcome is unknown (timeout, lost response) is resolved by its id before anything else is sent.
  * At most one resting sell per trade: the broker-side stop when the account accepts one, else the target.
  * Every exit goes through `exit_now`: cancel the resting sell and confirm it, then sell only the clone's own lots.
  * The clone's position is the sum of its own fills, never the account's row, so a hand trade in a shared account
    can never be sold by the clone. If the account holds less than the clone's own lots, the trade is `unresolved`.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from wt.brokers.base import Broker, BrokerRejected, DuplicateOrder, TransportError
from wt.core.ids import coid, is_ours
from wt.core.types import Order
from wt.risk.options_guard import Context, GuardRejected, Limits, check

STRATEGY = "O"
ACTIVE = ("entering", "open", "exiting")
DONE = ("closed", "cancelled", "rejected", "unresolved")


@dataclass
class OptionPlan:
    trade_id: str                      # <date>-O-<n>
    date: str
    root: str
    symbol: str                        # the OCC contract
    side: str                          # call | put
    setup: str
    level: str
    level_price: float
    invalidation: float                # the stock price whose 2-minute close ends the trade
    next_level: float | None
    limit: float                       # the entry limit, per share
    quoted_ask: float | None
    quote_age_s: float | None
    signal_bar: str                    # HH:MM, the bar that completed the setup
    state: str = "new"                 # new | entering | open | exiting | closed | cancelled | rejected | unresolved
    seq: int = 0
    entry_id: str = ""
    entry_sent_at: str = ""
    fill: float | None = None
    filled_at: str = ""
    own_qty: int = 0                   # the clone's lots, from its own fills
    protect_id: str = ""               # the one resting sell
    protect_kind: str = ""             # stop | target
    broker_stop: str = ""              # accepted | refused, the first time it is tried
    exit_ids: list[str] = field(default_factory=list)
    exit_fill: float | None = None
    exit_at: str = ""
    exit_reason: str = ""
    best_bid: float | None = None      # the highest bid seen in the trade (favourable excursion)
    worst_bid: float | None = None
    breakeven: bool = False
    notes: list[list[Any]] = field(default_factory=list)
    recorded: bool = False             # booked into the journal (trade_closed), exactly once

    @property
    def active(self) -> bool:
        return self.state in ACTIVE

    def pnl(self, fee_each_way: float) -> float | None:
        """Dollars, after fees, from the fills. None until both fills exist."""
        if self.fill is None or self.exit_fill is None:
            return None
        return round((self.exit_fill - self.fill) * 100 - 2 * fee_each_way, 2)

    def return_on_premium(self, fee_each_way: float) -> float | None:
        p = self.pnl(fee_each_way)
        return None if p is None or not self.fill else round(p / (self.fill * 100 + fee_each_way), 4)


class PlanStore:
    """One JSON file per trade under `root` (var/options/plans), written atomically and fsynced."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def path(self, trade_id: str) -> Path:
        return self.root / f"plan_{trade_id}.json"

    def save(self, p: OptionPlan) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        dst = self.path(p.trade_id)
        tmp = dst.with_name(f".{dst.name}.tmp")
        with open(tmp, "w") as fh:
            fh.write(json.dumps(asdict(p), indent=1, default=str))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dst)

    def load_all(self) -> list[OptionPlan]:
        """Every plan on disk, oldest first. A file that cannot be read raises: the runner must not guess."""
        known = {f.name for f in fields(OptionPlan)}
        out = []
        for f in sorted(self.root.glob("plan_*.json")) if self.root.exists() else []:
            raw: dict[str, Any] = json.loads(f.read_text())
            out.append(OptionPlan(**{k: v for k, v in raw.items() if k in known}))
        return out


class OptionsOMS:
    def __init__(self, broker: Broker, store: PlanStore, limits: Limits, ctx: Callable[[], Context],
                 now: Callable[[], dt.datetime], sleep: Callable[[float], None], wait_s: float = 8.0) -> None:
        self.b = broker
        self.store = store
        self.lim = limits
        self.ctx = ctx                  # the guard's view, built fresh by the runner for every order
        self.now = now
        self.sleep = sleep
        self.wait_s = wait_s
        self.orders_sent = 0
        self.refused: dict[str, Any] | None = None    # why the last entry was refused before it left (the decision log)

    # ---- plumbing ----------------------------------------------------------------------------
    def _save(self, p: OptionPlan) -> None:
        self.store.save(p)

    def note(self, p: OptionPlan, *what: Any) -> None:
        p.notes.append([self.now().isoformat(), *what])
        self._save(p)

    def _id(self, p: OptionPlan, leg: str) -> str:
        p.seq += 1
        return coid(p.date, STRATEGY, p.symbol, f"{p.trade_id}|{leg}", p.seq)

    def _send(self, p: OptionPlan, order: Order, entry: bool) -> Order | None:
        """Guard, then send. None when the outcome is unknown (resolve by id later). Raises GuardRejected or
        BrokerRejected when nothing was placed."""
        check(order, self.ctx(), self.lim, entry, p.root)
        self.orders_sent += 1
        try:
            return self.b.place(order)
        except DuplicateOrder:
            return self.b.get_order(order.client_order_id)    # it is there already: read it
        except (TransportError, TimeoutError) as e:
            self.note(p, "submit-unknown", order.client_order_id, str(e)[:80])
            return None

    def _terminal(self, cid: str, tries: int = 6) -> tuple[bool, Order | None]:
        """Wait until the order is terminal. (True, order) once it is; (True, None) if the broker has never heard of
        it; (False, last) if it is still live or cannot be read."""
        last: Order | None = None
        for i in range(tries):
            try:
                last = self.b.get_order(cid)
            except TransportError:
                last = None
                if i == tries - 1:
                    return False, None
                self.sleep(0.5)
                continue
            if last is None:
                return True, None
            if last.status.terminal:
                return True, last
            self.sleep(0.5)
        return False, last

    def account_qty(self, symbol: str) -> int:
        """The account's quantity in `symbol`, read twice and agreeing. Raises TransportError if it cannot be read."""
        for _ in range(3):
            a = {x.symbol: x.qty for x in self.b.positions()}.get(symbol, 0)
            b = {x.symbol: x.qty for x in self.b.positions()}.get(symbol, 0)
            if a == b:
                return a
            self.sleep(0.5)
        raise TransportError("position not stable")

    # ---- entry -------------------------------------------------------------------------------
    def enter(self, p: OptionPlan) -> None:
        """Send the entry limit. The plan is saved with the order's id before the order leaves."""
        p.entry_id = self._id(p, "entry")
        p.entry_sent_at = self.now().isoformat()
        p.state = "entering"
        self._save(p)
        order = Order(p.entry_id, p.symbol, "buy", 1, "limit", limit_price=round(p.limit, 2), tif="day")
        self.refused = None
        try:
            got = self._send(p, order, entry=True)
        except (GuardRejected, BrokerRejected) as e:
            self.refused = {"by": "guard", "code": e.code, **e.detail} if isinstance(e, GuardRejected) \
                else {"by": "broker", "code": "broker-refused"}
            p.state = "rejected"
            self.note(p, "entry-refused", str(e)[:160])
            return
        if got is not None and got.filled_qty:
            self._filled(p, got)

    def _filled(self, p: OptionPlan, o: Order) -> None:
        if p.fill is None and o.filled_qty > 0 and o.avg_fill_price is not None:
            p.fill = float(o.avg_fill_price)
            p.filled_at = self.now().isoformat()
            p.own_qty = int(o.filled_qty)
            p.best_bid = p.worst_bid = p.fill
            p.state = "open"
            self._save(p)

    def sync_entry(self, p: OptionPlan) -> None:
        """Resolve an entry by its id: filled, still working, or never placed."""
        if p.state != "entering":
            return
        o = self.b.get_order(p.entry_id)
        if o is None:
            p.state = "cancelled"
            self.note(p, "entry-never-placed")
        elif o.filled_qty:
            self._filled(p, o)
        elif o.status.terminal:
            p.state = "cancelled"
            self.note(p, "entry-unfilled", o.status.value)

    def expire_entry(self, p: OptionPlan) -> None:
        """The entry's time is up: cancel it and confirm. A fill that lands meanwhile is honoured."""
        if p.state != "entering":
            return
        self.b.cancel(p.entry_id)
        done, o = self._terminal(p.entry_id)
        if o is not None and o.filled_qty:
            self._filled(p, o)
        elif done:
            p.state = "cancelled"
            self.note(p, "entry-unfilled", "expired")
        else:
            self.note(p, "entry-cancel-unconfirmed")          # tried again on the next poll

    # ---- protection --------------------------------------------------------------------------
    def protect(self, p: OptionPlan, stop_pct: float, target_pct: float, try_stop: bool) -> None:
        """Rest the one sell: the broker-side stop when allowed and accepted, else the target limit."""
        if p.state != "open" or p.protect_id or p.fill is None:
            return
        if try_stop and p.broker_stop != "refused":
            cid = self._id(p, "stop")
            p.protect_id, p.protect_kind = cid, "stop"
            self._save(p)
            stop_px = round(p.fill * (1 - stop_pct / 100), 2)
            try:
                got = self._send(p, Order(cid, p.symbol, "sell", p.own_qty, "stop", stop_price=stop_px), entry=False)
            except (GuardRejected, BrokerRejected) as e:
                p.broker_stop, p.protect_id, p.protect_kind = "refused", "", ""
                self.note(p, "broker-stop", "refused", str(e)[:120])
            else:
                if got is not None:
                    p.broker_stop = "accepted"
                    self.note(p, "broker-stop", "accepted", stop_px)
                return
        if p.protect_id:
            return
        cid = self._id(p, "target")
        p.protect_id, p.protect_kind = cid, "target"
        self._save(p)
        px = round(p.fill * (1 + target_pct / 100), 2)
        try:
            self._send(p, Order(cid, p.symbol, "sell", p.own_qty, "limit", limit_price=px), entry=False)
        except (GuardRejected, BrokerRejected) as e:
            p.protect_id, p.protect_kind = "", ""
            self.note(p, "target-refused", str(e)[:120])

    def sync_open(self, p: OptionPlan) -> None:
        """Did the resting sell fill on its own? Then the trade is closed by it."""
        if p.state not in ("open", "exiting") or not p.protect_id:
            return
        o = self.b.get_order(p.protect_id)
        if o is not None and o.filled_qty:
            self._closed(p, o, "target" if p.protect_kind == "target" else "broker-stop")

    def _closed(self, p: OptionPlan, o: Order, reason: str) -> None:
        p.own_qty = max(p.own_qty - int(o.filled_qty), 0)
        if p.own_qty == 0:
            p.exit_fill = float(o.avg_fill_price) if o.avg_fill_price is not None else None
            p.exit_at = self.now().isoformat()
            p.exit_reason = p.exit_reason or reason
            p.state = "closed"
        self._save(p)

    # ---- the one way out ---------------------------------------------------------------------
    def exit_now(self, p: OptionPlan, reason: str) -> bool:
        """Sell the clone's lots at market. True once closed (or unresolved); False to try again next poll."""
        if p.state not in ("open", "exiting"):
            return p.state in DONE
        if p.state == "open":
            p.state, p.exit_reason = "exiting", reason
            self._save(p)
        # 1. the resting sell: cancel and confirm; if it filled, that is the exit
        if p.protect_id:
            self.b.cancel(p.protect_id)
            done, o = self._terminal(p.protect_id)
            if o is not None and o.filled_qty:
                self._closed(p, o, "broker-stop" if p.protect_kind == "stop" else "target")
                return True
            if not done:
                self.note(p, "exit-deferred", "resting sell not confirmed cancelled")
                return False
            p.protect_id = ""
            self._save(p)
        # 2. an earlier exit order: resolve it before anything new
        if p.exit_ids:
            done, o = self._terminal(p.exit_ids[-1], tries=2)
            if o is not None and o.filled_qty:
                self._closed(p, o, reason)
                if p.state == "closed":
                    return True
            elif not done:
                self.b.cancel(p.exit_ids[-1])
                done, o = self._terminal(p.exit_ids[-1])
                if o is not None and o.filled_qty:
                    self._closed(p, o, reason)
                    return p.state == "closed"
                if not done:
                    self.note(p, "exit-deferred", "earlier exit not resolved")
                    return False
        # 3. the clone's own lots, checked against the account
        if p.own_qty <= 0:
            p.state = "closed"
            self._save(p)
            return True
        held = self.account_qty(p.symbol)
        if held < p.own_qty:
            p.state = "unresolved"
            self.note(p, "lot-taken-by-hand", {"account": held, "own": p.own_qty})
            return True
        # 4. one market sell, its id saved first
        cid = self._id(p, f"exit-{reason}")
        p.exit_ids.append(cid)
        self._save(p)
        try:
            got = self._send(p, Order(cid, p.symbol, "sell", p.own_qty, "market"), entry=False)
        except (GuardRejected, BrokerRejected) as e:
            self.note(p, "exit-refused", str(e)[:160])
            return False
        if got is None:
            return False                                    # unknown: resolved by id on the next call
        waited = 0.0
        while waited < self.wait_s:
            o = self.b.get_order(cid)
            if o is not None and o.filled_qty:
                self._closed(p, o, reason)
                return p.state == "closed"
            self.sleep(0.5)
            waited += 0.5
        return False                                        # still working: resolved by id on the next call

    # ---- reconciliation ----------------------------------------------------------------------
    def reconcile(self, plans: list[OptionPlan]) -> dict[str, list[str]]:
        """Broker against plans. Cancels the clone's stray orders; reports shared contracts and, in the clone's own
        account, positions no plan knows. Never sells anything."""
        out: dict[str, list[str]] = {"stray_cancelled": [], "shared": [], "unknown_positions": []}
        live = {i for p in plans if p.active for i in (p.entry_id, p.protect_id, *p.exit_ids) if i}
        for o in self.b.open_orders():
            if is_ours(o.client_order_id, STRATEGY) and o.client_order_id not in live:
                self.b.cancel(o.client_order_id)
                out["stray_cancelled"].append(o.client_order_id)
        own = {p.symbol: p.own_qty for p in plans if p.active and p.own_qty}
        for x in self.b.positions():
            if x.symbol in own and x.qty != own[x.symbol]:
                out["shared"].append(x.symbol)
            elif x.symbol not in own and x.qty:
                out["unknown_positions"].append(x.symbol)
        return out


def trade_row(p: OptionPlan, fee_each_way: float) -> dict[str, Any]:
    """A finished trade as the journal books it, and as wt.options.review reads it."""
    return {"trade_id": p.trade_id, "setup": p.setup, "root": p.root, "side": p.side, "symbol": p.symbol,
            "state": p.state, "fill": p.fill, "exit_fill": p.exit_fill, "exit_reason": p.exit_reason,
            "pnl": p.pnl(fee_each_way), "rop": p.return_on_premium(fee_each_way), "best_bid": p.best_bid,
            "worst_bid": p.worst_bid, "broker_stop": p.broker_stop, "counts": p.state == "closed"}


def book(p: OptionPlan, journaled: set[str], write: Callable[..., bool], fee_each_way: float) -> bool:
    """Journal a finished trade exactly once. True once it is on the journal."""
    if p.trade_id in journaled or p.state in ("cancelled", "rejected"):
        return True                                         # booked already, or never a trade (no fill)
    if p.state not in DONE:
        return False
    ok = write("trade_closed", **trade_row(p, fee_each_way))
    if ok:
        journaled.add(p.trade_id)
    return ok

