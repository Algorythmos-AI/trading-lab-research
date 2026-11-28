"""OMS for one position at a time, with the audit fixes (C1-C4, H1, H2, M4, M5, M7).

Rules:
  * The entry is a stop-limit buy (DAY). The moment it fills, even partially, a SERVER-SIDE stop sell rests at the
    broker for the filled quantity. The stop is GTC, so it still protects the position overnight if the runner
    dies. It is resized on further fills, and the old stop is cancelled *and confirmed* before the new one goes in.
  * Exactly one resting exit order at any time. A target or discretionary exit runs:
    cancel stop -> confirm the cancel (an error is NOT a confirmation) -> read the broker position twice ->
    sell min(position, entry fills) -> if it doesn't fill in time: cancel, confirm, re-protect with a new stop.
    A stop whose cancel the exit sent but could not confirm is not replaced for EXIT_HOLD_S (DEC-0071): the exit is
    asked again on the next loop and finds it cancelled, instead of a fresh stop to cancel once more.
  * Every submission has its own client order id (a sequence number persisted with the plan). After a timeout the
    order is resolved by id: a found order that matches is success, whatever its status; "not found" means it
    never reached the broker; a failed lookup leaves the plan in `submitting` for the next loop to resolve.
  * Every order goes through the pre-trade guard. Protective orders skip only the checks that would block
    risk reduction.
  * The broker is the source of truth. reconcile() cancels this strategy's excess sells (which could open a
    short), protects unprotected positions, and cancels this strategy's stray orders. It never touches another
    strategy's orders.
  * The plan is persisted on every transition (PlanStore), so a restart resumes instead of re-entering.
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, fields, replace
from pathlib import Path
from typing import Any

from wt.brokers.base import Broker, BrokerRejected, DuplicateOrder, TransportError
from wt.core.ids import coid, is_ours
from wt.core.types import Order, OrderStatus
from wt.risk.pretrade import Context, PreTradeGuard

TERMINAL = ("closed", "aborted")
EXIT_HOLD_S = 15.0      # DEC-0071: about one loop of the stock desk (10 s polls); after it the stop goes back
ACTIVE_POSITION = ("in_position", "exiting")


class GuardRejected(Exception):
    """The pre-trade guard refused the order. Nothing was sent."""


class SubmitFailed(Exception):
    """The order is confirmed absent at the broker (the submit never arrived)."""


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
    seq: int = 0                      # order sequence; every submission takes the next number
    entry_id: str = ""
    stop_id: str = ""
    exit_id: str = ""
    sell_ids: list[str] = field(default_factory=list)   # every sell order this plan placed (stops, exits)
    filled_qty: int = 0
    avg_entry: float | None = None
    exit_fill_price: float | None = None
    exit_reason: str = ""
    state: str = "planned"            # planned|submitting|entry_working|in_position|exiting|closed|aborted
    entry_counted: bool = False
    recorded: bool = False
    origin: str = "entry"             # entry | orphan (a position no plan placed, adopted so it can be exited)
    exit_hold_stop: str = ""          # DEC-0071: the stop an exit asked to cancel, unconfirmed; not replaced until
    exit_hold_until: float = 0.0      # this time (epoch seconds), so the next loop's exit can sell
    log: list[Any] = field(default_factory=list)

    @property
    def trade_id(self) -> str:
        base = f"{self.date}-{self.strategy}-{self.symbol}-{self.attempt}"
        return base if self.origin == "entry" else f"{base}-{self.origin}"

    @property
    def active(self) -> bool:
        return self.state not in TERMINAL


class PlanStore:
    """Atomic JSON persistence of the day's plan (data/live/plan_<date>.json)."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, p: TradePlan) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp")
        with open(tmp, "w") as fh:
            fh.write(json.dumps(asdict(p), indent=1, default=str))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)

    def load(self) -> TradePlan | None:
        if not self.path.exists():
            return None
        raw: dict[str, Any] = json.loads(self.path.read_text())
        known = {f.name for f in fields(TradePlan)}
        return TradePlan(**{k: v for k, v in raw.items() if k in known})


def _same(a: Order, b: Order) -> bool:
    """Does the broker's order b match what we meant to send in a? (resolving a timed-out submit)"""
    def r(x: float | None) -> float | None:
        return None if x is None else round(float(x), 2)
    return (a.symbol == b.symbol and a.side == b.side and int(a.qty) == int(b.qty) and a.type == b.type
            and r(a.limit_price) == r(b.limit_price) and r(a.stop_price) == r(b.stop_price))


class OMS:
    def __init__(self, broker: Broker, sell_timeout_s: float = 10.0, sleep: Callable[[float], None] = time.sleep,
                 guard: PreTradeGuard | None = None, context: Callable[[str], Context] | None = None,
                 persist: Callable[[TradePlan], None] | None = None,
                 on_entry: Callable[[TradePlan], None] | None = None, confirm_polls: int = 20,
                 poll_s: float = 0.25, strategy: str | None = None,
                 clock: Callable[[], float] = time.time, unguarded: bool = False) -> None:
        self.b, self.sell_timeout_s, self.sleep, self.clock = broker, sell_timeout_s, sleep, clock
        self.guard, self.context, self.persist_cb, self.on_entry = guard, context, persist, on_entry
        self.confirm_polls, self.poll_s, self.strategy = confirm_polls, poll_s, strategy
        # An entry is never sent without the pre-trade guard (paper lock, kill switch, caps). Only a caller that says
        # so (a test, a replay with no account) may send one unchecked; a forgotten guard refuses the entry instead.
        self.unguarded = unguarded
        self._gone: set[str] = set()        # ids get_order has reported cancelled or rejected: never resting again

    # ---- plumbing -------------------------------------------------------------------------------
    def _persist(self, p: TradePlan) -> None:
        if self.persist_cb is not None:
            self.persist_cb(p)

    def _note(self, p: TradePlan, *entry: Any) -> None:
        p.log.append(list(entry))

    def _next_id(self, p: TradePlan, leg: str) -> str:
        # an adopted orphan shares the day and symbol with the day's own plan: its legs are namespaced apart
        cid = coid(p.date, p.strategy, p.symbol, leg if p.origin == "entry" else f"{p.origin}-{leg}", p.seq)
        p.seq += 1
        self._persist(p)                    # the sequence must survive a crash before the order is sent
        return cid

    def _check(self, order: Order, protective: bool) -> None:
        if self.guard is None or self.context is None:
            if protective or self.unguarded:          # risk reduction is never blocked for want of a guard
                return
            raise GuardRejected("no pre-trade guard: an entry is never sent unchecked")
        ctx = self.context(order.symbol)
        r = self.guard.evaluate(order, replace(ctx, open_orders=self._live(ctx.open_orders)), protective)
        if not r.ok:
            raise GuardRejected("; ".join(f"{c.name}: {c.detail}" for c in r.failed))

    def _submit(self, order: Order, protective: bool) -> Order:
        self._check(order, protective)
        try:
            return self.b.place(order)
        except (TransportError, TimeoutError) as e:
            found = self.b.get_order(order.client_order_id)       # a TransportError here propagates: unknown
            if found is None:
                raise SubmitFailed(f"{order.client_order_id} is not at the broker") from e
            if not _same(order, found):
                raise BrokerRejected(f"{order.client_order_id} exists at the broker with different terms") from e
            return found
        except DuplicateOrder:
            found = self.b.get_order(order.client_order_id)
            if found is not None and _same(order, found):
                return found
            raise

    def _live(self, orders: list[Order]) -> list[Order]:
        """The orders that can still fill. Alpaca's open-orders list lags a cancel by a moment: on 2026-10-26 the
        end-of-day sell was refused four times over a stop that get_order had already reported cancelled."""
        return [o for o in orders if not o.status.terminal and o.client_order_id not in self._gone]

    def _position_qty(self, symbol: str) -> int:
        return sum(p.qty for p in self.b.positions() if p.symbol == symbol)

    def _stable_position(self, symbol: str, tries: int = 3) -> int:
        """Two consistent reads (a position read can lag a fill by a moment)."""
        last = self._position_qty(symbol)
        for _ in range(tries):
            self.sleep(self.poll_s)
            cur = self._position_qty(symbol)
            if cur == last:
                return cur
            last = cur
        return last

    def _read(self, cid: str) -> Order | None:
        """get_order, remembering a cancel or reject it reports. Not None (a lookup can miss a live order) nor FILLED
        (a position read can lag the fill): there the listed order keeps the guard cautious."""
        o = self.b.get_order(cid)
        if o is not None and o.status in (OrderStatus.CANCELED, OrderStatus.REJECTED):
            self._gone.add(cid)
        return o

    def _confirm_terminal(self, cid: str) -> tuple[bool, Order | None]:
        """(True, order) once the broker reports the order terminal or unknown; (False, None) if it can't confirm.
        A lookup error is never taken as confirmation (audit M4)."""
        for _ in range(self.confirm_polls):
            try:
                o = self._read(cid)
            except TransportError:
                return False, None
            if o is None or o.status.terminal:
                return True, o
            self.sleep(self.poll_s)
        return False, None

    def exit_fill(self, p: TradePlan) -> float | None:
        """Average fill price over every sell this plan placed (stops, exits, partial exits)."""
        qty, notional = 0, 0.0
        for cid in p.sell_ids:
            o = self.b.get_order(cid)
            if o is not None and o.filled_qty and o.avg_fill_price:
                qty += o.filled_qty
                notional += o.filled_qty * o.avg_fill_price
        return round(notional / qty, 4) if qty else None

    def _close(self, p: TradePlan, reason: str) -> None:
        try:
            p.exit_fill_price = self.exit_fill(p)
        except TransportError:
            p.exit_fill_price = None                 # the runner resolves it before booking
        p.exit_reason = p.exit_reason or reason
        p.state = "closed"
        self._note(p, "closed", p.exit_reason, p.exit_fill_price)
        self._persist(p)
        self.cancel_resting(p.symbol)

    def cancel_resting(self, symbol: str) -> list[str]:
        """Cancel this strategy's resting orders in a symbol (e.g. a GTC stop left after the exit filled)."""
        out = []
        for o in self.b.open_orders():
            if o.symbol == symbol and is_ours(o.client_order_id, self.strategy):
                self.b.cancel(o.client_order_id)
                out.append(o.client_order_id)
        return out

    def cancel_resting_confirmed(self, symbol: str) -> bool:
        """Cancel this strategy's resting orders in a symbol and confirm each is terminal (M4)."""
        ok = True
        for cid in self.cancel_resting(symbol):
            done, _ = self._confirm_terminal(cid)
            ok = ok and done
        return ok

    def stop_cover(self, symbol: str, gtc_only: bool = False) -> int:
        """Shares of `symbol` this strategy's resting stops would sell: reconcile's measure of cover. An order
        get_order has reported cancelled is not cover, whatever the open-orders list still shows."""
        return sum(o.qty - o.filled_qty for o in self._live(self.b.open_orders())
                   if o.symbol == symbol and o.side == "sell" and o.type in ("stop", "stop_limit")
                   and is_ours(o.client_order_id, self.strategy) and (not gtc_only or o.tif == "gtc"))

    # ---- lifecycle ------------------------------------------------------------------------------
    def place_entry(self, p: TradePlan) -> None:
        p.entry_id = self._next_id(p, "entry")
        p.state = "submitting"
        self._persist(p)
        order = Order(p.entry_id, p.symbol, "buy", p.qty, "stop_limit", limit_price=p.limit, stop_price=p.trigger,
                      tif="day")
        try:
            self._submit(order, protective=False)
        except GuardRejected as e:
            p.state = "aborted"
            self._note(p, "entry_blocked", str(e))
            self._persist(p)
            return
        except (SubmitFailed, BrokerRejected) as e:
            p.state = "aborted"
            self._note(p, "entry_failed", str(e))
            self._persist(p)
            return
        p.state = "entry_working"
        self._note(p, "entry_placed", p.trigger, p.limit, p.qty)
        self._persist(p)

    def _record_fill(self, p: TradePlan, e: Order, notify: bool = True) -> bool:
        """Book a new entry fill. The first fill counts the entry once (on_entry). With notify=False the caller calls
        on_entry itself (True is returned when it is owed), so the stop is placed before the runner's bookkeeping."""
        owed = False
        if e.filled_qty > p.filled_qty:
            p.filled_qty, p.avg_entry = e.filled_qty, e.avg_fill_price
            self._note(p, "entry_fill", e.filled_qty, e.avg_fill_price)
            if not p.entry_counted:
                p.entry_counted = True
                cb = self.on_entry
                if cb is not None and notify:
                    cb(p)
                else:
                    owed = cb is not None
            self._persist(p)
        return owed

    def _a_sell_filled(self, p: TradePlan) -> bool:
        """Has any sell of the plan's (its stops and exits, read by id) filled? A stop id alone is no evidence: its
        submit may never have reached the broker."""
        for cid in p.sell_ids:
            o = self._read(cid)
            if o is not None and o.filled_qty > 0:
                return True
        return False

    def _stop_filled(self, p: TradePlan) -> bool:
        """Has the plan's stop already sold? (Read by id: a stop-out while the entry is still working.)"""
        if not p.stop_id:
            return False
        st = self._read(p.stop_id)
        return st is not None and st.status == OrderStatus.FILLED

    def sync(self, p: TradePlan) -> None:
        """Called every loop: resolve submits, react to fills, keep the stop sized, detect flat."""
        if p.state == "submitting":
            e = self.b.get_order(p.entry_id)                 # TransportError propagates; retried next loop
            if e is None:
                p.state = "aborted"
                self._note(p, "entry_not_at_broker")
                self._persist(p)
                return
            p.state = "entry_working"
            self._persist(p)
        if p.state == "entry_working":
            e = self.b.get_order(p.entry_id)
            if e is not None:
                owed = self._record_fill(p, e, notify=False)
                try:
                    if p.filled_qty and self._stop_filled(p):
                        # The stop sold the filled part while the rest of the entry still works: the rest would buy
                        # back below the stop. It is cancelled; the flat check below closes the plan as a stop-out.
                        self._note(p, "stopped_while_entry_working")
                        self.cancel_entry_remainder(p)
                    elif p.filled_qty:
                        self.ensure_stop(p)                  # the stop first: the runner's bookkeeping can wait
                finally:
                    if owed and self.on_entry is not None:
                        self.on_entry(p)
                if p.state == "entry_working":
                    if e.status == OrderStatus.FILLED:
                        p.state = "in_position"
                    elif e.status.terminal:                  # cancelled, expired or rejected
                        p.state = "in_position" if p.filled_qty > 0 else "aborted"     # audit C2
                self._persist(p)
        if p.state in ACTIVE_POSITION and self._position_qty(p.symbol) <= 0:
            if p.filled_qty > 0 and not self._a_sell_filled(p):
                # Filled shares and no sell of the plan's has filled (no stop placed, or one that never reached the
                # broker): nothing could have sold them, so a flat read is a position read lagging the fill. Closing
                # here would leave the shares unmanaged; the runner's reconcile protects them once the position shows.
                if not (p.log and p.log[-1][0] == "flat_read_before_stop"):
                    self._note(p, "flat_read_before_stop")
                    self._persist(p)
            elif self._stable_position(p.symbol) <= 0:       # two reads agree: not a lagging read
                self._close(p, "stop")                       # audit C1: a stop-out is a close like any other

    def held_for_exit(self, p: TradePlan) -> bool:
        """True while the plan's stop is one an exit asked to cancel without a confirmation, for at most EXIT_HOLD_S
        (DEC-0071). Tied to that stop's id: a stop placed since is never held."""
        return bool(p.stop_id) and p.exit_hold_stop == p.stop_id and self.clock() < p.exit_hold_until

    def end_hold(self, p: TradePlan) -> None:
        """End a DEC-0071 hold now: no exit will be asked again (the session is over), so the stop goes back at the
        next ensure_stop. Without this, a hold begun in the last seconds before the close would leave the shares
        without a stop overnight."""
        if p.exit_hold_stop or p.exit_hold_until:
            p.exit_hold_stop, p.exit_hold_until = "", 0.0
            self._persist(p)

    def ensure_stop(self, p: TradePlan) -> None:
        """A GTC stop for min(entry fills, long position), replacing a wrongly sized one (cancel confirmed first)."""
        cur = self._read(p.stop_id) if p.stop_id else None
        want = min(p.filled_qty, max(self._position_qty(p.symbol), 0))
        if (cur is None or cur.status.terminal) and self.held_for_exit(p):
            return                          # the exit asked for it to go and is asked again: it sells next (DEC-0071)
        if cur is not None and not cur.status.terminal:
            if cur.qty - cur.filled_qty == want:
                return
            self.b.cancel(p.stop_id)
            ok, _ = self._confirm_terminal(p.stop_id)
            if not ok:
                self._note(p, "stop_resize_deferred")
                return
            want = min(p.filled_qty, max(self._position_qty(p.symbol), 0))
        if want <= 0:
            return
        p.stop_id = self._next_id(p, "stop")
        p.sell_ids.append(p.stop_id)
        self._persist(p)                    # saved before it is sent: a crash once the broker holds the stop must not
        #                                     leave a resting stop that the restarted plan does not know
        self._submit(Order(p.stop_id, p.symbol, "sell", want, "stop", stop_price=p.stop, tif="gtc"), protective=True)
        self._note(p, "stop_placed", p.stop, want)
        self._persist(p)

    def cancel_entry_remainder(self, p: TradePlan) -> None:
        e = self.b.get_order(p.entry_id)
        if e is not None and not e.status.terminal:
            self.b.cancel(p.entry_id)
            ok, e = self._confirm_terminal(p.entry_id)
            if not ok:
                self._note(p, "entry_cancel_unconfirmed")
                return
        if e is not None:
            self._record_fill(p, e)
        self._note(p, "entry_remainder_canceled", p.qty - p.filled_qty)
        p.state = "in_position" if p.filled_qty > 0 else "aborted"                 # audit C2
        self._persist(p)
        if p.state == "in_position":
            self.ensure_stop(p)

    def exit_now(self, p: TradePlan, limit_price: float | None, reason: str, market: bool = False) -> bool:
        """Cancel stop -> confirm -> sell min(position, fills). Returns True when flat."""
        if p.stop_id:
            s = self._read(p.stop_id)
            if s is not None and not s.status.terminal:
                self.b.cancel(p.stop_id)
                ok, _ = self._confirm_terminal(p.stop_id)
                if not ok:
                    if p.exit_hold_stop != p.stop_id:            # the hold starts once per stop: never extended
                        p.exit_hold_stop, p.exit_hold_until = p.stop_id, self.clock() + EXIT_HOLD_S
                    self._note(p, "exit_deferred", reason, "stop cancel not confirmed")
                    self._persist(p)
                    return False
        p.exit_hold_stop, p.exit_hold_until = "", 0.0
        qty = self._stable_position(p.symbol)
        if qty <= 0:
            self._close(p, "stop" if p.sell_ids else reason)
            return True
        p.exit_id = self._next_id(p, f"exit-{reason}")
        p.sell_ids.append(p.exit_id)
        p.state = "exiting"
        self._persist(p)
        order = Order(p.exit_id, p.symbol, "sell", min(qty, p.filled_qty), "market" if market else "limit",
                      limit_price=None if market else limit_price, tif="day")
        try:
            self._submit(order, protective=True)
        except (SubmitFailed, BrokerRejected, GuardRejected) as e:
            self._note(p, "exit_failed", reason, str(e))
            return self._reprotect(p)
        waited = 0.0
        while waited < self.sell_timeout_s:
            x = self.b.get_order(p.exit_id)
            if x is not None and x.status == OrderStatus.FILLED:
                p.exit_reason = reason
                self._close(p, reason)
                return True
            self.sleep(0.5)
            waited += 0.5
        self.b.cancel(p.exit_id)
        ok, _ = self._confirm_terminal(p.exit_id)
        if not ok:
            self._note(p, "exit_cancel_unconfirmed", reason)
            return False                              # reconcile re-protects next loop if the exit never filled
        return self._reprotect(p)

    def _reprotect(self, p: TradePlan) -> bool:
        rem = self._stable_position(p.symbol)
        if rem <= 0:
            self._close(p, p.exit_reason or "exit")
            return True
        p.state = "in_position"
        p.stop_id = ""
        self.ensure_stop(p)
        self._note(p, "exit_unfilled_restopped", rem)
        self._persist(p)
        return False

    # ---- reconciliation -------------------------------------------------------------------------
    def reconcile(self, managed: set[str], stop_for: dict[str, float], plan: TradePlan | None = None,
                  keep: set[str] | frozenset[str] = frozenset()) -> list[str]:
        """Broker = source of truth for this strategy's symbols. Returns actions taken or flagged. `keep`: symbols
        whose orders belong to another active plan; this call does not manage them and never cancels them as
        strays (DEC-0077)."""
        acts: list[str] = []
        orders = self._live(self.b.open_orders())
        positions = {p.symbol: p.qty for p in self.b.positions()}
        ours = [o for o in orders if is_ours(o.client_order_id, self.strategy)]
        for sym in sorted(managed):
            q = positions.get(sym, 0)
            if q < 0:
                acts.append(f"SHORT position {sym} x{q}: must never happen on this account; flatten required")
            sells = sorted((o for o in ours if o.symbol == sym and o.side == "sell"),
                           key=lambda o: o.client_order_id)
            remaining = list(sells)
            resting = sum(o.qty - o.filled_qty for o in remaining)
            for o in reversed(sells):                   # excess sells could open a short: cancel them
                if resting <= max(q, 0):
                    break
                self.b.cancel(o.client_order_id)
                remaining.remove(o)
                resting -= o.qty - o.filled_qty
                acts.append(f"cancelled excess sell {o.client_order_id} {sym} x{o.qty - o.filled_qty}")
            stop_qty = sum(o.qty - o.filled_qty for o in remaining if o.type in ("stop", "stop_limit"))
            if q <= 0 or stop_qty >= q:
                continue
            try:
                if plan is not None and plan.symbol == sym and plan.active and plan.filled_qty:
                    if self.held_for_exit(plan):    # DEC-0071: its exit cancelled the stop and is asked again
                        acts.append(f"held {sym}: stop cancelled for an exit that is due; not replaced")
                        continue
                    self.ensure_stop(plan)          # resizes or replaces the plan's own stop (cancel confirmed)
                    acts.append(f"protected {sym}: stop for {min(q, plan.filled_qty)} @ {plan.stop}")
                elif sym in stop_for:
                    cid = coid(time.strftime("%Y-%m-%d"), self.strategy or "X", sym, f"reconcile-{q}",
                               int(time.time() * 1000))
                    self._submit(Order(cid, sym, "sell", q - stop_qty, "stop", stop_price=stop_for[sym], tif="gtc"),
                                 protective=True)
                    acts.append(f"placed missing stop {sym} x{q - stop_qty} @ {stop_for[sym]} (no plan: fallback stop)")
                else:
                    acts.append(f"UNKNOWN unprotected position {sym} x{q}: flatten required")
            except GuardRejected as e:
                acts.append(f"UNPROTECTED {sym} x{q}: stop deferred ({e})")
        for o in ours:
            if o.symbol not in managed and o.symbol not in keep:
                self.b.cancel(o.client_order_id)
                acts.append(f"cancelled stray order {o.client_order_id} {o.symbol}")
        return acts


def reconcile(broker: Broker, known_symbols: set[str], stop_for: dict[str, float],
              managed: set[str] | None = None, strategy: str | None = None) -> list[str]:
    """Compatibility wrapper for callers of the old module-level function."""
    return OMS(broker, strategy=strategy).reconcile(managed if managed is not None else set(known_symbols), stop_for)
