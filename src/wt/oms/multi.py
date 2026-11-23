"""The order manager for plans that sell in parts and move their stop (sleeve S, DEC-0066).

`wt.oms.manager.OMS` runs one plan whose whole position leaves at once. The registered gap exit sells half at the
first target, moves the stop to breakeven, and trails it. This subclass adds exactly that, and leaves the base
class, which the QQQ rule uses, unchanged.

  partial_exit   Sell part of a position with a limit, never leaving the rest without its stop:
                   1. cancel the stop and confirm the cancel (an error is not a confirmation);
                   2. rest a new stop for the shares that will remain;
                   3. send the sell for the shares that leave (it now fits inside "sell <= position - resting sells");
                   4. wait for it; if it does not fill in time, cancel it and confirm;
                   5. size the stop to whatever position is left.
                 The shares being sold are without a stop from step 2 until they fill or step 5 runs: seconds, and
                 the same window `exit_now` already has for a whole position. A cancel sent in step 1 and not
                 confirmed starts the DEC-0071 hold, as in `exit_now` (DEC-0075): the stop is not put back while
                 the sale is asked again.
  move_stop      Raise the stop: cancel, confirm, save the new price, rest the new stop. Never lowers it. If the
                 broker refuses the new stop (the market is already under it), the old price is put back.
                 A move whose cancel is not confirmed keeps the old stop resting and saves the new price as
                 `stop_deferred` (DEC-0075): the stop that replaces the old one once it is gone rests at the new
                 price, never the old one, and falls back to the old price if the broker refuses it.
  reconcile_all  Reconcile several active plans together. A partial sell left resting by a crash is cancelled
                 first, since with it resting the stop cannot be sized to the whole position. Every call names
                 every active plan's symbol, so one plan's call never cancels another's orders as strays.

A plan keeps `stop0`, the stop it entered with: R is measured against it, wherever the stop is moved later.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

from wt.brokers.base import BrokerRejected, TransportError
from wt.core.types import Order, OrderStatus
from wt.oms.manager import ACTIVE_POSITION, EXIT_HOLD_S, OMS, GuardRejected, PlanStore, SubmitFailed, TradePlan


@dataclass
class MultiPlan(TradePlan):
    stop0: float | None = None                     # the stop at entry; None until the stop is first moved
    partial_qty: int = 0                           # shares sold by partial exits so far
    partial_ids: list[str] = field(default_factory=list)
    stop_deferred: float | None = None             # DEC-0075: a raised stop whose old stop's cancel was not confirmed

    @property
    def initial_stop(self) -> float:
        return self.stop if self.stop0 is None else self.stop0


class MultiPlanStore:
    """One file per plan, named by its trade id, in one folder."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def path(self, trade_id: str) -> Path:
        return self.folder / f"{trade_id}.json"

    def save(self, p: TradePlan) -> None:
        PlanStore(self.path(p.trade_id)).save(p)

    def load_all(self) -> list[MultiPlan]:
        known = {f.name for f in fields(MultiPlan)}
        out = []
        for f in sorted(self.folder.glob("*.json")) if self.folder.exists() else []:
            raw: dict[str, Any] = json.loads(f.read_text())
            out.append(MultiPlan(**{k: v for k, v in raw.items() if k in known}))
        return out


class MultiOMS(OMS):
    # ---- the stop ---------------------------------------------------------------------------------------------
    def _cancel_stop(self, p: MultiPlan) -> bool:
        """Cancel the plan's resting stop and confirm it. True when no stop of this plan is resting any more."""
        return self._cancel_stop_sent(p)[0]

    def _cancel_stop_sent(self, p: MultiPlan) -> tuple[bool, bool]:
        """`_cancel_stop`, and whether a cancel was sent: (confirmed gone, cancel sent)."""
        if not p.stop_id:
            return True, False
        try:
            cur = self._read(p.stop_id)
            if cur is None or cur.status.terminal:
                return True, False
            self.b.cancel(p.stop_id)
        except TransportError:
            return False, False                              # a broker that cannot be read confirms nothing
        ok, _ = self._confirm_terminal(p.stop_id)
        return ok, True

    def ensure_stop(self, p: TradePlan) -> None:
        """`OMS.ensure_stop`, and a deferred stop move landing (DEC-0075). With no deferred price it is the base
        method. With one, a stop that replaces the plan's gone stop rests at max(stop, deferred price): the new
        price is saved first, so the journal and the stop's own order agree, and a refused stop falls back to the
        old price. A stop that filled, or a plan that is no longer in its position, drops the deferred price."""
        if not isinstance(p, MultiPlan) or p.stop_deferred is None:
            super().ensure_stop(p)
            return
        cur = self._read(p.stop_id) if p.stop_id else None
        if (cur is not None and cur.status == OrderStatus.FILLED) or p.state not in ACTIVE_POSITION:
            self._drop_deferred(p, "stop filled" if cur is not None and cur.status == OrderStatus.FILLED else p.state)
            super().ensure_stop(p)
            return
        want = min(p.filled_qty, max(self._position_qty(p.symbol), 0))
        if cur is not None and not cur.status.terminal:
            if cur.qty - cur.filled_qty == want:
                return                                       # the old stop still rests: the move waits for it to go
            self.b.cancel(p.stop_id)                         # a resize: the old stop goes first, as in the base
            ok, _ = self._confirm_terminal(p.stop_id)
            if not ok:
                self._note(p, "stop_resize_deferred")
                return
            want = min(p.filled_qty, max(self._position_qty(p.symbol), 0))
            if want <= 0:
                return                                       # it filled meanwhile: the plan closes as a stop
            p.stop_id = ""                                   # confirmed gone; the replacement is placed below
        elif self.held_for_exit(p):
            return                                           # DEC-0071: the exit or sale is asked again and sells
        if want <= 0:
            return
        old, new = p.stop, max(p.stop, float(p.stop_deferred))
        p.stop_deferred = None
        if new <= old + 1e-9:
            self._persist(p)
            super().ensure_stop(p)
            return
        if p.stop0 is None:
            p.stop0 = old
        p.stop = new                                         # saved before it is placed: journal and order agree
        self._persist(p)
        try:
            super().ensure_stop(p)
        except (SubmitFailed, BrokerRejected, GuardRejected) as e:
            self._note(p, "stop_move_refused", new, str(e))
            p.stop, p.stop_id = old, ""
            self._persist(p)
            super().ensure_stop(p)                           # the old price goes back; a failure here propagates
            return
        self._note(p, "stop_moved", old, new, "deferred")
        self._persist(p)

    def _drop_deferred(self, p: MultiPlan, why: str) -> None:
        if p.stop_deferred is not None:
            self._note(p, "stop_deferred_dropped", p.stop_deferred, why)
            p.stop_deferred = None
            self._persist(p)

    def _close(self, p: TradePlan, reason: str) -> None:
        if isinstance(p, MultiPlan):
            p.stop_deferred = None                           # a closed plan has no stop to move (DEC-0075)
        super()._close(p, reason)

    def _place_stop(self, p: MultiPlan, qty: int) -> None:
        p.stop_id = self._next_id(p, "stop")
        p.sell_ids.append(p.stop_id)
        self._persist(p)                                     # known before it is sent (see OMS.ensure_stop)
        self._submit(Order(p.stop_id, p.symbol, "sell", qty, "stop", stop_price=p.stop, tif="gtc"), protective=True)
        self._note(p, "stop_placed", p.stop, qty)
        self._persist(p)

    def move_stop(self, p: MultiPlan, new_stop: float) -> bool:
        """Raise the stop to `new_stop`. Returns True when the new stop is resting."""
        new_stop = round(float(new_stop), 2)
        if p.state != "in_position" or new_stop <= p.stop + 1e-9:
            return False
        if not self._cancel_stop(p):
            # the old stop may still rest: it stays the plan's stop, and the stop that replaces it once it is gone
            # rests at the new price (DEC-0075), not at the old one for the next move to cancel again
            p.stop_deferred = max(new_stop, p.stop_deferred or 0.0)
            self._note(p, "stop_move_deferred", new_stop)
            self._persist(p)
            return False
        p.stop_deferred = None                               # this move supersedes a deferred one
        old = p.stop
        if p.stop0 is None:
            p.stop0 = old
        p.stop, p.stop_id = new_stop, ""
        self._persist(p)
        try:
            self.ensure_stop(p)
        except (SubmitFailed, BrokerRejected, GuardRejected) as e:
            self._note(p, "stop_move_refused", new_stop, str(e))
            p.stop, p.stop_id = old, ""
            self._persist(p)
            self.ensure_stop(p)                              # the old stop goes back; a failure here propagates
            return False
        self._note(p, "stop_moved", old, new_stop)
        self._persist(p)
        return True

    # ---- selling part of the position -------------------------------------------------------------------------
    def partial_exit(self, p: MultiPlan, qty: int, limit_price: float, reason: str) -> int:
        """Sell `qty` shares at `limit_price` or better. Returns the shares sold (0 when nothing left the book).
        A quantity that is the whole position is an ordinary exit."""
        if p.state != "in_position":
            return 0
        pos = self._stable_position(p.symbol)
        if pos <= 0:
            self._close(p, "stop")
            return 0
        qty = min(int(qty), pos)
        if qty <= 0:
            return 0
        if qty >= pos:
            return pos if self.exit_now(p, limit_price, reason) else 0
        ok, sent = self._cancel_stop_sent(p)
        if not ok:
            if sent and p.exit_hold_stop != p.stop_id:      # DEC-0071's hold, once per stop (DEC-0075)
                p.exit_hold_stop, p.exit_hold_until = p.stop_id, self.clock() + EXIT_HOLD_S
            self._note(p, "partial_deferred", reason, "stop cancel not confirmed")
            self._persist(p)
            return 0
        p.exit_hold_stop, p.exit_hold_until = "", 0.0
        try:
            self._place_stop(p, pos - qty)
        except (SubmitFailed, BrokerRejected, GuardRejected) as e:
            self._note(p, "partial_failed", reason, f"stop for the remainder: {e}")
            p.stop_id = ""
            self.ensure_stop(p)
            return 0
        cid = self._next_id(p, f"partial-{reason}")
        p.sell_ids.append(cid)
        p.partial_ids.append(cid)
        self._persist(p)
        try:
            self._submit(Order(cid, p.symbol, "sell", qty, "limit", limit_price=limit_price, tif="day"),
                         protective=True)
        except (SubmitFailed, BrokerRejected, GuardRejected) as e:
            self._note(p, "partial_failed", reason, str(e))
            self.ensure_stop(p)                              # back to a stop for the whole position
            return 0
        waited = 0.0
        while waited < self.sell_timeout_s:
            x = self.b.get_order(cid)
            if x is not None and x.status == OrderStatus.FILLED:
                break
            self.sleep(0.5)
            waited += 0.5
        else:
            self.b.cancel(cid)
            ok, _ = self._confirm_terminal(cid)
            if not ok:
                self._note(p, "partial_cancel_unconfirmed", reason)
                return 0                                     # reconcile_all settles it on the next loop
        return self._settle(p, reason)

    def _settle(self, p: MultiPlan, reason: str = "") -> int:
        """Count what the plan's partial sells have filled, and size the stop to the position that is left."""
        sold = 0
        for cid in p.partial_ids:
            o = self.b.get_order(cid)
            if o is not None:
                sold += o.filled_qty
        new = sold - p.partial_qty
        if new > 0:
            p.partial_qty = sold
            self._note(p, "partial_filled", reason, new)
        self._persist(p)
        if self._position_qty(p.symbol) <= 0:
            self._close(p, "stop")                           # flat after a partial: the rest left through its stop
        else:
            self.ensure_stop(p)
        return max(new, 0)

    # ---- several plans ----------------------------------------------------------------------------------------
    def reconcile_all(self, plans: list[MultiPlan]) -> list[str]:
        """Reconcile every active plan. Returns the actions taken or flagged, as `OMS.reconcile` words them."""
        active = [p for p in plans if p.active]
        managed = {p.symbol for p in active}
        acts: list[str] = []
        for p in active:
            for cid in p.partial_ids:                        # a partial sell a crash left resting
                try:
                    o = self._read(cid)
                except TransportError:
                    continue
                if o is not None and not o.status.terminal:
                    self.b.cancel(cid)
                    ok, _ = self._confirm_terminal(cid)
                    acts.append(f"cancelled resting partial {cid} {p.symbol}" if ok else
                                f"UNPROTECTED {p.symbol}: partial {cid} cancel not confirmed")
            if p.state == "in_position" and p.partial_ids:
                self._settle(p)
            others = managed - {p.symbol}
            acts += [a for a in self.reconcile(managed, {}, plan=p)
                     if not any(f"position {sym} " in a or a.startswith(f"UNPROTECTED {sym} ") for sym in others)]
        return acts
