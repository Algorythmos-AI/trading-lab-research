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
                 the same window `exit_now` already has for a whole position.
  move_stop      Raise the stop: cancel, confirm, save the new price, rest the new stop. Never lowers it. If the
                 broker refuses the new stop (the market is already under it), the old price is put back.
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
from wt.oms.manager import OMS, GuardRejected, PlanStore, SubmitFailed, TradePlan


@dataclass
class MultiPlan(TradePlan):
    stop0: float | None = None                     # the stop at entry; None until the stop is first moved
    partial_qty: int = 0                           # shares sold by partial exits so far
    partial_ids: list[str] = field(default_factory=list)

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
        if not p.stop_id:
            return True
        try:
            cur = self._read(p.stop_id)
            if cur is None or cur.status.terminal:
                return True
            self.b.cancel(p.stop_id)
        except TransportError:
            return False                                     # a broker that cannot be read confirms nothing
        ok, _ = self._confirm_terminal(p.stop_id)
        return ok

    def _place_stop(self, p: MultiPlan, qty: int) -> None:
        p.stop_id = self._next_id(p, "stop")
        p.sell_ids.append(p.stop_id)
        self._submit(Order(p.stop_id, p.symbol, "sell", qty, "stop", stop_price=p.stop, tif="gtc"), protective=True)
        self._note(p, "stop_placed", p.stop, qty)
        self._persist(p)

    def move_stop(self, p: MultiPlan, new_stop: float) -> bool:
        """Raise the stop to `new_stop`. Returns True when the new stop is resting."""
        new_stop = round(float(new_stop), 2)
        if p.state != "in_position" or new_stop <= p.stop + 1e-9:
            return False
        if not self._cancel_stop(p):
            self._note(p, "stop_move_deferred", new_stop)
            return False
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
        if not self._cancel_stop(p):
            self._note(p, "partial_deferred", reason, "stop cancel not confirmed")
            return 0
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
