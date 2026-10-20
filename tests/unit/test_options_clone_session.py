"""The options clone's runner through whole sessions on a fake clock, a scripted market and a simulated paper broker
(DEC-0030; plan Parts 0.C, 2 and 3). Nothing here reaches a network."""
from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
from typing import Any

import pytest
import yaml

from wt.brokers.sim import SimBroker
from wt.core.types import Order, Position
from wt.live import runner_o
from wt.live.runner_o import Name, Runner
from wt.options import levels as lv
from wt.options.regime import NEW_YORK
from wt.options.setups import Mark
from wt.risk.options_guard import Limits

ROOT = Path(__file__).resolve().parents[2]
CFG = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
LIM = Limits.from_risk(yaml.safe_load((ROOT / "config" / "risk.yaml").read_text()))
DAY = dt.date(2026, 10, 19)
OPEN = dt.datetime.combine(DAY, dt.time(9, 30), NEW_YORK)
L, NEXT = 581.0, 584.0


def at(hhmm: str, s: int = 0) -> dt.datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return dt.datetime.combine(DAY, dt.time(h, m, s), NEW_YORK)


# ---------------------------------------------------------------- the scripted market
def closes() -> list[float]:
    """2-minute closes: a steady rise under 581, the break, the retest, the close away (the signal at 10:26)."""
    rise = [579.0 + 1.9 * i / 24 for i in range(25)]              # 09:30 .. 10:20
    return rise + [581.25, 581.15, 581.4]                           # 10:22 break, 10:24 touch, 10:26 away


class Market:
    def __init__(self) -> None:
        self.now = at("09:20")
        self.path = closes()
        self.after: float | None = None           # where the stock goes after the script (a flat line by default)
        self.bid_fn = lambda t: 1.40              # the held contract's bid
        self.quote_age_s = 2.0
        self.oi = 5000.0

    def stock(self, i: int) -> float:
        if i < len(self.path):
            return self.path[i]
        return self.after if self.after is not None else self.path[-1]

    def minutes(self, symbols, start, end) -> dict[str, list[dict[str, Any]]]:
        rows = []
        t = OPEN
        k = 0
        prev = self.path[0]
        while t + dt.timedelta(minutes=1) <= end:
            i = k // 2
            c = self.stock(i)
            mid = (prev + c) / 2
            o, cl = (prev, mid) if k % 2 == 0 else (mid, c)
            lo = min(o, cl) - 0.2
            if i == 26:
                lo = min(lo, 580.95)                                   # the retest touches the level
            rows.append({"t": t.astimezone(dt.UTC).isoformat().replace("+00:00", "Z"), "o": o, "h": max(o, cl) + 0.2,
                         "l": lo, "c": cl, "v": 1000})
            if k % 2 == 1:
                prev = c
            k += 1
            t += dt.timedelta(minutes=1)
        return {s: rows for s in symbols}

    def daily(self, symbols, start, end):
        return {}

    def spot(self) -> float:
        i = int((self.now - OPEN).total_seconds() // 120)
        return self.stock(max(i - 1, 0))

    def snap(self, k: float, side: str) -> tuple[str, dict[str, Any]]:
        s = self.spot()
        m = (s - k) if side == "C" else (k - s)
        delta = max(0.05, min(0.95, 0.5 + 0.15 * m))
        ask = round(max(0.05, 1.20 + 0.5 * m), 2)
        sym = f"SPY261019{side}{int(k * 1000):08d}"
        t = (self.now - dt.timedelta(seconds=self.quote_age_s)).astimezone(dt.UTC).isoformat().replace("+00:00", "Z")
        return sym, {"latestQuote": {"bp": round(ask - 0.02, 2), "ap": ask, "t": t},
                     "greeks": {"delta": delta if side == "C" else -delta}, "impliedVolatility": 0.15,
                     "dailyBar": {"v": 20000}}

    def chain(self, root, expiry):
        return dict(self.snap(k, side) for k in range(576, 587) for side in ("C", "P"))

    def quotes(self, symbols):
        out = {}
        for sym in symbols:
            b = self.bid_fn(self.now)
            t = (self.now - dt.timedelta(seconds=self.quote_age_s)).astimezone(dt.UTC).isoformat().replace("+00:00", "Z")
            out[sym] = {"latestQuote": {"bp": b, "ap": round(b + 0.02, 2), "t": t}, "greeks": {"delta": 0.5},
                        "impliedVolatility": 0.15, "dailyBar": {"v": 20000}}
        return out

    def contracts(self, root, expiry):
        return {f"SPY261019{side}{k * 1000:08d}": self.oi for k in range(576, 587) for side in ("C", "P")}

    def focus(self):
        return None, None


class Paper(SimBroker):
    """Fills like the paper engine: a marketable limit buy at once at the ask, a market sell at the bid, a resting
    sell when the bid reaches it. A stop rests until the bid falls to it."""

    def __init__(self, market: Market) -> None:
        super().__init__()
        self.m = market
        self.own_account = True

    def options_level(self) -> int:
        return 2

    def marks(self) -> dict[str, float]:
        return {s: self.m.bid_fn(self.m.now) for s, p in self.pos.items() if p.qty}

    def place(self, order: Order) -> Order:
        got = super().place(order)
        if order.side == "buy" and order.type == "limit":
            ask = self.m.snap(int(order.symbol[-8:]) / 1000, order.symbol[-9])[1]["latestQuote"]["ap"]
            if order.limit_price is not None and order.limit_price >= ask:
                self.fill(order.client_order_id, ask)
        elif order.side == "sell" and order.type == "market":
            self.fill(order.client_order_id, self.m.bid_fn(self.m.now))
        return self.orders[got.client_order_id]

    def tick(self) -> None:
        b = self.m.bid_fn(self.m.now)
        for o in list(self.orders.values()):
            if o.status.terminal or o.side != "sell":
                continue
            if (o.type == "limit" and b >= (o.limit_price or 1e9)) or (o.type == "stop" and b <= (o.stop_price or -1)):
                self.fill(o.client_order_id, b)


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    monkeypatch.setattr(runner_o, "JOURNAL", tmp_path / "journal.jsonl")
    monkeypatch.setattr(runner_o.hc, "ping_async", lambda *a, **k: None)
    m = Market()
    b = Paper(m)
    rows: list[dict[str, Any]] = []
    pages: list[str] = []

    class FakePager:
        def fire(self, key, title, msg, prio=4):
            pages.append(key)

        def once_per_day(self, key, title, msg, prio=3):
            pages.append(key)

    def write(event: str, **kw: Any) -> bool:
        rows.append({"event": event, **kw})
        return True

    def make(**kw: Any) -> Runner:
        r = Runner(DAY, CFG, LIM, m, b, lambda: m.now, lambda s: None, FakePager(), write=write,
                   state=tmp_path / "options", kills=(tmp_path / "KILL",), **kw)
        r.prepare = lambda: r.names.update(SPY=Name("SPY", [Mark("PDL", 576.0), Mark("PDH", L), Mark("PWH", NEXT)],
                                                     m.contracts("SPY", DAY)))
        return r

    return {"m": m, "b": b, "rows": rows, "pages": pages, "make": make, "tmp": tmp_path}


def run_until(r: Runner, m: Market, b: Paper, end: dt.datetime, step_s: int = 10) -> None:
    while m.now < end:
        m.now += dt.timedelta(seconds=step_s)
        b.tick()
        r.step()


def events(rows: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    return [r for r in rows if r["event"] == name]


def entered(w: dict[str, Any]) -> tuple[Runner, Any]:
    r = w["make"]()
    w["m"].now = at("09:25")
    assert r.arm()
    run_until(r, w["m"], w["b"], at("10:26", 10))
    (p,) = r.today()
    assert p.state == "open" and p.setup == "retest" and p.side == "call" and p.symbol == "SPY261019C00581000"
    return r, p


# ---------------------------------------------------------------- the trade
def test_the_retest_is_entered_on_the_bar_that_completes_it_and_nowhere_else(world):
    r, p = entered(world)
    b = world["b"]
    assert p.fill == pytest.approx(1.40) and p.limit == pytest.approx(1.43) and p.quoted_ask == pytest.approx(1.40)
    assert p.signal_bar == "10:26" and p.invalidation < L < p.next_level == NEXT
    assert p.broker_stop == "accepted" and p.protect_kind == "stop"
    buys = [o for o in b.orders.values() if o.side == "buy"]
    assert len(buys) == 1 and buys[0].qty == 1
    decisions = [json.loads(x) for x in (world["tmp"] / "options/decisions/2026-10-19.jsonl").read_text().splitlines()]
    assert decisions[-1]["action"] == "entered" and decisions[-1]["bar"] == "10:26"
    assert all(d["action"] != "entered" for d in decisions[:-1])
    assert all(d["signals"][0]["gates"][g]["ok"] for d in decisions[-1:] for g in decisions[-1]["signals"][0]["gates"])


def test_the_software_target_takes_profit_and_the_trade_is_booked_once(world):
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 2.15
    run_until(r, world["m"], world["b"], at("10:27"))
    assert p.state == "closed" and p.exit_reason == "target" and p.exit_fill == 2.15
    assert world["b"].pos[p.symbol].qty == 0
    closed = events(world["rows"], "trade_closed")
    assert len(closed) == 1 and closed[0]["pnl"] == pytest.approx(74.94) and closed[0]["counts"]


def test_the_premium_stop_at_minus_25_percent(world):
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 1.04
    run_until(r, world["m"], world["b"], at("10:27"))
    assert p.state == "closed" and p.exit_reason in ("premium", "broker-stop") and p.exit_fill == 1.04
    assert world["b"].pos[p.symbol].qty == 0


def test_the_time_stop_five_minutes_in(world):
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 1.39
    run_until(r, world["m"], world["b"], at("10:30", 50))        # the fill was at 10:26:00
    assert p.state == "open"
    run_until(r, world["m"], world["b"], at("10:31", 0))
    assert p.state == "closed" and p.exit_reason == "time"


def test_a_close_through_the_invalidation_ends_the_trade(world):
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 1.30
    world["m"].after = 580.0
    run_until(r, world["m"], world["b"], at("10:29"))
    assert p.state == "closed" and p.exit_reason == "chart"


def test_breakeven_after_plus_25_percent(world):
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 1.80
    run_until(r, world["m"], world["b"], at("10:27"))
    assert p.breakeven and p.state == "open"
    world["m"].bid_fn = lambda t: 1.40
    run_until(r, world["m"], world["b"], at("10:27", 30))
    assert p.state == "closed" and p.exit_reason == "breakeven"


def test_flat_by_15_10(world):
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 1.45
    run_until(r, world["m"], world["b"], at("15:09", 10), step_s=60)
    assert p.state == "open" and world["m"].now < at("15:10")
    run_until(r, world["m"], world["b"], at("15:10", 10))
    assert p.state == "closed" and p.exit_reason == "flatten"
    run_until(r, world["m"], world["b"], at("15:20", 10), step_s=60)
    (v,) = events(world["rows"], "verify_flat")
    assert v["flat"] and r.done()


def test_blind_exit_when_neither_quote_nor_mark_moves(world):
    r, p = entered(world)
    world["m"].quote_age_s = 300
    world["m"].bid_fn = lambda t: 1.41
    run_until(r, world["m"], world["b"], at("10:29", 30))
    assert p.state == "closed" and p.exit_reason == "blind"


# ---------------------------------------------------------------- what keeps an entry out
def test_no_entry_while_kill_is_on(world):
    (world["tmp"] / "KILL").write_text("x")
    r = world["make"]()
    world["m"].now = at("09:25")
    r.arm()
    run_until(r, world["m"], world["b"], at("10:27"))
    assert r.today() == [] and world["b"].placed == []
    last = json.loads((world["tmp"] / "options/decisions/2026-10-19.jsonl").read_text().splitlines()[-1])
    assert last["action"] == "signal-refused" and last["signals"][0]["gates"]["kill"]["ok"] is False


def test_no_entry_under_a_latch(world):
    r = world["make"]()
    r.latches.trip("day", "2026-10-19", "test", at("09:00"))
    world["m"].now = at("09:25")
    r.arm()
    run_until(r, world["m"], world["b"], at("10:27"))
    assert r.today() == [] and world["b"].placed == []


def test_no_entry_without_enough_open_interest(world):
    world["m"].oi = 10
    r = world["make"]()
    world["m"].now = at("09:25")
    r.arm()
    run_until(r, world["m"], world["b"], at("10:27"))
    assert r.today() == [] and world["b"].placed == []


def test_orders_off_arms_and_sends_nothing(world):
    r = world["make"]()
    r.cfg = {**CFG, "orders": "off"}
    world["m"].now = at("09:25")
    assert r.arm() is False
    run_until(r, world["m"], world["b"], at("10:27"))
    assert world["b"].placed == []


# ---------------------------------------------------------------- restart, hand trades, the account
def test_a_restart_mid_trade_resumes_and_never_enters_again(world):
    r, p = entered(world)
    again = world["make"]()
    again.arm()
    (q,) = again.today()
    assert q.trade_id == p.trade_id and q.state == "open"
    run_until(again, world["m"], world["b"], at("10:27"))
    assert len([o for o in world["b"].orders.values() if o.side == "buy"]) == 1


def test_a_restart_on_the_signal_bar_after_the_trade_closed_does_not_reenter(world):
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 2.15
    run_until(r, world["m"], world["b"], at("10:26", 40))
    assert p.state == "closed"
    again = world["make"]()
    again.arm()
    world["m"].bid_fn = lambda t: 1.40
    again.step()
    assert len([o for o in world["b"].orders.values() if o.side == "buy"]) == 1


def test_a_hand_position_in_a_shared_account_is_never_touched(world):
    world["b"].own_account = False
    hand = "SPY261019P00575000"
    world["b"].pos[hand] = Position(hand, 2, 0.5)
    r, p = entered(world)
    world["m"].bid_fn = lambda t: 2.15
    run_until(r, world["m"], world["b"], at("15:20", 10), step_s=60)
    assert p.state == "closed" and world["b"].pos[hand].qty == 2
    assert not [o for o in world["b"].orders.values() if o.symbol == hand]


def test_a_position_no_plan_knows_in_the_clones_own_account_turns_entries_off(world):
    stray = "SPY261019C00579000"
    world["b"].pos[stray] = Position(stray, 1, 1.0)
    r = world["make"]()
    world["m"].now = at("09:25")
    assert r.arm() is False and "options-clone:flatten-required" in world["pages"]
    run_until(r, world["m"], world["b"], at("10:27"))
    assert world["b"].placed == []


# ---------------------------------------------------------------- arm, from daily bars
def test_arm_marks_levels_from_daily_bars_and_drops_a_name_without_a_same_day_expiry(world):
    days, d = [], "2026-10-16"
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    rows = [{"t": f"{x}T04:00:00Z", "o": 570 + i * 0.1, "h": 571 + i * 0.1, "l": 569 + i * 0.1, "c": 570.5 + i * 0.1,
             "v": 1e6} for i, x in enumerate(days)]
    m = world["m"]
    m.daily = lambda symbols, start, end: {"SPY": rows, "QQQ": rows}
    m.contracts = lambda root, expiry: {} if root == "QQQ" else {"SPY261019C00580000": 5000.0}
    r = world["make"]()
    del r.prepare                                                   # the real preparation
    m.now = at("09:25")
    r.arm()
    assert set(r.names) == {"SPY"}
    (n,) = events(world["rows"], "names")
    assert n["source"] == "fallback" and n["dropped"] == {"QQQ": "no same-day expiry"}
    assert {"PDH", "PDL", "PWH", "PWL"} <= {mk.name for mk in r.names["SPY"].marks}
    assert all(math.isfinite(mk.price) for mk in r.names["SPY"].marks)
