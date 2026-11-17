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
from wt.options.intraday import daily_raw
from wt.options.regime import NEW_YORK
from wt.options.setups import Mark
from wt.risk.options_guard import Limits

ROOT = Path(__file__).resolve().parents[2]
CFG = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
LIM = Limits.from_risk(yaml.safe_load((ROOT / "config" / "risk.yaml").read_text()))
DAY = dt.date(2026, 10, 19)
OPEN = dt.datetime.combine(DAY, dt.time(9, 30), NEW_YORK)
L, NEXT = 581.0, 584.0
SAME_DAY = {**CFG, "names": {**CFG["names"], "expiry": "same_day"}}        # the DEC-0032 rule (DEC-0034's other policy)


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
        self.feed_greeks = True
        self.exp = "261019"                       # the expiry of the contracts the chain lists (YYMMDD)
        self.chain_calls: list[dt.date] = []

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
        sym = f"SPY{self.exp}{side}{int(k * 1000):08d}"
        t = (self.now - dt.timedelta(seconds=self.quote_age_s)).astimezone(dt.UTC).isoformat().replace("+00:00", "Z")
        if not self.feed_greeks:          # what the broker's feed really sends for a same-day contract
            return sym, {"latestQuote": {"bp": round(ask - 0.02, 2), "ap": ask, "t": t}, "dailyBar": {"v": 20000}}
        return sym, {"latestQuote": {"bp": round(ask - 0.02, 2), "ap": ask, "t": t},
                     "greeks": {"delta": delta if side == "C" else -delta}, "impliedVolatility": 0.15,
                     "dailyBar": {"v": 20000}}

    def chain(self, root, expiry):
        self.chain_calls.append(expiry)
        return dict(self.snap(k, side) for k in range(576, 587) for side in ("C", "P"))

    def quotes(self, symbols):
        out = {}
        for sym in symbols:
            b = self.bid_fn(self.now)
            t = (self.now - dt.timedelta(seconds=self.quote_age_s)).astimezone(dt.UTC).isoformat().replace("+00:00", "Z")
            out[sym] = {"latestQuote": {"bp": b, "ap": round(b + 0.02, 2), "t": t}, "greeks": {"delta": 0.5},
                        "impliedVolatility": 0.15, "dailyBar": {"v": 20000}}
        return out

    def contracts(self, root, expiry, last=None):
        return {f"SPY{self.exp}{side}{k * 1000:08d}": self.oi for k in range(576, 587) for side in ("C", "P")}

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

    def make(cfg: dict[str, Any] = CFG, **kw: Any) -> Runner:
        r = Runner(DAY, cfg, LIM, m, b, lambda: m.now, lambda s: None, FakePager(), write=write,
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
    m.contracts = lambda root, expiry, last=None: {} if root == "QQQ" else {"SPY261019C00580000": 5000.0}
    r = world["make"](SAME_DAY)
    del r.prepare                                                   # the real preparation
    m.now = at("09:25")
    r.arm()
    assert set(r.names) == {"SPY"}
    (n,) = events(world["rows"], "names")
    assert n["source"] == "fallback" and n["dropped"] == {"QQQ": "no same-day expiry"}
    assert {"PDH", "PDL", "PWH", "PWL"} <= {mk.name for mk in r.names["SPY"].marks}
    assert all(math.isfinite(mk.price) for mk in r.names["SPY"].marks)


# ---------------------------------------------------------------- the dashboard document
class Posted:
    """A stand-in for clone_site.Publisher: keeps what the runner hands it."""

    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    def post(self, data: bytes) -> None:
        self.docs.append(json.loads(data))


def _keys(node: Any) -> set[str]:
    if isinstance(node, dict):
        return set(node) | {k for v in node.values() for k in _keys(v)}
    if isinstance(node, list):
        return {k for v in node for k in _keys(v)}
    return set()


def test_the_clone_publishes_at_arm_on_the_fill_and_on_the_exit_within_the_sites_schema(world):
    from wt.options import clone_site
    out = Posted()
    r = world["make"](publisher=out)
    r.names_source = "fallback"
    world["m"].now = at("09:25")
    assert r.arm()
    assert len(out.docs) == 1 and out.docs[0]["trades"] == [] and out.docs[0]["entries"] == {"used": 0, "max": LIM.max_entries_per_day}
    run_until(r, world["m"], world["b"], at("10:26", 10))
    world["m"].bid_fn = lambda t: 2.15
    run_until(r, world["m"], world["b"], at("10:27"))
    (p,) = r.today()
    assert p.state == "closed"
    for d in out.docs:
        assert clone_site.validate(d) == [], d
        assert "setup" not in _keys(d)                       # setup names are RESTRICTED; a trade carries its HYP id
    last = out.docs[-1]
    assert last["session"] == "2026-10-19" and last["names"] == ["SPY"] and last["names_source"] == "fallback"
    assert last["entries"]["used"] == 1 and last["day_pnl"] == {"usd": pytest.approx(74.94), "limit_usd": LIM.day_loss_latch}
    (t,) = last["trades"]
    assert t == {"trade_id": "2026-10-19-O-1", "hyp": "HYP-0029", "side": "call", "contract": "SPY261019C00581000",
                 "state": "closed", "fill": 1.4, "exit_fill": 2.15, "exit_reason": "target", "rop": t["rop"]}
    assert t["rop"] > 0.5 and last["broker_stop"] == "accepted" and last["slippage_median_pct"] == 0.0
    spy = next(g for g in last["gates"] if g["symbol"] == "SPY")
    assert spy["entered"] == 1 and spy["bars"] >= 1
    by = {s["hyp"]: s for s in last["setups"]}
    assert by["HYP-0029"]["trades"] == 1 and by["HYP-0030"]["trades"] == 0 and by["all"]["verdict"] == "none"
    assert any(d["trades"] and d["trades"][0]["state"] == "open" for d in out.docs)        # sent on the fill too
    assert not last["final"] and not last["flatten_required"] and last["latch"] is None


def test_a_latch_and_a_flatten_are_published_when_they_happen(world):
    out = Posted()
    r, p = entered(world)
    r.publisher = out
    world["m"].bid_fn = lambda t: 1.45
    r.critical("test")
    assert out.docs[-1]["flatten_required"] is True
    r.latches.trip("day", "2026-10-19", "test", at("10:27"))
    r.publish(final=True)
    assert out.docs[-1]["latch"] == "day" and out.docs[-1]["final"] is True


def test_a_document_that_cannot_be_sent_never_stops_the_runner_and_is_journaled_once(world, monkeypatch):
    from wt.options import clone_site

    class Broken:
        def post(self, data: bytes) -> None:
            raise OSError("disk")

    r = world["make"](publisher=Broken())
    world["m"].now = at("09:25")
    r.arm()
    run_until(r, world["m"], world["b"], at("10:26", 10))
    assert r.today()[0].state == "open"
    assert len(events(world["rows"], "clone_doc_unsent")) == 1
    monkeypatch.setattr(clone_site, "validate", lambda doc: ["trades/0/contract: pattern"])
    r.publisher = Posted()
    r.publish()
    assert r.publisher.docs == [] and events(world["rows"], "clone_doc_unsent")[-1]["error"].startswith("ValueError")


def test_focus_names_without_a_same_day_expiry_are_topped_up_with_spy_and_qqq(world):
    days, d = [], "2026-10-16"
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    rows = [{"t": f"{x}T04:00:00Z", "o": 570 + i * 0.1, "h": 571 + i * 0.1, "l": 569 + i * 0.1, "c": 570.5 + i * 0.1,
             "v": 1e6} for i, x in enumerate(days)]
    m = world["m"]
    names = ("AMZN", "TSLA", "META", "SPY", "QQQ")
    m.daily = lambda symbols, start, end: {s: rows for s in names}
    m.contracts = lambda root, expiry, last=None: {f"{root}261019C00580000": 5000.0} if root in ("SPY", "QQQ") else {}
    focus = {"items": [{"symbol": s, "rank": i + 1, "bias": "range"} for i, s in enumerate(("AMZN", "TSLA", "META", "SPY"))]}
    m.focus = lambda: (focus, "2026-10-19")
    r = world["make"](SAME_DAY)
    del r.prepare
    m.now = at("09:25")
    r.arm()
    assert sorted(r.names) == ["QQQ", "SPY"] and r.names_source == "focus+top-up"
    (n,) = events(world["rows"], "names")
    assert n["topped_up"] == ["QQQ"] and set(n["dropped"]) == {"AMZN", "TSLA", "META"}


def test_no_top_up_when_enough_focus_names_trade(world):
    days, d = [], "2026-10-16"
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    rows = [{"t": f"{x}T04:00:00Z", "o": 570 + i * 0.1, "h": 571 + i * 0.1, "l": 569 + i * 0.1, "c": 570.5 + i * 0.1,
             "v": 1e6} for i, x in enumerate(days)]
    m = world["m"]
    m.daily = lambda symbols, start, end: {s: rows for s in symbols}
    m.contracts = lambda root, expiry, last=None: {f"{root}261019C00580000": 5000.0}
    focus = {"items": [{"symbol": "AMZN", "rank": 1, "bias": "range"}, {"symbol": "META", "rank": 2, "bias": "range"}]}
    m.focus = lambda: (focus, "2026-10-19")
    r = world["make"]()
    del r.prepare
    m.now = at("09:25")
    r.arm()
    assert sorted(r.names) == ["AMZN", "META"] and r.names_source == "focus"


def _edition_rows():
    days, d = [], "2026-10-16"
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    return [{"t": f"{x}T04:00:00Z", "o": 570 + i * 0.1, "h": 571 + i * 0.1, "l": 569 + i * 0.1, "c": 570.5 + i * 0.1,
             "v": 1e6} for i, x in enumerate(days)]


def _arm_with_edition(world, edition):
    m = world["m"]
    rows = _edition_rows()
    m.daily = lambda symbols, start, end: {s: rows for s in symbols}
    m.contracts = lambda root, expiry, last=None: {f"{root}261019C00580000": 5000.0}
    m.edition = lambda: edition
    r = world["make"]()
    del r.prepare
    m.now = at("09:25")
    r.arm()
    return r, events(world["rows"], "names")[-1]


def test_the_clone_marks_the_editions_levels_and_journals_a_disagreement(world):
    own = lv.levels_for(lv.load_ibkr(daily_raw(_edition_rows())).bars, "2026-10-19")
    levels = [{"name": x.name, "price": x.price + (0.40 if x.name == "PDH" else 0.0), "tf": x.tf, "weight": x.weight}
              for x in own["levels"]]
    ed = {"session": "2026-10-19", "tickers": [{"symbol": "SPY", "levels": levels, "zones": []}]}
    r, n = _arm_with_edition(world, ed)
    assert n["level_source"] == {"SPY": "edition", "QQQ": "tape"}
    assert len(n["level_diffs"]["SPY"]) == 1 and n["level_diffs"]["SPY"][0].startswith("PDH")
    pdh = next(mk for mk in r.names["SPY"].marks if mk.name == "PDH")
    assert pdh.price == pytest.approx(next(x.price for x in own["levels"] if x.name == "PDH") + 0.40)


def test_an_edition_for_another_session_is_not_used(world):
    ed = {"session": "2026-10-16", "tickers": [{"symbol": "SPY", "levels": [{"name": "PDH", "price": 1.0}], "zones": []}]}
    r, n = _arm_with_edition(world, ed)
    assert set(n["level_source"].values()) == {"tape"} and "level_diffs" not in n or n["level_diffs"] == {}


def test_a_same_day_contract_with_no_greeks_from_the_feed_is_still_traded(world):
    """The broker's feed sends no delta or implied volatility for contracts expiring that day (seen 20 Oct 2026):
    the clone works them out from the quote's mid instead of refusing every contract."""
    world["m"].feed_greeks = False
    r = world["make"]()
    world["m"].now = at("09:25")
    assert r.arm()
    run_until(r, world["m"], world["b"], at("10:26", 10))
    (p,) = r.today()
    assert p.state == "open" and p.side == "call"
    last = [json.loads(x) for x in (world["tmp"] / "options/decisions/2026-10-19.jsonl").read_text().splitlines()][-1]
    gates = last["signals"][0]["gates"]
    assert gates["contract"]["ok"] and gates["reach"]["ok"]


def _daily_rows(last: str) -> list[dict[str, Any]]:
    days, d = [], last
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    return [{"t": f"{x}T04:00:00Z", "o": 570 + i * 0.1, "h": 571 + i * 0.1, "l": 569 + i * 0.1, "c": 570.5 + i * 0.1,
             "v": 1e6} for i, x in enumerate(days)]


def test_on_a_tuesday_the_focus_names_without_a_same_day_expiry_trade_their_friday_one(world):
    """DEC-0034, the 20 Oct case: AMZN, TSLA and META list no contract expiring Tuesday but do list Friday's; SPY lists
    Tuesday's. All four are traded, each on its nearest expiry; nothing is topped up and nothing is dropped."""
    tue = dt.date(2026, 10, 20)
    m = world["m"]
    rows = _daily_rows("2026-10-19")
    m.daily = lambda symbols, start, end: {s: rows for s in symbols}
    asked: list[tuple[str, dt.date, dt.date | None]] = []

    def contracts(root, expiry, last=None):
        asked.append((root, expiry, last))
        if root in ("SPY", "QQQ"):
            return {f"{root}261020C00580000": 5000.0} if last is None else {f"{root}261021C00580000": 5000.0}
        if last is None:
            return {}
        return {f"{root}261023C00220000": 4000.0, f"{root}261023P00220000": 3000.0,      # Friday: the nearest
                f"{root}261030C00220000": 9000.0}                                      # a later Friday
    m.contracts = contracts
    focus = {"items": [{"symbol": s, "rank": i + 1, "bias": "range"} for i, s in enumerate(("AMZN", "TSLA", "META", "SPY"))]}
    m.focus = lambda: (focus, "2026-10-20")
    m.now = dt.datetime.combine(tue, dt.time(9, 25), NEW_YORK)
    r = Runner(tue, CFG, LIM, m, world["b"], lambda: m.now, lambda s: None, type("P", (), {"fire": lambda *a: None})(),
               write=lambda event, **kw: world["rows"].append({"event": event, **kw}) or True,
               state=world["tmp"] / "options", kills=(world["tmp"] / "KILL",))
    r.prepare()
    assert sorted(r.names) == ["AMZN", "META", "SPY", "TSLA"] and r.names_source == "focus"
    fri = dt.date(2026, 10, 23)
    assert {k: n.expiry for k, n in r.names.items()} == {"AMZN": fri, "TSLA": fri, "META": fri, "SPY": tue}
    assert r.names["AMZN"].oi == {"AMZN261023C00220000": 4000.0, "AMZN261023P00220000": 3000.0}
    assert r.names["SPY"].oi == {"SPY261020C00580000": 5000.0}             # the same-day name keeps today's expiry
    assert ("SPY", tue, None) in asked and not any(a[0] == "SPY" and a[2] for a in asked)
    assert ("AMZN", dt.date(2026, 10, 21), dt.date(2026, 10, 27)) in asked     # tomorrow to seven days out
    (n,) = events(world["rows"], "names")
    assert n["policy"] == "nearest" and n["dropped"] == {} and n["topped_up"] == []
    assert n["expiries"] == {"AMZN": "2026-10-23", "TSLA": "2026-10-23", "META": "2026-10-23", "SPY": "2026-10-20"}


def test_a_name_with_no_expiry_inside_the_window_is_still_dropped_and_topped_up(world):
    m = world["m"]
    rows = _daily_rows("2026-10-16")
    m.daily = lambda symbols, start, end: {s: rows for s in symbols}
    m.contracts = lambda root, expiry, last=None: {f"{root}261019C00580000": 5000.0} if root in ("SPY", "QQQ") else {}
    focus = {"items": [{"symbol": "AMZN", "rank": 1}, {"symbol": "SPY", "rank": 2}]}
    m.focus = lambda: (focus, "2026-10-19")
    r = world["make"]()
    del r.prepare
    m.now = at("09:25")
    r.arm()
    assert sorted(r.names) == ["QQQ", "SPY"] and r.names_source == "focus+top-up"
    (n,) = events(world["rows"], "names")
    assert n["dropped"] == {"AMZN": "no expiry within 7 days"} and n["expiries"] == {"SPY": "2026-10-19", "QQQ": "2026-10-19"}


def test_an_unknown_expiry_policy_is_refused(world):
    with pytest.raises(ValueError, match="names.expiry"):
        world["make"]({**CFG, "names": {**CFG["names"], "expiry": "weekly"}})


def test_a_name_on_its_friday_expiry_buys_that_expiry_and_is_still_flat_by_15_10(world):
    """The whole trade on a contract with days left: the chain is read for the name's expiry, only that expiry's
    contracts can be bought, and every exit is the same-day one."""
    m = world["m"]
    m.exp = "261023"
    fri = dt.date(2026, 10, 23)
    r = world["make"]()
    r.prepare = lambda: r.names.update(SPY=Name("SPY", [Mark("PDL", 576.0), Mark("PDH", L), Mark("PWH", NEXT)],
                                                 m.contracts("SPY", fri), fri))
    m.now = at("09:25")
    assert r.arm()
    run_until(r, m, world["b"], at("10:26", 10))
    (p,) = r.today()
    assert p.state == "open" and p.symbol == "SPY261023C00581000" and set(m.chain_calls) == {fri}
    last = [json.loads(x) for x in (world["tmp"] / "options/decisions/2026-10-19.jsonl").read_text().splitlines()][-1]
    assert last["signals"][0]["gates"]["contract"]["ok"]
    m.bid_fn = lambda t: 1.45
    run_until(r, m, world["b"], at("15:10", 10))
    assert p.state == "closed" and p.exit_reason == "flatten"
    (row,) = events(world["rows"], "trade_closed")
    from wt.options import review
    assert review.trial_of(row["setup"], row["symbol"], "2026-10-19") == "nearest"


def test_broker_unreachable_at_arm_writes_its_detail_to_the_log_before_the_page(world, capsys):
    """The page says the clone's log has the detail (the topic is public); the log must have it when the page goes."""
    from wt.brokers.base import TransportError
    r = world["make"]()
    world["m"].now = at("09:25")
    seen: list[tuple[str, str, str]] = []

    def reconcile(plans):
        raise TransportError("paper-api answered 503 for https://paper-api.example/v2/positions SPY 123.45")

    def fire(key, title, msg, prio=4):
        seen.append((key, msg, capsys.readouterr().err))       # what the log holds at the moment of the page
    r.oms.reconcile = reconcile
    r.pager.fire = fire
    assert r.arm() is False
    assert not seen                                                 # tried again until 09:58 before any page
    run_until(r, world["m"], world["b"], at("09:58", 30))
    (key, msg, log_then), = [s for s in seen if s[0] == "options-clone:arm-broker"]
    assert "broker unreachable at arm: TransportError: paper-api answered 503" in log_then
    assert "TransportError" in msg and "503" not in msg and "SPY" not in msg and "https" not in msg


def test_a_broken_stderr_at_arm_still_sends_the_page(world, monkeypatch):
    """EPIPE or a closed stderr must not skip the page or end the run before the exit-managing loop."""
    import sys

    from wt.brokers.base import TransportError

    class Broken:
        def write(self, *a):
            raise BrokenPipeError(32, "EPIPE")

        def flush(self):
            raise ValueError("closed")
    r = world["make"]()
    world["m"].now = at("09:25")
    sent = []
    r.oms.reconcile = lambda plans: (_ for _ in ()).throw(TransportError("down"))
    r.pager.fire = lambda key, title, msg, prio=4: sent.append(key)
    monkeypatch.setattr(sys, "stderr", Broken())
    assert r.arm() is False
    run_until(r, world["m"], world["b"], at("09:58", 30))
    assert "options-clone:arm-broker" in sent


# ---------------------------------------------------------------- a market-data request refused for naming no feed
class _Answers503:
    """The broker's data host answering 503 to everything: the clone's ordinary data error."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def get(self, url: str, params: Any = None, **_: Any) -> Any:
        self.calls.append(url)
        return type("R", (), {"status_code": 503, "json": lambda self: {}})()


def _real_feeds(monkeypatch: pytest.MonkeyPatch, how: str) -> tuple[runner_o.AlpacaFeeds, _Answers503]:
    """The clone's own AlpacaFeeds over a fake session: `refused`, every request is refused by the feed guard (a
    future bug in it); `unreachable`, every request goes out and is answered 503."""
    if how == "refused":
        def refuse(url: object, params: object) -> None:
            raise runner_o.FeedNotNamed("no feed")
        monkeypatch.setattr(runner_o, "require_feed", refuse)
    s = _Answers503()
    f = runner_o.AlpacaFeeds("k", "s", "indicative", s)            # type: ignore[arg-type]
    f.focus = lambda: (None, None)                                 # type: ignore[method-assign]
    f.edition = lambda: None                                       # type: ignore[method-assign]
    return f, s


@pytest.mark.parametrize("how", ["refused", "unreachable"])
def test_a_refused_request_at_arm_turns_entries_off_exactly_as_an_unreachable_feed(world, monkeypatch, capsys, how):
    """The guard raises TransportError("feed-not-named") in AlpacaFeeds._get, the error every caller already handles
    as a failed data read: here prepare's, so the levels are off, tried again until 09:58 (EXP-0029), then paged
    and off for the day, with the same page and journal."""
    r = world["make"]()
    del r.prepare                                                  # the real one, reading the bars from the feed
    r.feeds, s = _real_feeds(monkeypatch, how)
    world["m"].now = at("09:25")
    assert r.arm() is False
    assert r.off == {"levels": "levels unavailable"} and r.names == {}
    assert world["pages"] == [] and [x["event"] for x in world["rows"]] == ["armed"]
    assert world["rows"][0]["off"] == ["levels"]
    run_until(r, world["m"], world["b"], at("10:40"))              # through the signal at 10:26: no entry
    assert r.today() == [] and not any(o.side == "buy" for o in world["b"].orders.values())
    assert world["pages"] == ["options-clone:levels"]
    assert [x["event"] for x in world["rows"]] == ["armed", "arm_retry", "page"]
    gave = world["rows"][1]
    assert gave["gave_up"] and gave["still"] == ["levels"] and gave["tries"] >= 30
    assert world["rows"][2] == {"event": "page", "key": "levels", "title": "Options clone: no levels today"}
    err = capsys.readouterr().err
    assert (s.calls == [] and "a market-data request named no feed" in err) if how == "refused" \
        else (s.calls and "named no feed" not in err)


@pytest.mark.parametrize("how", ["refused", "unreachable"])
def test_a_refused_request_with_a_trade_open_still_manages_the_exit_exactly_as_an_unreachable_feed(world, monkeypatch,
                                                                                                    capsys, how):
    """Mid-trade, the tape and the quote are refused: the tape reads as stalled and the bid falls back to the broker's
    mark, so the exit rules still run and the trade is closed, with no journal line the unreachable feed lacks."""
    r, p = entered(world)
    before = len(world["rows"])
    r.feeds, s = _real_feeds(monkeypatch, how)
    world["m"].bid_fn = lambda t: 1.45
    run_until(r, world["m"], world["b"], at("10:40"))
    assert p.state == "closed" and p.exit_reason == "stock-feed-stalled"
    assert world["b"].pos[p.symbol].qty == 0
    assert len([o for o in world["b"].orders.values() if o.side == "buy"]) == 1      # no entry after it
    after = [x["event"] for x in world["rows"][before:]]
    assert after == ["trade_closed"]                                # no manage_fault, no new line
    assert world["pages"][-1] == f"options-clone:exit-{p.trade_id}"
    err = capsys.readouterr().err
    assert (s.calls == [] and "a market-data request named no feed" in err) if how == "refused" \
        else (s.calls and "named no feed" not in err)
