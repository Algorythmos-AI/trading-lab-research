"""Scripted paper-B sessions: the real runner loop on SimBroker, a fake market-data feed and a fake clock.

Covers the canary protocol's simulated sessions: gap-through stop-out that trips the -2% latch; crash and
restart mid-trade (no second entry, booked once); partial fill cancelled at 15:30; a KILL night that arms and
never trades.
"""
from __future__ import annotations

import datetime as dt
import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from wt.brokers.sim import SimBroker
from wt.core.clock import ET
from wt.core.types import OrderStatus
from wt.live import runner_b
from wt.risk.virtual_account import VirtualAccount

DAY = dt.date(2026, 9, 30)


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
    monkeypatch.setattr(runner_b.events, "coverage_ok", lambda d: True)
    monkeypatch.setattr(runner_b.events, "policy", lambda now: ("normal", None))
    fired = {"done": False}

    def signal(closed, sigma, prev_close):                   # one B signal on the 10:00 bar
        last = pd.Timestamp(closed.t.iloc[-1]).tz_convert(ET)
        if not fired["done"] and last.hour == 10 and last.minute >= 0:
            fired["done"] = True
            return SimpleNamespace(bar_index=len(closed) - 1, trigger=500.5, stop=498.5)
        return None
    monkeypatch.setattr(runner_b.setups, "b_intraday_momentum", signal)
    return tmp_path


def journal(tmp_path) -> list[dict]:
    p = tmp_path / "live" / "journal.jsonl"
    rows = [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []
    errors = [r for r in rows if r["event"] in ("loop_error", "data_timeout")]
    assert not errors, errors[:3]                               # a clean session hides no swallowed errors
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
    with pytest.raises(Crash):
        runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert (env / "live" / f"plan_{DAY}.json").exists()
    clk2 = Clock(at(11, 5), hook)                               # restarted five minutes later
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


def test_refusals_are_journaled_and_do_not_raise(env, monkeypatch):
    (env / "live").mkdir(parents=True)
    (env / "live" / "virtual_account.json.latch").write_text("day -2%")     # latched account file deleted
    b = SimBroker()
    clk = Clock(at(8, 0))
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    assert journal(env)[-1]["event"] == "refuse_to_arm" and b.placed == []


def test_disk_floor_refuses_to_arm(env, monkeypatch):
    monkeypatch.setattr(runner_b, "MIN_FREE_GB", 1e9)            # more than any disk has
    b = SimBroker()
    clk = Clock(at(8, 0))
    runner_b.run(DAY, broker=b, rest=FakeREST(clk), now_fn=clk.now, sleep_fn=clk.sleep)
    last = journal(env)[-1]
    assert last["event"] == "refuse_to_arm" and "free disk" in last["reason"] and b.placed == []
