"""Scripted paper-B sessions: the real runner loop on SimBroker, a fake market-data feed and a fake clock.

Covers the canary protocol's simulated sessions: gap-through stop-out that trips the -2% latch; crash and
restart mid-trade (no second entry, booked once); partial fill cancelled at 15:30; a KILL night that arms and
never trades. Phase 2 (L1, L1b, L2, L4, L5): every refusal or failure with a position open still flattens;
orphans and earlier plans are adopted and exited; a close is journaled and booked exactly once across a crash;
a short pages and is never covered; clock skew blocks an entry; positions outside the mandate are never touched.
"""
from __future__ import annotations

import datetime as dt
import json
from types import SimpleNamespace

import time

import numpy as np
import pandas as pd
import pytest

from wt.brokers.base import BrokerClock
from wt.brokers.sim import SimBroker
from wt.core.clock import ET
from wt.core.ids import coid
from wt.core.types import Order, OrderStatus, Position
from wt.live import runner_b
from wt.oms.manager import PlanStore, TradePlan
from wt.ops.alerts import Pager
from wt.risk.virtual_account import VirtualAccount

DAY = dt.date(2026, 9, 30)
REAL_SIGNAL = runner_b.setups.b_intraday_momentum       # the env fixture replaces it with a scripted one


class Crash(BaseException):
    """Simulates the process dying (not caught by the runner's `except Exception`)."""


class Clock:
    def __init__(self, start: dt.datetime, hook=None, crash_at: dt.datetime | None = None):
        self.t, self.hook, self.crash_at = start, hook, crash_at

    def now(self) -> dt.datetime:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += dt.timedelta(seconds=max(s, 0.5))
        if self.crash_at and self.t >= self.crash_at:
            raise Crash()
        if self.hook:
            self.hook(self.t)


class FakeREST:
    def __init__(self, clock: Clock):
        self.clock = clock

    def calendar(self, start: str, end: str) -> pd.DataFrame:
        days = [d.date() for d in pd.bdate_range(start, end)]
        return pd.DataFrame({"date": days, "open": ["09:30"] * len(days), "close": ["16:00"] * len(days)})

    def bars(self, symbols, tf, start, end, feed="sip") -> pd.DataFrame:
        n = 390
        o = 500.0
        c = o * (1 + 0.002 * np.sin(np.arange(n) / 20))
        return pd.DataFrame({"t": pd.date_range(start, periods=n, freq="1min"), "o": o, "c": c, "h": c, "l": c, "v": 1e5})

    def get(self, url: str, params: dict) -> dict:
        sym = params["symbols"]
        now = self.clock.now()
        if "quotes/latest" in url:
            bid = 250.00 if sym == "QQQM" else 500.00
            return {"quotes": {sym: {"bp": bid, "ap": bid + 0.02, "t": now.astimezone(dt.UTC).isoformat()}}}
        start = dt.datetime.combine(DAY, dt.time(9, 30), tzinfo=ET)
        mins = int((now - start).total_seconds() // 60)
        rows = [{"t": (start + dt.timedelta(minutes=i)).astimezone(dt.UTC).isoformat(), "o": 500, "h": 500.6,
                 "l": 499.9, "c": 500.5, "v": 1e4} for i in range(max(mins, 0))]
        return {"bars": {sym: rows}}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.setattr(runner_b, "LIVE", tmp_path / "live")
    monkeypatch.setattr(runner_b, "KILL", tmp_path / "KILL")
    monkeypatch.setattr(runner_b, "MIN_FREE_GB", 0.0)          # the host's free disk must not decide these tests
    monkeypatch.setattr("wt.risk.mandate.LEGACY_FILE", tmp_path / "legacy_positions.yaml")   # nor its config
    monkeypatch.setattr(runner_b.events, "coverage_ok", lambda d: True)
    monkeypatch.setattr(runner_b.events, "policy", lambda now: ("normal", None))
    fired = {"done": False}

    def signal(closed, sigma, prev_close, **kw):             # one B signal on the 10:00 bar
        last = pd.Timestamp(closed.t.iloc[-1]).tz_convert(ET)
        if not fired["done"] and last.hour == 10 and last.minute >= 0:
            fired["done"] = True
            return SimpleNamespace(bar_index=len(closed) - 1, trigger=500.5, stop=498.5)
        return None
    monkeypatch.setattr(runner_b.setups, "b_intraday_momentum", signal)
    return tmp_path


class Rec:
    """Records what the runner's pager delivers."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def fire(self, key, title, message, priority=4, tags=()):
        self.calls.append(("fire", key, priority))

    def resolve(self, key, title, message, priority=2):
        self.calls.append(("resolve", key, priority))

    def once_per_day(self, key, title, message, priority=3, day=None):
        self.calls.append(("once_per_day", key, priority))

    def keys(self, kind="fire"):
        return [c[1] for c in self.calls if c[0] == kind]


def synced(b: SimBroker, clk: "Clock", skew_s: float = 0.0) -> SimBroker:
    """Give the simulated broker a market clock that follows the fake clock (minus skew_s)."""
    def clock() -> BrokerClock:
        now = clk.now()
        o, c = at(9, 30), at(16, 0)
        return BrokerClock(timestamp=now - dt.timedelta(seconds=skew_s), is_open=o <= now < c,
                           next_open=o if now < o else o + dt.timedelta(days=1), next_close=c)
    b.clock_fn = clock
    return b


def journal(tmp_path, allow_errors: bool = False) -> list[dict]:
    p = tmp_path / "live" / "journal.jsonl"
    rows = [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []
    errors = [r for r in rows if r["event"] in ("loop_error", "data_timeout")]
    assert allow_errors or not errors, errors[:3]               # a clean session hides no swallowed errors
    return rows


def at(h: int, m: int) -> dt.datetime:
    return dt.datetime.combine(DAY, dt.time(h, m), tzinfo=ET)


def fill_exits_at(b: SimBroker, price: float):
    for o in b.open_orders():
        if o.side == "sell" and o.type in ("limit", "market"):
            b.fill(o.client_order_id, price)


def test_gap_through_stop_is_booked_at_the_real_fill_and_trips_the_latch(env):
    b = SimBroker()

    def hook(now):
        for o in b.open_orders():
            if o.side == "buy" and now >= at(10, 1):
                b.fill(o.client_order_id, 250.26)
            if o.side == "sell" and o.type == "stop" and now >= at(10, 30):
                b.fill(o.client_order_id, 243.00)               # gap through the 249.25 stop
    clk = Clock(at(8, 0), hook)
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(env)
    closed = [r for r in j if r["event"] == "trade_closed"]
    assert len(closed) == 1 and closed[0]["exit"] == 243.0 and closed[0]["exit_price_estimated"] is False
    assert closed[0]["R"] < -6                                   # a gap well beyond 1R, booked as such
    va = VirtualAccount.load(env / "live" / "virtual_account.json")
    assert va.latched and "daily loss" in va.latch_reason
    assert (env / "live" / "virtual_account.json.latch").exists()
    assert b.positions() == [] and b.open_orders() == []
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 1


def test_crash_mid_trade_resumes_without_a_second_entry_and_books_once(env):
    b = SimBroker()

    def hook(now):
        for o in b.open_orders():
            if o.side == "buy" and now >= at(10, 1):
                b.fill(o.client_order_id, 250.26)
        if now >= at(15, 45):
            fill_exits_at(b, 250.60)
    clk = Clock(at(8, 0), hook, crash_at=at(11, 0))
    synced(b, clk)
    with pytest.raises(Crash):
        runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert (env / "live" / f"plan_{DAY}.json").exists()
    clk2 = Clock(at(11, 5), hook)                               # restarted five minutes later
    synced(b, clk2)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk2), now_fn=clk2.now, sleep_fn=clk2.sleep)
    j = journal(env)
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 1          # never re-entered
    assert [r["event"] for r in j].count("trade_closed") == 1
    assert [r for r in j if r["event"] == "armed"][-1]["resumed_plan"] == "in_position"
    va = VirtualAccount.load(env / "live" / "virtual_account.json")
    assert va.trades_by_day[DAY.isoformat()] == 1 and len(va.recorded_trades) == 1
    assert b.positions() == [] and b.open_orders() == []
    assert len(b.placed) == len(set(b.placed))


def test_partial_fill_cancelled_at_1530_is_protected_and_flattened(env):
    b = SimBroker()

    def hook(now):
        for o in b.open_orders():
            if o.side == "buy" and o.filled_qty == 0 and now >= at(10, 1):
                b.fill(o.client_order_id, 250.26, qty=1)          # 1 of 2 fills, the rest never does
        if now >= at(15, 50):
            fill_exits_at(b, 250.40)
    clk = Clock(at(8, 0), hook)
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    entry = next(o for o in b.orders.values() if o.side == "buy")
    assert entry.status == OrderStatus.CANCELED and entry.filled_qty == 1
    closed = [r for r in journal(env) if r["event"] == "trade_closed"]
    assert len(closed) == 1 and closed[0]["qty"] == 1
    assert b.positions() == [] and b.open_orders() == []
    assert not [r for r in journal(env) if r["event"] == "END_OF_DAY_NOT_FLAT"]


def test_kill_night_arms_and_never_trades(env):
    (env / "KILL").write_text("paused")
    b = SimBroker()
    clk = Clock(at(8, 0))
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(env)
    events = [r["event"] for r in j]
    assert "armed" in events and events[-1] == "session_end" and b.placed == []
    assert any("kill_file" in r.get("blockers", []) for r in j if r["event"] == "blocked")


def test_untrusted_state_turns_entries_off_but_the_session_runs(env):
    (env / "live").mkdir(parents=True)
    (env / "live" / "virtual_account.json.latch").write_text("day -2%")     # latched account file deleted
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(env)
    refusal = next(r for r in j if r["event"] == "refuse_to_arm")
    assert refusal["exits_only"] is True and "latch" in refusal["reason"]
    assert j[-1]["event"] == "session_end" and b.placed == []
    assert not (env / "live" / "virtual_account.json").exists()             # a default account is never saved
    assert (env / "live" / "virtual_account.json.latch").exists()


def test_disk_floor_turns_entries_off_but_the_session_runs(env, monkeypatch):
    monkeypatch.setattr(runner_b, "MIN_FREE_GB", 1e9)            # more than any disk has
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(env)
    assert any(r["event"] == "refuse_to_arm" and "free disk" in r["reason"] for r in j)
    assert j[-1]["event"] == "session_end" and b.placed == []


# ---- phase 2: a position is never abandoned --------------------------------------------------------------------

PREV = "2026-09-29"


def seed_prior_plan(env, b: SimBroker, qty: int = 2) -> TradePlan:
    """Yesterday's plan still holds QQQM (the runner died before its end-of-day exit); its GTC stop rests."""
    stop_id = coid(PREV, "B", "QQQM", "stop", 1)
    p = TradePlan(date=PREV, strategy="B", symbol="QQQM", qty=qty, trigger=250.2, limit=250.4, stop=249.25,
                  target=252.2, seq=2, entry_id=coid(PREV, "B", "QQQM", "entry", 0), stop_id=stop_id,
                  sell_ids=[stop_id], filled_qty=qty, avg_entry=250.26, state="in_position", entry_counted=True)
    b.pos["QQQM"] = Position("QQQM", qty, 250.26)
    b.place(Order(stop_id, "QQQM", "sell", qty, "stop", stop_price=249.25, tif="gtc"))
    PlanStore(env / "live" / f"plan_{PREV}.json").save(p)
    va = VirtualAccount()
    va.count_entry(dt.date.fromisoformat(PREV), p.trade_id)
    va.save(env / "live" / "virtual_account.json")
    return p


def fill_market_sells(b: SimBroker, price: float):
    def hook(now):
        for o in b.open_orders():
            if o.side == "sell" and o.type in ("market", "limit"):
                b.fill(o.client_order_id, price)
    return hook


class Boom(FakeREST):
    def __init__(self, clock, fail: str):
        super().__init__(clock)
        self.fail = fail

    def calendar(self, start, end):
        if self.fail == "calendar":
            raise ConnectionError("calendar down")
        return super().calendar(start, end)

    def bars(self, *a, **k):
        if self.fail == "signal_inputs":
            raise ConnectionError("history down")
        return super().bars(*a, **k)


@pytest.mark.parametrize("cause", ["none", "disk", "state", "events", "signal_inputs", "calendar"])
def test_an_earlier_plans_position_is_exited_at_the_open_whatever_refuses(env, monkeypatch, cause):
    b = SimBroker()
    p = seed_prior_plan(env, b)
    if cause == "disk":
        monkeypatch.setattr(runner_b, "MIN_FREE_GB", 1e9)
    if cause == "state":
        (env / "live" / "virtual_account.json").unlink()
        (env / "live" / "virtual_account.json.latch").write_text("latched")
    if cause == "events":
        monkeypatch.setattr(runner_b.events, "coverage_ok", lambda d: False)
    clk = Clock(at(8, 0), fill_market_sells(b, 251.00))
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=Boom(clk, cause), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(env)
    assert b.positions() == [] and b.open_orders() == []
    assert not [c for c in b.placed if b.orders[c].side == "buy"]                    # never an entry
    exit_order = next(b.orders[c] for c in b.placed if b.orders[c].type == "market")
    assert exit_order.status == OrderStatus.FILLED
    closed = [r for r in j if r["event"] == "trade_closed"]
    assert len(closed) == 1 and closed[0]["trade_id"] == p.trade_id and closed[0]["exit"] == 251.0
    assert closed[0]["booked"] is (cause != "state")
    if cause != "none":
        assert any(r["event"] == "refuse_to_arm" and r["exits_only"] for r in j)
    saved = PlanStore(env / "live" / f"plan_{PREV}.json").load()
    assert saved.state == "closed" and saved.recorded is (cause != "state")
    assert saved.exit_reason == "adopted_exit"                   # exited at the open, not left to the close


def test_an_orphan_is_adopted_exited_and_never_booked(env):
    (env / "KILL").write_text("paused")
    b = SimBroker()
    b.pos["QQQM"] = Position("QQQM", 3, 250.00)                  # nobody's plan placed this
    clk = Clock(at(8, 0), fill_market_sells(b, 250.50))
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(env)
    assert b.positions() == [] and b.open_orders() == []
    closed = [r for r in j if r["event"] == "trade_closed"]
    assert len(closed) == 1 and closed[0]["origin"] == "orphan" and closed[0]["booked"] is False
    assert closed[0]["R"] is None
    va = VirtualAccount.load(env / "live" / "virtual_account.json") \
        if (env / "live" / "virtual_account.json").exists() else VirtualAccount()
    assert va.equity == 600.0 and va.recorded_trades == []
    assert "paper-b:orphan" in rec.keys()


def test_an_orphan_is_resumed_after_a_restart_not_adopted_twice(env):
    (env / "KILL").write_text("paused")
    b = SimBroker()
    b.pos["QQQM"] = Position("QQQM", 3, 250.00)
    clk = Clock(at(8, 0), crash_at=at(9, 0))                     # dies after adopting, before the open
    synced(b, clk)
    with pytest.raises(Crash):
        runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    clk2 = Clock(at(9, 5), fill_market_sells(b, 250.50))
    synced(b, clk2)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk2), now_fn=clk2.now, sleep_fn=clk2.sleep)
    j = journal(env)
    assert [r["event"] for r in j].count("adopted_orphan") == 1
    assert [r["event"] for r in j].count("resumed_orphan") == 1
    assert b.positions() == [] and len(b.placed) == len(set(b.placed))


def test_an_earlier_unbooked_close_is_booked_at_arm(env):
    b = SimBroker()
    p = seed_prior_plan(env, b)
    b.fill(p.stop_id, 249.20)                                    # yesterday's stop filled; nobody booked it
    p.state, p.exit_reason = "closed", "stop"
    PlanStore(env / "live" / f"plan_{PREV}.json").save(p)
    (env / "KILL").write_text("paused")
    clk = Clock(at(8, 0))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    closed = [r for r in journal(env) if r["event"] == "trade_closed"]
    assert len(closed) == 1 and closed[0]["exit"] == pytest.approx(249.20)
    va = VirtualAccount.load(env / "live" / "virtual_account.json")
    assert p.trade_id in va.recorded_trades and va.day_pnl[PREV] == pytest.approx(2 * (249.20 - 250.26))


def test_a_crash_between_booking_and_journaling_journals_once(env, monkeypatch):
    b = SimBroker()
    real_log = runner_b.log
    state = {"crashed": False}

    def log(event, **kw):
        if event == "trade_closed" and not state["crashed"]:
            state["crashed"] = True
            raise Crash()                                        # dies after the account was booked and saved
        real_log(event, **kw)
    monkeypatch.setattr(runner_b, "log", log)

    def hook(now):
        for o in b.open_orders():
            if o.side == "buy" and now >= at(10, 1):
                b.fill(o.client_order_id, 250.26)
            if o.side == "sell" and o.type == "stop" and now >= at(10, 30):
                b.fill(o.client_order_id, 249.00)
    clk = Clock(at(8, 0), hook)
    synced(b, clk)
    with pytest.raises(Crash):
        runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    va = VirtualAccount.load(env / "live" / "virtual_account.json")
    assert len(va.recorded_trades) == 1                          # booked before the crash
    clk2 = Clock(at(10, 40), hook)
    synced(b, clk2)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk2), now_fn=clk2.now, sleep_fn=clk2.sleep)
    j = journal(env)
    assert [r["event"] for r in j].count("trade_closed") == 1
    va = VirtualAccount.load(env / "live" / "virtual_account.json")
    assert len(va.recorded_trades) == 1 and va.equity == pytest.approx(600 + 2 * (249.00 - 250.26))
    assert PlanStore(env / "live" / f"plan_{DAY}.json").load().recorded is True


def test_a_short_pages_cancels_this_strategys_sells_and_is_never_covered(env):
    (env / "KILL").write_text("paused")
    b = SimBroker()
    sell_id = coid(DAY.isoformat(), "B", "QQQM", "stop", 7)

    def hook(now):
        if now >= at(15, 56) and "QQQM" not in b.pos:
            b.pos["QQQM"] = Position("QQQM", -2, 250.00)          # a short appears near the close
            b.place(Order(sell_id, "QQQM", "sell", 2, "stop", stop_price=248.0, tif="gtc"))
    clk = Clock(at(8, 0), hook)
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(env)
    assert b.orders[sell_id].status == OrderStatus.CANCELED
    assert not [c for c in b.placed if b.orders[c].side == "buy"]                    # never covered
    assert any(r["event"] == "END_OF_DAY_NOT_FLAT" and r.get("short") for r in j)
    assert ("fire", "paper-b:not-flat", 5) in rec.calls


def test_clock_skew_blocks_the_entry(env):
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk, skew_s=5.0)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(env)
    assert b.placed == []
    assert any(r["event"] == "clock_skew" and r["skew_s"] == pytest.approx(5.0) for r in j)
    assert "paper-b:clock-skew" in rec.keys()


def test_a_position_outside_the_mandate_is_flagged_and_never_touched(env, monkeypatch):
    b = SimBroker()
    b.pos["AAPL"] = Position("AAPL", 1, 200.0)

    def hook(now):
        for o in b.open_orders():
            if o.side == "buy" and now >= at(10, 1):
                b.fill(o.client_order_id, 250.26)
        if now >= at(15, 50):
            fill_exits_at(b, 250.40)
    clk = Clock(at(8, 0), hook)
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    assert not [c for c in b.placed if b.orders[c].symbol == "AAPL"]
    assert b.pos["AAPL"].qty == 1
    assert "paper-b:out-of-mandate:AAPL" in rec.keys("once_per_day")
    assert [r["event"] for r in journal(env)].count("trade_closed") == 1          # B still traded QQQM

    rec2 = Rec()
    monkeypatch.setattr(runner_b, "out_of_mandate",
                        lambda pos, allow: [(s, q, True) for s, q in pos if s not in allow])   # recorded as legacy
    b2 = SimBroker()
    b2.pos["AAPL"] = Position("AAPL", 1, 200.0)
    (env / "KILL").write_text("paused")
    clk2 = Clock(at(8, 0))
    synced(b2, clk2)
    runner_b.run(DAY, broker=b2, rest=FakeREST(clk2), now_fn=clk2.now, sleep_fn=clk2.sleep, alerts=rec2)
    assert not rec2.keys("once_per_day")


def test_the_close_unknown_pages_and_leaves_stops_in_place(env):
    b = SimBroker()
    seed_prior_plan(env, b)
    clk = Clock(at(8, 0))                                        # no broker clock configured either
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=Boom(clk, "calendar"), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    assert any(r["event"] == "close_unknown" for r in journal(env))
    assert ("fire", "paper-b:close-unknown", 5) in rec.calls
    assert b.positions()[0].qty == 2 and len(b.open_orders()) == 1                  # the GTC stop still rests


def test_the_pager_never_blocks_the_loop():
    class Slow:
        def __init__(self):
            self.n = 0

        def fire(self, *a):
            time.sleep(0.5)
            self.n += 1
    slow = Slow()
    pager = Pager(slow)
    t0 = time.monotonic()
    for _ in range(5):
        pager.fire("k", "t", "m", 5)
    assert time.monotonic() - t0 < 0.1                            # queued, not delivered inline
    pager.close(timeout_s=10)
    assert slow.n == 5
    full = Pager(Slow(), maxsize=1)
    for _ in range(10):
        full.fire("k", "t", "m", 5)
    assert full.dropped >= 1


# ---- the OCI host: primary lease and shadow role (ADR 0004) ---------------------------------------------------

def test_without_the_primary_lease_the_vm_takes_no_entry(env, monkeypatch):
    from wt.ops import lease
    monkeypatch.setenv("WT_HOST", "systemd")
    monkeypatch.setattr(lease, "acquire", lambda client=None, holder=None: lease.Result(False, "held by mac"))
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(env)
    assert b.placed == []
    assert any(r["event"] == "refuse_to_arm" and "primary lease" in r["reason"] for r in j)
    assert "paper-b:lease" in rec.keys()


def test_with_the_lease_the_vm_trades_as_usual(env, monkeypatch):
    from wt.ops import lease
    monkeypatch.setenv("WT_HOST", "systemd")
    monkeypatch.setattr(lease, "acquire", lambda client=None, holder=None: lease.Result(True, "held by oci-syd"))
    b = SimBroker()

    def hook(now):
        for o in b.open_orders():
            if o.side == "buy" and now >= at(10, 1):
                b.fill(o.client_order_id, 250.26)
        if now >= at(15, 50):
            fill_exits_at(b, 250.40)
    clk = Clock(at(8, 0), hook)
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert [r["event"] for r in journal(env)].count("trade_closed") == 1


def test_the_shadow_host_never_sends_an_order(env, monkeypatch):
    from wt.brokers.shadow import ShadowBroker, ShadowRole
    monkeypatch.setenv("WT_ROLE", "shadow")
    b = SimBroker()
    b.pos["QQQM"] = Position("QQQM", 2, 250.0)                 # even a position is never touched
    clk = Clock(at(8, 0))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert b.placed == []
    assert any(r["event"] == "refuse_to_arm" and "shadow" in r["reason"] for r in journal(env, allow_errors=True))
    with pytest.raises(ShadowRole):
        ShadowBroker(b).place(Order("x", "QQQM", "buy", 1, "market"))


def test_a_broken_evidence_chain_turns_entries_off(env, monkeypatch, tmp_path):
    flag = tmp_path / "state" / "evidence" / "chain-broken"
    flag.parent.mkdir(parents=True)
    flag.write_text("forward: line 3: prev_sha256 does not match line 2\n")
    monkeypatch.setattr(runner_b, "STATE_DIR", tmp_path / "state")
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert b.placed == []
    assert any(r["event"] == "refuse_to_arm" and "evidence hash chain" in r["reason"] for r in journal(env))


# ---- the decision journal (plan v7 A-dec) ----

def _decisions(rows):
    return [r for r in rows if r["event"] == "decision"]


def test_a_kill_night_journals_the_would_be_signal_and_never_trades(env):
    (env / "KILL").write_text("paused")
    b = SimBroker()
    clk = Clock(at(8, 0))
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(env)
    assert b.placed == []
    sigs = [r for r in _decisions(j) if r["would_signal"]]
    assert len(sigs) == 1 and sigs[0]["trigger"] == 500.5 and sigs[0]["stop"] == 498.5
    assert "kill_file" in sigs[0]["blockers"] and sigs[0]["runner_acts"] is False
    summary = next(r for r in j if r["event"] == "decision_summary")
    assert summary["inputs"] and summary["would_signals"] == 1
    assert [r["event"] for r in j].index("decision_summary") < [r["event"] for r in j].index("session_end")


def test_a_shadow_session_journals_decisions_through_a_broker_that_refuses_every_order(env, monkeypatch):
    monkeypatch.setenv("WT_ROLE", "shadow")
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(env, allow_errors=True)
    assert b.placed == []
    sigs = [r for r in _decisions(j) if r["would_signal"]]
    assert len(sigs) == 1 and any(x.startswith("entries_off:shadow") for x in sigs[0]["blockers"])
    assert sigs[0]["sigma"] is not None and sigs[0]["prev_close"] is not None   # computed although entries are off


def test_decision_events_stay_few(env, monkeypatch):
    (env / "KILL").write_text("paused")
    b = SimBroker()
    clk = Clock(at(8, 0))
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert len(_decisions(journal(env))) <= runner_b.DECISION_CAP + 1


def test_the_decision_journal_cannot_reach_the_broker():
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(runner_b.Decisions))
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | \
        {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert not names & {"broker", "oms", "place", "place_entry", "exit_now", "books", "plan", "sig"}


def test_a_failing_decision_journal_never_disturbs_the_session(env, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("journal bug")
    monkeypatch.setattr(runner_b.Decisions, "observe", boom)
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(env, allow_errors=True)
    assert "entry_placed" in [r["event"] for r in j]          # the fake signal still trades as before
    assert any(r["event"] == "decision_error" for r in j)
    assert not any(r["event"] == "loop_error" for r in j)


def test_paper_outcome_ignores_decision_events():
    from wt.ops import jobs
    base = [{"event": "armed"}, {"event": "session_end", "virtual": {}}]
    extra = [{"event": "decision", "would_signal": True}, {"event": "decision_summary", "would_signals": 1}]
    assert jobs.paper_outcome(base) == jobs.paper_outcome(base[:1] + extra + base[1:])


# ---- the real signal through the real loop: a signal on the bar that just closed becomes an order ----

class BreakoutREST(FakeREST):
    """QQQ sits at 500.5, then closes at 503 from the 10:27 bar: above the noise boundary on the 10:29 bar,
    the first half-hour mark after it. `missing` drops minutes the way the IEX feed does when nothing trades."""

    def __init__(self, clock: Clock, missing: tuple[str, ...] = ()):
        super().__init__(clock)
        self.missing = set(missing)

    def get(self, url: str, params: dict) -> dict:
        j = super().get(url, params)
        if "quotes/latest" in url:
            return j
        sym = params["symbols"]
        rows = []
        for r in j["bars"][sym]:
            t = pd.Timestamp(r["t"]).tz_convert(ET)
            if t.strftime("%H:%M") in self.missing:
                continue
            c = 503.0 if (t.hour, t.minute) >= (10, 27) else 500.5
            rows.append({**r, "o": c, "h": c + 0.1, "l": c - 0.1, "c": c})
        return {"bars": {sym: rows}}


@pytest.fixture
def real_signal(env, monkeypatch):
    monkeypatch.setattr(runner_b.setups, "b_intraday_momentum", REAL_SIGNAL)
    monkeypatch.setattr(runner_b.LiveData, "sigma_and_prev_close", lambda self, day, sessions: (0.004, 500.0))
    return env


def _round_trip(b: SimBroker):
    def hook(now):
        for o in b.open_orders():
            if o.side == "buy" and now >= at(10, 31):
                b.fill(o.client_order_id, o.stop_price or o.limit_price)
        if now >= at(15, 45):
            fill_exits_at(b, 252.00)
    return hook


@pytest.mark.parametrize("missing", [(), ("09:47",), ("09:47", "10:12", "10:28")])
def test_the_real_signal_on_the_bar_that_just_closed_becomes_one_order(real_signal, missing):
    b = SimBroker()
    clk = Clock(at(8, 0), _round_trip(b))
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=BreakoutREST(clk, missing), now_fn=clk.now, sleep_fn=clk.sleep)
    j = journal(real_signal)
    placed = [r for r in j if r["event"] == "entry_placed"]
    assert len(placed) == 1, [r["event"] for r in j if r["event"].startswith(("entry", "signal", "decision"))]
    sig = next(r for r in j if r["event"] == "decision" and r["would_signal"])
    assert sig["runner_acts"] is True and sig["signal_bar"] == 59 and sig["blockers"] == []
    assert sig["closed_bars"] == 60                                   # seen when the 10:29 bar closed, not a bar later
    assert pd.Timestamp(sig["signal_t"]).tz_convert(ET).strftime("%H:%M") == "10:29"
    assert sum(1 for c in b.placed if b.orders[c].side == "buy") == 1
    assert [r["event"] for r in j].count("trade_closed") == 1
    assert j[-1]["event"] == "session_end" and j[-1]["outcome"] == "traded"
    assert b.positions() == [] and b.open_orders() == []


def test_the_default_signal_never_names_the_newest_bar_so_backtests_are_unchanged():
    n = 60
    c = np.where(np.arange(n) >= 57, 503.0, 500.5)
    bars = pd.DataFrame({"t": pd.date_range("2026-09-30 13:30", periods=n, freq="1min", tz="UTC"),
                         "o": c, "h": c + 0.1, "l": c - 0.1, "c": c, "v": 1e4})
    assert REAL_SIGNAL(bars, 0.004, 500.0) is None                    # bar 59 is the newest: a backtest waits
    live = REAL_SIGNAL(bars, 0.004, 500.0, include_last=True)
    assert live is not None and live.bar_index == 59
    later = pd.concat([bars, bars.tail(1).assign(t=bars.t.iloc[-1] + pd.Timedelta(minutes=1))], ignore_index=True)
    old = REAL_SIGNAL(later, 0.004, 500.0)
    assert old is not None and (old.bar_index, old.trigger, old.stop) == (live.bar_index, live.trigger, live.stop)


def test_a_missing_minute_does_not_move_the_half_hour_marks():
    t = pd.date_range("2026-09-30 13:30", periods=60, freq="1min", tz="UTC")
    full = pd.DataFrame({"t": t, "o": 500.0, "h": 500.2, "l": 499.8, "c": 500.1, "v": 1e4})
    gappy = full.drop(index=[0, 17, 42]).reset_index(drop=True)
    g = runner_b.minute_grid(gappy, at(9, 30))
    assert len(g) == 60 and list(g.t) == list(t)
    assert g.v.iloc[17] == 0 and g.c.iloc[17] == 500.1 and g.o.iloc[0] == 500.0
    assert runner_b.minute_grid(full, at(9, 30)).equals(full)


def test_the_session_names_why_there_was_no_trade(env, monkeypatch):
    (env / "KILL").write_text("paused")
    b = SimBroker()
    clk = Clock(at(8, 0))
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert journal(env)[-1]["outcome"] == "blocked:kill_file"


def test_a_quiet_session_says_no_signal(env, monkeypatch):
    monkeypatch.setattr(runner_b.setups, "b_intraday_momentum", lambda *a, **k: None)
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    assert journal(env)[-1]["outcome"] == "no_signal" and "paper-b:signal-not-acted" not in rec.keys()


@pytest.mark.parametrize("journal_works", [True, False])
def test_a_free_signal_that_places_nothing_pages(real_signal, monkeypatch, journal_works):
    if not journal_works:                                              # the outcome must not depend on the journal
        monkeypatch.setattr(runner_b.Decisions, "observe", lambda *a, **k: None)
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk, skew_s=5.0)                                         # the clock check refuses the entry
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=BreakoutREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    assert b.placed == [] and journal(real_signal)[-1]["outcome"] == "signal_not_acted"
    assert ("fire", "paper-b:signal-not-acted", 4) in rec.calls


# ---- a session whose rule could not be checked is not a quiet market --------------------------------------------

def test_the_outcome_separates_unchecked_from_quiet():
    sig = {"blockers": ["kill_file"]}
    assert runner_b.outcome_of([], False, False) == "no_signal"
    assert runner_b.outcome_of([], False, False, unchecked=True) == "no_inputs"
    assert runner_b.outcome_of([sig], False, False, unchecked=True) == "blocked:kill_file"     # a signal was seen
    assert runner_b.outcome_of([], False, True, unchecked=True) == "signal_not_acted"
    assert runner_b.outcome_of([], True, False, unchecked=True) == "traded"


class NoHistoryREST(FakeREST):
    """No prior session has bars: sigma has nothing to average."""

    def bars(self, symbols, tf, start, end, feed="sip") -> pd.DataFrame:
        return pd.DataFrame({"t": [], "o": [], "c": [], "h": [], "l": [], "v": []})


def test_sigma_with_no_prior_bars_is_inputs_unavailable_not_a_quiet_day(env):
    with pytest.raises(ValueError):
        runner_b.LiveData(NoHistoryREST(Clock(at(8, 0)))).sigma_and_prev_close(DAY, [DAY - dt.timedelta(days=1)])
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=NoHistoryREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(env)
    assert j[-1]["event"] == "session_end" and j[-1]["outcome"] == "no_inputs" and b.placed == []
    assert any(r["event"] == "refuse_to_arm" and "signal inputs unavailable" in r["reason"] for r in j)
    missing = [r for r in j if r["event"] == "decision_inputs_missing"]
    assert len(missing) == 1 and missing[0]["sigma"] is False                   # said once, not on every loop
    summary = next(r for r in j if r["event"] == "decision_summary")
    assert summary["inputs"] is False and summary["asked"] > 100
    assert "paper-b:no-inputs" in rec.keys("once_per_day") and "paper-b:signal-not-acted" not in rec.keys()


class NoBarsTodayREST(FakeREST):
    """History is fine, and today's bars never arrive."""

    def get(self, url: str, params: dict) -> dict:
        return super().get(url, params) if "quotes/latest" in url else {"bars": {}}


def test_a_day_with_no_bars_at_all_is_not_called_no_signal(env):
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=NoBarsTodayREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(env)
    assert j[-1]["outcome"] == "no_inputs" and b.placed == []
    assert [r["closed_bars"] for r in j if r["event"] == "decision_inputs_missing"] == [0]
    assert not any(r["event"] == "refuse_to_arm" for r in j)                    # it armed; the day's data failed
    assert "paper-b:no-inputs" in rec.keys("once_per_day")


class NoSignalQuoteREST(BreakoutREST):
    """QQQM quotes normally; QQQ, the signal's own symbol, has no quote to convert the trigger with."""

    def get(self, url: str, params: dict) -> dict:
        if "quotes/latest" in url and params["symbols"] == "QQQ":
            return {"quotes": {}}
        return super().get(url, params)


def test_a_signal_with_no_quote_to_convert_it_is_journaled(real_signal):
    b = SimBroker()
    clk = Clock(at(8, 0))
    synced(b, clk)
    rec = Rec()
    runner_b.run(DAY, broker=b, rest=NoSignalQuoteREST(clk), now_fn=clk.now, sleep_fn=clk.sleep, alerts=rec)
    j = journal(real_signal)
    skipped = [r for r in j if r["event"] == "signal_skipped_no_quote"]
    assert skipped and skipped[0]["signal_quote"] is False and skipped[0]["trade_mid"] is True
    assert b.placed == [] and j[-1]["outcome"] == "signal_not_acted"
    assert ("fire", "paper-b:signal-not-acted", 4) in rec.calls


# ---- two counts the journal keeps and nothing acts on (DEC-0024, decisions 3 and 6) ----

class ShortHistoryREST(FakeREST):
    """One prior session in three comes back with too few bars to count."""

    def __init__(self, clock: Clock):
        super().__init__(clock)
        self.asked = 0

    def bars(self, symbols, tf, start, end, feed="sip") -> pd.DataFrame:
        self.asked += 1
        b = super().bars(symbols, tf, start, end, feed)
        return b.iloc[:40] if self.asked % 3 == 0 else b


def test_the_journal_says_how_many_sessions_sigma_rests_on(env):
    clk = Clock(at(8, 0))
    whole, short = runner_b.LiveData(FakeREST(clk)), runner_b.LiveData(ShortHistoryREST(clk))
    sessions = [d.date() for d in pd.bdate_range(end=DAY, periods=30)]
    whole.sigma_and_prev_close(DAY, sessions)
    short.sigma_and_prev_close(DAY, sessions)
    assert whole.sigma_sessions == 14 and short.sigma_sessions == 10      # 4 of the 14 were short: left out, not replaced
    b = SimBroker()
    synced(b, clk)
    runner_b.run(DAY, broker=b, rest=ShortHistoryREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    armed = next(r for r in journal(env) if r["event"] == "armed")
    assert armed["sigma_sessions"] == 10 and armed["sigma"] is not None


def test_the_journal_counts_the_marks_where_only_the_spread_check_blocked():
    """A mark is a bar the rule can signal on: the 30th, 60th, ... closed minute. Each is counted once, and it
    counts against the spread check only when nothing else was blocking at that moment."""
    out: list[dict] = []
    d = runner_b.Decisions(lambda event, **kw: out.append({"event": event, **kw}))
    t0 = pd.Timestamp(at(9, 30))
    day = pd.DataFrame({"t": pd.date_range(t0, periods=390, freq="1min"), "o": 500.0, "h": 500.0, "l": 500.0,
                        "c": 500.0, "v": 1e5})
    spread, kill = ["spread_or_no_quote"], ["kill_file", "spread_or_no_quote"]
    blockers = {30: spread, 60: spread, 90: kill, 120: []}
    for n in range(1, 151):
        d.observe(day.iloc[:n], blockers.get(n, spread if n % 30 else []), 0.004, 500.0)
        d.observe(day.iloc[:n], blockers.get(n, []), 0.004, 500.0)        # a second loop on the same bar counts nothing
    d.summary()
    summary = out[-1]
    assert summary["event"] == "decision_summary" and summary["marks"] == 5 and summary["spread_only_marks"] == 2
    assert summary["would_signals"] == 0
