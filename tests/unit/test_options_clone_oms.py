"""The options clone's order management, guard and latches under fault injection (DEC-0030, plan Part 0.D)."""
from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path

import pytest
import yaml

from wt.brokers.alpaca_options_paper import keys
from wt.brokers.base import BrokerRejected
from wt.brokers.sim import SimBroker
from wt.core.types import Order, OrderStatus, Position
from wt.oms.options import OptionPlan, OptionsOMS, PlanStore, book
from wt.risk.options_guard import Context, Latches, Limits

ROOT = Path(__file__).resolve().parents[2]
LIM = Limits.from_risk(yaml.safe_load((ROOT / "config" / "risk.yaml").read_text()))
SYM = "SPY261019C00580000"
NOW = dt.datetime(2026, 10, 19, 11, 0, tzinfo=dt.UTC)


@pytest.fixture(autouse=True)
def paper_env(monkeypatch):
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    monkeypatch.delenv("APCA_API_BASE_URL", raising=False)


class Sim(SimBroker):
    """SimBroker plus the faults an options exit meets: a refused stop, a cancel that is late, a hand trade."""

    def __init__(self) -> None:
        super().__init__()
        self.refuse_stops = False
        self.late_cancels = 0

    def place(self, order: Order) -> Order:
        if order.type == "stop" and self.refuse_stops:
            raise BrokerRejected("422: stop orders are not supported for options")
        return super().place(order)

    def cancel(self, client_order_id: str) -> None:
        if self.late_cancels:
            self.late_cancels -= 1
            return
        super().cancel(client_order_id)

    def live_sells(self) -> list[Order]:
        return [o for o in self.open_orders() if o.side == "sell"]


def plan(n: int = 1, limit: float = 1.02) -> OptionPlan:
    return OptionPlan(f"2026-10-19-O-{n}", "2026-10-19", "SPY", SYM, "call", "retest", "PDH", 580.0, 579.6, 581.5,
                      limit, 1.00, 2.0, "10:40")


def make(tmp_path: Path, **ctx_kw) -> tuple[Sim, OptionsOMS, dict]:
    b = Sim()
    state: dict = {"names_today": {"SPY"}, "own_qty": {}, "account_holds": set()} | ctx_kw

    def ctx() -> Context:
        return Context(now=NOW, **state)
    oms = OptionsOMS(b, PlanStore(tmp_path / "plans"), LIM, ctx, lambda: NOW, lambda s: None, wait_s=1.0)
    return b, oms, state


def opened(tmp_path: Path, **kw) -> tuple[Sim, OptionsOMS, dict, OptionPlan]:
    b, oms, state = make(tmp_path, **kw)
    p = plan()
    oms.enter(p)
    b.fill(p.entry_id, 1.00)
    oms.sync_entry(p)
    state["own_qty"] = {SYM: p.own_qty}
    return b, oms, state, p


# ---------------------------------------------------------------- entries
def test_an_entry_is_one_limit_buy_saved_before_it_is_sent(tmp_path):
    b, oms, _, p = opened(tmp_path)
    assert p.state == "open" and p.fill == 1.00 and p.own_qty == 1 and len(b.placed) == 1
    o = b.orders[p.entry_id]
    assert (o.side, o.qty, o.type, o.limit_price) == ("buy", 1, "limit", 1.02)
    assert PlanStore(tmp_path / "plans").load_all()[0].state == "open"


def test_a_lost_response_is_resolved_by_id_never_sent_twice(tmp_path):
    b, oms, _ = make(tmp_path)
    p = plan()
    b.lose_next_response = True
    oms.enter(p)
    assert p.state == "entering" and any(n[1] == "submit-unknown" for n in p.notes)
    b.fill(p.entry_id, 0.98)
    oms.sync_entry(p)
    assert p.state == "open" and p.fill == 0.98 and len(b.placed) == 1


def test_an_entry_that_never_reached_the_broker_is_cancelled_not_resent(tmp_path):
    b, oms, _ = make(tmp_path)
    p = plan()
    b.fail_next_place = True
    oms.enter(p)
    oms.sync_entry(p)
    assert p.state == "cancelled" and b.placed == []


def test_an_unfilled_entry_is_cancelled_and_confirmed_and_a_late_fill_is_honoured(tmp_path):
    b, oms, _ = make(tmp_path)
    p = plan()
    oms.enter(p)
    oms.expire_entry(p)
    assert p.state == "cancelled" and b.orders[p.entry_id].status == OrderStatus.CANCELED
    q = plan(2)
    oms.enter(q)
    b.fill(q.entry_id, 1.01)                  # fills while the cancel is on its way
    oms.expire_entry(q)
    assert q.state == "open" and q.fill == 1.01


@pytest.mark.parametrize("kw, limit, why", [
    ({}, 2.05, "cap"),
    ({"names_today": {"QQQ"}}, 1.02, "not one of today's names"),
    ({"kill": True}, 1.02, "KILL"),
    ({"latched": "day"}, 1.02, "latched"),
    ({"account_holds": {SYM}}, 1.02, "already holds"),
    ({"unknown_outstanding": True}, 1.02, "unknown"),
    ({"entries_today": 5}, 1.02, "entries today"),
    ({"attempts": {"SPY": 2}}, 1.02, "entries in SPY"),
    ({"open_positions": 1}, 1.02, "already open"),
    ({"market_open": False}, 1.02, "closed"),
])
def test_the_guard_refuses_an_entry_and_nothing_is_sent(tmp_path, kw, limit, why):
    b, oms, _ = make(tmp_path, **kw)
    p = plan(limit=limit)
    oms.enter(p)
    assert p.state == "rejected" and b.placed == [] and why in p.notes[-1][2]


def test_the_paper_lock_refuses_everything(tmp_path, monkeypatch):
    monkeypatch.setenv("MODE", "live")
    b, oms, _ = make(tmp_path)
    p = plan()
    oms.enter(p)
    assert p.state == "rejected" and b.placed == [] and "paper lock" in p.notes[-1][2]


# ---------------------------------------------------------------- the one resting sell
def test_the_broker_stop_rests_when_accepted(tmp_path):
    b, oms, _, p = opened(tmp_path)
    oms.protect(p, 25, 50, try_stop=True)
    assert p.broker_stop == "accepted" and p.protect_kind == "stop"
    (s,) = b.live_sells()
    assert (s.type, s.stop_price, s.qty) == ("stop", 0.75, 1)


def test_a_refused_stop_leaves_the_target_as_the_only_resting_sell(tmp_path):
    b, oms, _, p = opened(tmp_path)
    b.refuse_stops = True
    oms.protect(p, 25, 50, try_stop=True)
    assert p.broker_stop == "refused" and p.protect_kind == "target"
    (s,) = b.live_sells()
    assert (s.type, s.limit_price) == ("limit", 1.5)
    oms.protect(p, 25, 50, try_stop=True)                       # never a second resting sell
    assert len(b.live_sells()) == 1


def test_a_resting_sell_that_fills_on_its_own_closes_the_trade(tmp_path):
    b, oms, _, p = opened(tmp_path)
    oms.protect(p, 25, 50, try_stop=False)
    b.fill(p.protect_id, 1.50)
    oms.sync_open(p)
    assert p.state == "closed" and p.exit_reason == "target" and p.pnl(0.03) == pytest.approx(49.94)


# ---------------------------------------------------------------- exits
def test_an_exit_cancels_the_resting_sell_then_sells_the_clones_lot(tmp_path):
    b, oms, _, p = opened(tmp_path)
    oms.protect(p, 25, 50, try_stop=True)
    sells_seen = []
    orig = b.place

    def place(o: Order) -> Order:
        sells_seen.append(len(b.live_sells()))
        got = orig(o)
        if o.type == "market":
            b.fill(o.client_order_id, 0.80)
        return got
    b.place = place                                              # type: ignore[method-assign]
    assert oms.exit_now(p, "chart") is True
    assert p.state == "closed" and p.exit_fill == 0.80 and p.exit_reason == "chart"
    assert sells_seen == [0]                                     # the stop was gone before the market sell left
    assert b.pos[SYM].qty == 0


def test_the_target_filling_as_the_exit_fires_is_the_exit(tmp_path):
    b, oms, _, p = opened(tmp_path)
    oms.protect(p, 25, 50, try_stop=False)
    b.fill(p.protect_id, 1.50)                                   # filled, not yet seen by a sync
    assert oms.exit_now(p, "time") is True
    assert p.state == "closed" and p.exit_fill == 1.50 and p.exit_ids == [] and b.pos[SYM].qty == 0


def test_a_late_cancel_defers_the_exit_and_never_doubles_the_sell(tmp_path):
    b, oms, _, p = opened(tmp_path)
    oms.protect(p, 25, 50, try_stop=False)
    b.late_cancels = 1
    assert oms.exit_now(p, "premium") is False and p.state == "exiting" and p.exit_ids == []
    b.fill(p.protect_id, 1.50)                                   # it filled while we waited
    assert oms.exit_now(p, "premium") is True and p.exit_fill == 1.50 and b.pos[SYM].qty == 0


def test_an_exit_with_a_lost_response_is_resolved_before_another_is_sent(tmp_path):
    b, oms, _, p = opened(tmp_path)
    b.lose_next_response = True
    assert oms.exit_now(p, "chart") is False
    first = p.exit_ids[-1]
    assert b.orders[first].status == OrderStatus.ACCEPTED        # it is at the broker, working
    b.fill(first, 0.85)
    assert oms.exit_now(p, "chart") is True and p.exit_ids == [first] and b.pos[SYM].qty == 0


def test_an_exit_still_working_is_cancelled_and_confirmed_before_a_new_one(tmp_path):
    b, oms, _, p = opened(tmp_path)
    assert oms.exit_now(p, "chart") is False                     # the market sell does not fill within the wait
    first = p.exit_ids[-1]
    orig = b.place

    def place(o: Order) -> Order:
        assert b.orders[first].status.terminal                   # the earlier sell is dead before a new one
        got = orig(o)
        b.fill(o.client_order_id, 0.70)
        return got
    b.place = place                                              # type: ignore[method-assign]
    assert oms.exit_now(p, "chart") is True and len(p.exit_ids) == 2 and b.pos[SYM].qty == 0


def test_an_exit_that_never_reached_the_broker_is_sent_again_with_a_new_id(tmp_path):
    b, oms, _, p = opened(tmp_path)
    b.fail_next_place = True
    assert oms.exit_now(p, "flatten") is False
    orig = b.place

    def place(o: Order) -> Order:
        got = orig(o)
        b.fill(o.client_order_id, 0.90)
        return got
    b.place = place                                              # type: ignore[method-assign]
    assert oms.exit_now(p, "flatten") is True and len(set(p.exit_ids)) == 2 and b.pos[SYM].qty == 0


def test_a_lot_taken_by_a_hand_trade_is_unresolved_and_nothing_is_sold(tmp_path):
    b, oms, _, p = opened(tmp_path)
    b.pos[SYM].qty = 0                                           # the owner sold it by hand
    placed = len(b.placed)
    assert oms.exit_now(p, "chart") is True and p.state == "unresolved" and len(b.placed) == placed
    assert book(p, set(), lambda *a, **k: True, 0.03)


def test_the_clone_never_sells_more_than_its_own_lots_in_a_shared_contract(tmp_path):
    b, oms, _, p = opened(tmp_path)
    b.pos[SYM].qty = 3                                           # the owner bought two more by hand
    orig = b.place

    def place(o: Order) -> Order:
        got = orig(o)
        b.fill(o.client_order_id, 1.10)
        return got
    b.place = place                                              # type: ignore[method-assign]
    assert oms.exit_now(p, "time") is True and b.pos[SYM].qty == 2


def test_a_sell_larger_than_the_lot_is_refused_by_the_guard(tmp_path):
    _, oms, state, p = opened(tmp_path)
    state["own_qty"] = {SYM: 0}
    assert oms.exit_now(p, "chart") is False and p.notes[-1][1] == "exit-refused"


# ---------------------------------------------------------------- restart and reconciliation
def test_a_restart_mid_entry_resumes_from_disk(tmp_path):
    b, oms, _ = make(tmp_path)
    p = plan()
    b.lose_next_response = True
    oms.enter(p)
    b.fill(p.entry_id, 1.00)
    (again,) = PlanStore(tmp_path / "plans").load_all()           # a new process reads the plan back
    oms.sync_entry(again)
    assert again.state == "open" and len(b.placed) == 1


def test_reconcile_cancels_the_clones_strays_and_never_touches_hand_orders(tmp_path):
    b, oms, _, p = opened(tmp_path)
    b.place(Order("wt-O-20261019-stray0000000", SYM, "sell", 1, "limit", limit_price=9.0))
    b.place(Order("hand-order-1", SYM, "sell", 1, "limit", limit_price=9.0))
    b.pos["QQQ261019P00500000"] = Position("QQQ261019P00500000", 1, 1.2)
    got = oms.reconcile([p])
    assert got["stray_cancelled"] == ["wt-O-20261019-stray0000000"]
    assert b.orders["hand-order-1"].status == OrderStatus.ACCEPTED
    assert got["unknown_positions"] == ["QQQ261019P00500000"] and got["shared"] == []
    b.pos[SYM].qty = 2
    assert oms.reconcile([p])["shared"] == [SYM]


def test_a_trade_is_booked_exactly_once_and_an_unfilled_entry_never(tmp_path):
    b, oms, _, p = opened(tmp_path)
    oms.protect(p, 25, 50, try_stop=False)
    b.fill(p.protect_id, 1.50)
    oms.sync_open(p)
    rows: list[dict] = []

    def write(event: str, **kw) -> bool:
        rows.append({"event": event, **kw})
        return True
    seen: set[str] = set()
    assert book(p, seen, write, 0.03) and book(copy.deepcopy(p), seen, write, 0.03)
    assert len(rows) == 1 and rows[0]["rop"] == pytest.approx(0.4993, abs=1e-4) and rows[0]["counts"]
    q = plan(2)
    q.state = "cancelled"
    assert book(q, seen, write, 0.03) and len(rows) == 1


# ---------------------------------------------------------------- latches
def test_latches_are_durable_and_keyed(tmp_path):
    lat = Latches(tmp_path / "latches")
    mon, tue = dt.date(2026, 10, 19), dt.date(2026, 10, 20)
    assert lat.check(mon, NOW, LIM, day_pnl=-100.0, week_pnl=-100.0, from_peak=-100.0) == "day"
    assert lat.active(tue) is None                               # a new session
    assert lat.check(tue, NOW, LIM, day_pnl=-50, week_pnl=-300.0, from_peak=-300) == "week"
    assert lat.active(dt.date(2026, 10, 26)) is None             # a new week
    assert lat.check(tue, NOW, LIM, day_pnl=0, week_pnl=0, from_peak=-500.0) == "drawdown"
    assert lat.active(dt.date(2027, 1, 4)) == "drawdown"         # until the owner removes it
    (tmp_path / "latches" / "drawdown").unlink()
    (tmp_path / "latches" / "day").write_text("not json")
    assert lat.active(dt.date(2027, 1, 4)) == "day (unreadable latch file)"
    assert json.loads((tmp_path / "latches" / "week").read_text())["key"] == "2026-W43"


# ---------------------------------------------------------------- the account's keys
def test_the_clones_own_account_is_preferred_then_the_shared_one():
    both = {"APCA_CLONE_KEY_ID": "c", "APCA_CLONE_SECRET_KEY": "cs", "APCA_OPTIONS_KEY_ID": "o",
            "APCA_OPTIONS_SECRET_KEY": "os"}
    assert keys(both) == ("c", "cs", True)
    assert keys({k: v for k, v in both.items() if "CLONE" not in k}) == ("o", "os", False)
    assert keys({"APCA_CLONE_KEY_ID": "c"}) is None
