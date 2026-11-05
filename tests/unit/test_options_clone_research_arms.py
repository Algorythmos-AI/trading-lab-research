"""The options clone's research arms (DEC-0041, HYP-0034 to HYP-0047) on synthetic bars and a scripted session:
the new level codes, the two new triggers, the five tags, the shadow exits, the shadow's lack of any order path, and
the control deciding byte for byte the same with the arms on and off. No backtest or replay: fixtures only."""
from __future__ import annotations

import ast
import datetime as dt
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import test_options_clone_session as ts
import yaml
from test_options_clone_strategy import bar, series

from wt.live import runner_o
from wt.live.runner_o import Name, Runner
from wt.options import levels as lv
from wt.options import arms_verdict as av
from wt.options import session, setups, shadow
from wt.options.regime import NEW_YORK, Bar, Tape
from wt.options.setups import Mark, Signal

ROOT = Path(__file__).resolve().parents[2]
CFG = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
ON = {**CFG, "research_arms": {**CFG["research_arms"], "enabled": True}}
TAGS = {**CFG["research_arms"]["tags"], "index_names": CFG["contract"]["index_names"]}
DAY = dt.date(2026, 10, 19)


def at(hhmm: str, s: int = 0) -> dt.datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return dt.datetime.combine(DAY, dt.time(h, m, s), NEW_YORK)


def daily(n: int = 40, start: str = "2026-08-20") -> list[lv.Bar]:
    out, d = [], start
    for i in range(n):
        while not lv.is_session(d):
            d = (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()
        out.append(lv.Bar(d, 100 + i, 101 + i + (5 if i == 10 else 0), 99 + i, 100.5 + i))
        d = (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()
    return out


# ---------------------------------------------------------------- the level codes (tagging only)
def test_swing_event_and_all_time_high_codes_use_only_bars_before_the_session():
    bars = daily()
    sess = lv.next_session(bars[-1].d)
    assert lv.swing_range(bars, sess) == (max(b.h for b in bars[-5:]), min(b.l for b in bars[-5:]))
    assert lv.swing_range(bars[:3], sess) is None
    ev_day = bars[20].d
    assert lv.event_candle(bars, sess, [ev_day, bars[5].d, sess]) == (bars[20].h, bars[20].l, ev_day)
    assert lv.event_candle(bars, sess, ["2001-01-02"]) is None
    assert lv.highest_high(bars, sess) == max(b.h for b in bars)
    assert lv.highest_high(bars, bars[0].d) is None


def test_gap_codes_are_the_gaps_two_edges_and_nothing_inside_the_prior_range():
    assert lv.gap_levels(105.0, 103.0, 99.0) == {"GAPH": 105.0, "GAPL": 103.0}     # gap up: PDH fills it
    assert lv.gap_levels(97.0, 103.0, 99.0) == {"GAPH": 99.0, "GAPL": 97.0}       # gap down: PDL fills it
    assert lv.gap_levels(101.0, 103.0, 99.0) == {}


def test_the_overnight_range_runs_from_yesterdays_close_to_todays_open():
    prev = dt.date(2026, 10, 16)

    def row(d: dt.date, hhmm: str, h: float, low: float) -> dict[str, Any]:
        t = dt.datetime.combine(d, dt.time(*(int(x) for x in hhmm.split(":"))), NEW_YORK).astimezone(dt.UTC)
        return {"t": t.isoformat().replace("+00:00", "Z"), "h": h, "l": low}
    rows = [row(prev, "15:59", 200, 1), row(prev, "17:00", 110, 105), row(DAY, "04:30", 112, 104),
            row(DAY, "09:29", 108, 107), row(DAY, "09:30", 300, 2), {"t": "bad"}]
    assert session.overnight_range(rows, DAY, prev) == (112, 104)
    assert session.overnight_range([], DAY, prev) is None


def test_the_research_codes_are_never_marks_and_pmh_stays_last_months():
    bars = daily()
    sess = lv.next_session(bars[-1].d)
    got = session.research_levels(bars, sess, [bars[20].d], (150.0, 140.0))
    assert set(got) == {"ONH", "ONL", "SWH", "SWL", "EVH", "EVL", "ATH"} <= set(lv.RESEARCH_CODES)
    assert (got["ONH"], got["ONL"], got["EVH"]) == (150.0, 140.0, bars[20].h)
    marks = session.marks(lv.levels_for(bars, sess), CFG["levels"]["names"], CFG["levels"]["strong"], (1.0, 0.5))
    assert not {m.name for m in marks} & set(lv.RESEARCH_CODES)
    assert {"PMH", "PML", "PMKH", "PMKL"} <= {m.name for m in marks}           # month and pre-market, both kept
    assert next(m for m in marks if m.name == "PMKH").price == 1.0


# ---------------------------------------------------------------- the triggers
L = 100.0
STRONG, WEAK = [Mark("PWH", L, True)], [Mark("PDH", L, False)]


def test_trap_takes_a_failed_break_back_inside_within_three_bars():
    bars = series([99.5, 99.8, 100.3, 100.2, 99.7])
    (s,) = setups.trap(bars, STRONG, CFG["research_arms"]["shadow"]["trap"])
    assert (s.setup, s.side, s.entry, s.bar_end) == ("trap", "put", 99.7, "09:40")
    assert s.invalidation == pytest.approx(max(b.h for b in bars[2:]))
    (c,) = setups.trap(series([100.5, 100.2, 99.7, 99.8, 100.3]), STRONG, {"fail_within_bars": 3})
    assert c.side == "call" and c.invalidation == pytest.approx(99.65)


def test_trap_refuses_a_slow_fail_a_weak_level_and_a_close_that_already_came_back():
    cfg = {"fail_within_bars": 3}
    assert setups.trap(series([99.5, 99.8, 100.3, 100.2, 100.4, 100.1, 99.7]), STRONG, cfg) == []    # 4 bars
    assert setups.trap(series([99.5, 99.8, 100.3, 100.2, 99.7]), WEAK, cfg) == []
    assert setups.trap(series([99.5, 99.8, 100.3, 99.9, 99.7]), STRONG, cfg) == []    # the last is not the first


def test_the_fast_reclaim_enters_on_the_sweep_bar_itself():
    pre = bar(0, 100.1, 100.3, 100.0, 100.2)
    sweep = bar(1, 100.2, 100.3, 99.7, 100.1)                     # 0.30 below L, closes back above
    (s,) = setups.reclaim_fast([pre, sweep], STRONG, 1.0, CFG["research_arms"]["shadow"]["reclaim_fast"])
    assert (s.setup, s.side, s.entry, s.invalidation, s.bar_end) == ("reclaim_fast", "call", 100.1, 99.7, "09:34")
    put = setups.reclaim_fast([bar(0, 99.8, 99.9, 99.7, 99.8), bar(1, 99.8, 100.3, 99.7, 99.9)], STRONG, 1.0,
                              {"sweep_min_atr": 0.25})
    assert [(x.side, x.invalidation) for x in put] == [("put", 100.3)]


def test_the_fast_reclaim_needs_a_quarter_atr_sweep_a_close_back_and_a_strong_level():
    pre, cfg = bar(0, 100.1, 100.3, 100.0, 100.2), {"sweep_min_atr": 0.25}
    assert setups.reclaim_fast([pre, bar(1, 100.2, 100.3, 99.8, 100.1)], STRONG, 1.0, cfg) == []   # 0.20 ATR
    assert setups.reclaim_fast([pre, bar(1, 100.2, 100.3, 99.6, 99.9)], STRONG, 1.0, cfg) == []    # no reclaim
    assert setups.reclaim_fast([pre, bar(1, 100.2, 100.3, 99.7, 100.1)], WEAK, 1.0, cfg) == []
    assert setups.reclaim_fast([pre, bar(1, 100.2, 100.3, 99.7, 100.1)], STRONG, 0.0, cfg) == []


# ---------------------------------------------------------------- the tags
MARKS = [Mark("PDL", 90.0), Mark("PDH", 99.0), Mark("PWH", 104.0, True)]


def sig(side: str = "call", entry: float = 95.0, end: str = "10:26") -> Signal:
    return Signal("retest", side, MARKS[1], entry, 94.0, end)


def tag(s: Signal, bars: list[Bar], **kw: Any) -> dict[str, Any]:
    args: dict[str, Any] = {"root": "SPY", "word": "range", "five": None, "leader": None, "leader_names": ["QQQ"],
                            "iv": 0.2, "iv_modelled": False, "half_day": False, "cfg": TAGS} | kw
    return setups.tag_decision(s, bars, MARKS, **args)


def test_ntz_is_the_middle_third_of_either_range_with_no_mark_broken():
    flat = series([95.0, 95.2, 94.9, 95.1])                              # opens at 95, inside 93..96
    t = tag(sig(entry=95.0), flat)
    assert t["ntz"] and t["ntz_prior_mid"] and t["broken"] == [] and t["word"] == "range"
    assert tag(sig(entry=93.0), flat)["ntz_prior_mid"]                    # the end, 90 + 9/3, is included
    t = tag(sig(entry=92.9), flat)
    assert t["ntz"] is None and t["ntz_prior_mid"] is False and t["ntz_five_mid"] is None   # unknown, not False
    assert tag(sig(entry=92.9), flat, five=(100.0, 99.0))["ntz"] is False                 # both known, neither
    assert tag(sig(entry=92.9), flat, five=(96.0, 89.0))["ntz"]           # the five sessions' third: 91.33..93.67
    broke = series([95.0, 98.0, 99.4, 99.2])                              # a close above PDH (opened below it)
    t = tag(sig(entry=95.0), broke)
    assert t["broken"] == ["PDH"] and not t["ntz"]


def test_gap_against_is_a_call_into_an_unfilled_gap_up_or_a_put_into_an_unfilled_gap_down():
    up = series([101.0, 101.5, 102.0], spread=0.05)                       # open 101 > PDH 99, lows above 99
    assert tag(sig("call"), up) | {} and tag(sig("call"), up)["gap_against"] and tag(sig("call"), up)["gap"] == "up"
    assert not tag(sig("put"), up)["gap_against"]
    filled = [*up, bar(3, 101.0, 101.1, 98.9, 100.0)]
    assert tag(sig("call"), filled)["gap_filled"] and not tag(sig("call"), filled)["gap_against"]
    down = series([89.0, 88.5, 88.0])
    assert tag(sig("put"), down)["gap_against"] and not tag(sig("call"), down)["gap_against"]
    inside = series([95.0, 95.5])
    assert tag(sig("call"), inside)["gap"] is None and not tag(sig("call"), inside)["gap_against"]


def test_the_leader_tag_is_qqq_against_smhs_vwap_and_counted_apart_without_a_tape():
    bars = series([95.0, 95.5])

    def smh(close: float, vwap: float | None) -> Tape:
        return Tape(close, vwap, None, None, 1.0, close, close, 0.1, "range")
    assert "leader_against" not in tag(sig(), bars)                       # SPY: not in the trial
    assert tag(sig("call"), bars, root="QQQ", leader=smh(10.0, 10.5))["leader_against"] is True
    assert tag(sig("put"), bars, root="QQQ", leader=smh(10.0, 10.5))["leader_against"] is False
    assert tag(sig("put"), bars, root="QQQ", leader=smh(11.0, 10.5))["leader_against"] is True
    assert tag(sig("call"), bars, root="QQQ", leader=smh(10.5, 10.5))["leader_against"] is False   # equal
    assert tag(sig("call"), bars, root="QQQ", leader=None)["leader_against"] is None


def test_iv_rich_is_above_035_for_spy_and_qqq_and_070_for_single_names():
    bars = series([95.0, 95.5])
    assert tag(sig(), bars, iv=0.36)["iv_rich"] and not tag(sig(), bars, iv=0.35)["iv_rich"]
    assert not tag(sig(), bars, root="NVDA", iv=0.69)["iv_rich"] and tag(sig(), bars, root="NVDA", iv=0.71)["iv_rich"]
    t = tag(sig(), bars, iv=None, iv_modelled=None)
    assert t["iv_rich"] is None and t["iv_cap"] == 0.35
    assert tag(sig(), bars, iv=0.5, iv_modelled=True)["iv_modelled"] is True


def test_early_is_ten_to_eleven_late_is_eleven_to_1430_and_half_days_are_neither():
    bars = series([95.0, 95.5])
    assert [tag(sig(end=t), bars)["early"] for t in ("10:00", "10:58", "11:00", "14:30", "14:32", "09:58")] == \
        [True, True, False, False, None, None]
    assert tag(sig(end="10:26"), bars, half_day=True)["early"] is None


# ---------------------------------------------------------------- the shadow exits
FILL_AT = at("10:26")
FLAT = at("15:10")


def book() -> shadow.Shadow:
    return shadow.Shadow("2026-10-19", ON["research_arms"], CFG["exits"], 0.03, FLAT)


def runner(sh: shadow.Shadow, next_level: float | None = 584.0) -> shadow.Virtual:
    sh.open_runner("T1", "SPY", "SPY261019C00581000", "call", "retest", "PDH", 581.0, 580.0, next_level, "10:26",
                   1.00, FILL_AT.isoformat(), FILL_AT)
    return sh.trades[-1]


def bars_to(hhmm: str, close: float = 582.0) -> list[Bar]:
    end = at(hhmm)
    return [Bar(end - dt.timedelta(minutes=2), end, close, close + 0.1, close - 0.1, close, 1.0, close)]


def tape(close: float = 582.0, ema: float | None = 581.5) -> Tape:
    return Tape(close, 581.0, ema, 581.0, 1.0, close, 579.0, 0.2, "trend-up")


def test_the_runner_stops_at_minus_25_percent_before_breakeven_and_books_after_fees():
    sh = book()
    v = runner(sh)
    (rec,) = sh.step(at("10:27"), {v.symbol: (0.75, 0.77)}, {"SPY": bars_to("10:26")}, {"SPY": tape()})
    assert v.state == "closed" and v.exit_reason == "premium" and v.exit_fill == 0.75
    assert rec["event"] == "closed" and rec["paired"] == "T1" and rec["rop"] == round((-25 - 0.06) / 100.03, 4)


def test_the_runner_has_no_target_and_no_time_stop():
    sh = book()
    v = runner(sh)
    sh.step(at("10:33"), {v.symbol: (1.00, 1.02)}, {"SPY": bars_to("10:32")}, {"SPY": tape()})   # 7 minutes in
    sh.step(at("10:34"), {v.symbol: (1.80, 1.82)}, {"SPY": bars_to("10:32")}, {"SPY": tape()})   # +80%
    assert v.state == "open" and v.breakeven


def test_the_runner_closes_on_a_close_beyond_the_invalidation_before_breakeven():
    sh = book()
    v = runner(sh)
    sh.step(at("10:29"), {v.symbol: (0.95, 0.97)}, {"SPY": bars_to("10:28", 579.9)}, {"SPY": tape(579.9)})
    assert v.exit_reason == "chart"


def test_after_breakeven_the_stop_is_the_fill_and_a_close_under_the_9_ema_trails_it_out():
    sh = book()
    v = runner(sh)
    recs = sh.step(at("10:30"), {v.symbol: (1.25, 1.27)}, {"SPY": bars_to("10:28")}, {"SPY": tape()})
    assert [r["event"] for r in recs] == ["breakeven"] and v.breakeven_at == at("10:30").isoformat()
    # the bar that finished before breakeven does not trail, even under the EMA
    sh.step(at("10:31"), {v.symbol: (1.20, 1.22)}, {"SPY": bars_to("10:30", 581.4)}, {"SPY": tape(581.4)})
    assert v.state == "open"
    sh.step(at("10:32", 5), {v.symbol: (1.15, 1.17)}, {"SPY": bars_to("10:32", 581.4)}, {"SPY": tape(581.4)})
    assert v.exit_reason == "trail" and v.exit_fill == 1.15
    sh2 = book()
    w = runner(sh2)
    sh2.step(at("10:30"), {w.symbol: (1.25, 1.27)}, {"SPY": bars_to("10:28")}, {"SPY": tape()})
    sh2.step(at("10:31"), {w.symbol: (1.00, 1.02)}, {"SPY": bars_to("10:28")}, {"SPY": tape()})
    assert w.exit_reason == "breakeven" and w.exit_fill == 1.00


def test_the_runner_takes_profit_at_the_next_level_and_is_flat_by_1510():
    sh = book()
    v = runner(sh)
    sh.step(at("10:40"), {v.symbol: (1.90, 1.92)}, {"SPY": bars_to("10:40", 584.0)}, {"SPY": tape(584.0, 583.0)})
    assert v.exit_reason == "next-level" and v.exit_fill == 1.90
    sh2 = book()
    w = runner(sh2, next_level=None)
    sh2.step(at("15:09", 50), {w.symbol: (1.30, 1.32)}, {"SPY": bars_to("15:08")}, {"SPY": tape()})
    assert w.state == "open"
    sh2.step(at("15:10"), {}, {"SPY": bars_to("15:10")}, {"SPY": tape()})       # no quote: the last bid read
    assert w.exit_reason == "flatten:last-bid" and w.exit_fill == 1.30


def test_a_safety_exit_of_the_control_closes_the_runner_with_it_and_a_strategy_exit_does_not():
    sh = book()
    v = runner(sh)
    assert sh.control_closed("T1", "time", 0.98, at("10:31")) == []
    assert v.state == "open"
    (rec,) = sh.control_closed("T1", "blind", 1.10, at("10:40"))
    assert v.exit_reason == "with-control:blind" and v.exit_fill == 1.10 and rec["event"] == "closed"
    assert sh.open_runner("T1", "SPY", v.symbol, "call", "retest", "PDH", 581.0, 580.0, None, "10:26", 1.0,
                          FILL_AT.isoformat(), FILL_AT) == []                   # one runner per real fill
    assert sh.open_runner("T2", "SPY", v.symbol, "call", "trap", "PDH", 581.0, 580.0, None, "10:26", 1.0,
                          FILL_AT.isoformat(), FILL_AT) == []                   # only retest and rejection


def pending(sh: shadow.Shadow, arm: str = "trap", n: int = 0, limit: float | None = 1.02) -> list[dict[str, Any]]:
    v = shadow.Virtual(arm, f"v{n}", "SPY", "SPY261019P00581000", "put", arm, "PWH", 581.0, 582.0, 578.0,
                       "10:26", limit=limit, deadline=at("10:28").isoformat())
    return sh.signal(arm, v, True, {"gates": {}}, at("10:26"))


def test_a_trap_waits_for_an_ask_inside_the_limit_until_the_next_bar_ends():
    sh = book()
    assert pending(sh)[0]["event"] == "pending"
    v = sh.trades[0]
    assert sh.step(at("10:26", 30), {v.symbol: (1.03, 1.05)}, {}, {}) == [] and v.state == "pending"
    (rec,) = sh.step(at("10:27"), {v.symbol: (1.00, 1.02)}, {}, {})
    assert rec["event"] == "filled" and v.fill == 1.02 and v.state == "open"
    late = book()
    pending(late)
    late.step(at("10:28", 10), {"SPY261019P00581000": (1.00, 1.01)}, {}, {})
    assert late.trades[0].state == "unfilled" and late.trades[0].fill is None


def test_one_virtual_position_per_arm_at_most_five_fills_a_day_and_never_without_a_contract():
    sh = book()
    pending(sh)
    assert pending(sh, n=1)[0]["refused"] == "arm-busy"
    assert pending(sh, arm="reclaim_fast", n=2)[0]["event"] == "pending"       # the other arm is its own
    assert book().signal("trap", shadow.Virtual("trap", "x", "SPY", "", "put", "trap", "PWH", 1, 2, None, "10:26"),
                         True, {}, at("10:26"))[0]["refused"] == "no-contract"
    assert book().signal("trap", shadow.Virtual("trap", "x", "SPY", "S", "put", "trap", "PWH", 1, 2, None, "10:26",
                                                limit=1.0), False, {}, at("10:26"))[0]["refused"] == "gates"
    full = book()
    for i in range(5):
        full.trades.append(shadow.Virtual("trap", f"f{i}", "SPY", "S", "put", "trap", "PWH", 1, 2, None, "10:26",
                                          state="closed", fill=1.0))
    assert pending(full, n=9)[0]["refused"] == "max-entries"


def test_a_virtual_trap_uses_the_controls_exits_target_and_time_stop_included():
    sh = book()
    pending(sh)
    v = sh.trades[0]
    sh.step(at("10:27"), {v.symbol: (1.00, 1.02)}, {}, {})
    sh.step(at("10:28"), {v.symbol: (1.54, 1.56)}, {"SPY": bars_to("10:28", 580.0)}, {"SPY": tape(580.0)})
    assert v.exit_reason == "target" and v.exit_fill == 1.54
    sh2 = book()
    pending(sh2)
    w = sh2.trades[0]
    sh2.step(at("10:27"), {w.symbol: (1.00, 1.02)}, {}, {})
    sh2.step(at("10:32", 10), {w.symbol: (1.01, 1.03)}, {"SPY": bars_to("10:32", 580.0)}, {"SPY": tape(580.0)})
    assert w.exit_reason == "time"


def test_a_restart_restores_the_virtual_book_from_its_own_records():
    sh = book()
    recs = pending(sh) + sh.step(at("10:27"), {"SPY261019P00581000": (1.00, 1.02)}, {}, {})
    again = book()
    again.restore([*recs, {"event": "levels"}, {"vid": "z", "arm": "other"}])
    (v,) = again.trades
    assert v.state == "open" and v.fill == 1.02 and again.busy("trap") and again.symbols() == [v.symbol]


# ---------------------------------------------------------------- no order path
def test_the_shadow_module_imports_no_order_path():
    tree = ast.parse((ROOT / "src" / "wt" / "options" / "shadow.py").read_text())
    imported = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)} | \
        {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    assert imported <= {"__future__", "datetime", "collections.abc", "dataclasses", "typing", "wt.options.regime"}
    code = ("import sys, wt.options.shadow; print(sorted(m for m in sys.modules if m.startswith("
            "('wt.oms', 'wt.brokers', 'wt.risk', 'wt.live', 'requests', 'alpaca'))))")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True,
                         env={"PYTHONPATH": str(ROOT / "src")})
    assert out.stdout.strip() == "[]"


# ---------------------------------------------------------------- the control is unchanged with the arms on
def session_run(tmp: Path, monkeypatch: pytest.MonkeyPatch, cfg: dict[str, Any], after: float | None = None,
                names: tuple[str, ...] = ("SPY",), tweak: Any = None) -> dict[str, Any]:
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.setattr(runner_o, "JOURNAL", tmp / "journal.jsonl")
    monkeypatch.setattr(runner_o.hc, "ping_async", lambda *a, **k: None)
    m = ts.Market()
    m.after = after
    m.bid_fn = lambda t: 1.40 if t < at("10:40") else 1.45          # the control's time stop; the runner holds on
    b = ts.Paper(m)
    rows: list[dict[str, Any]] = []
    calls: list[tuple[str, str, str]] = []               # (what, symbols, clock): the order of feed calls and orders
    minutes, chain_, place = m.minutes, m.chain, b.place

    def logged_minutes(symbols, start, end):
        calls.append(("minutes", ",".join(symbols), m.now.strftime("%H:%M:%S")))
        return minutes(symbols, start, end)

    def logged_chain(root, expiry):
        calls.append(("chain", root, m.now.strftime("%H:%M:%S")))
        return chain_(root, expiry)

    def logged_place(order):
        calls.append(("place", order.symbol, m.now.strftime("%H:%M:%S")))
        return place(order)
    m.minutes, m.chain, b.place = logged_minutes, logged_chain, logged_place
    if tweak is not None:
        tweak(m)

    class Pager:
        def fire(self, *a: Any, **k: Any) -> None:
            rows.append({"event": "page", "key": a[0]})

        def once_per_day(self, *a: Any, **k: Any) -> None:
            rows.append({"event": "page", "key": a[0]})

    def write(event: str, **kw: Any) -> bool:
        rows.append({"event": event, **kw})
        return True

    r = Runner(DAY, cfg, ts.LIM, m, b, lambda: m.now, lambda s: None, Pager(), write=write, state=tmp / "options",
               kills=(tmp / "KILL",))
    r.prepare = lambda: r.names.update({n: Name(n, [Mark("PDL", 576.0), Mark("PDH", ts.L, True),
                                                    Mark("PWH", ts.NEXT, True)], m.contracts("SPY", DAY))
                                        for n in names})
    m.now = at("09:25")
    r.arm()
    ts.run_until(r, m, b, at("10:40"))
    ts.run_until(r, m, b, at("15:21"), step_s=60)
    decisions = (tmp / "options" / "decisions" / "2026-10-19.jsonl").read_text().splitlines()
    orders = [(o.client_order_id, o.side, o.type, o.qty, o.limit_price, o.stop_price, str(o.status))
              for o in b.orders.values()]
    shadow_file = tmp / "options" / "shadow" / "2026-10-19.jsonl"
    plans = [(p.trade_id, p.symbol, p.state, p.limit, p.quoted_ask, p.quote_age_s, p.entry_sent_at, p.fill,
              p.filled_at, p.exit_fill, p.exit_at, p.exit_reason) for p in r.plans]
    return {"decisions": decisions, "orders": orders, "rows": rows, "r": r, "calls": calls, "plans": plans,
            "shadow": [json.loads(x) for x in shadow_file.read_text().splitlines()] if shadow_file.exists() else []}


def strip_arms(line: str) -> str:
    rec = json.loads(line)
    for s in rec.get("signals", []):
        s.pop("arms", None)
    return json.dumps(rec, default=str)


def test_the_controls_decisions_orders_and_journal_are_identical_with_the_arms_on_and_off(tmp_path, monkeypatch):
    off = session_run(tmp_path / "off", monkeypatch, CFG)
    on = session_run(tmp_path / "on", monkeypatch, ON)
    assert off["shadow"] == [] and not (tmp_path / "off" / "options" / "shadow").exists()
    assert not any("arms" in s for d in off["decisions"] for s in json.loads(d).get("signals", []))
    # byte for byte, once the arms' own key is taken out of the decision lines
    assert [strip_arms(x) for x in on["decisions"]] == off["decisions"]
    assert on["orders"] == off["orders"] and on["rows"] == off["rows"]
    assert [(p.trade_id, p.state, p.fill, p.exit_fill, p.exit_reason) for p in on["r"].plans] == \
        [(p.trade_id, p.state, p.fill, p.exit_fill, p.exit_reason) for p in off["r"].plans]
    (p,) = on["r"].plans
    assert p.exit_reason == "time"                                         # the control's own exit
    # the arms did their work beside it: the tags on the signal, and the runner held past the control's time stop
    (entered,) = [json.loads(d) for d in on["decisions"] if json.loads(d)["action"] == "entered"]
    tags = entered["signals"][0]["arms"]
    assert tags["early"] is True and tags["iv_rich"] is False and tags["iv_cap"] == 0.35
    assert tags["broken"] == ["PDH"] and tags["ntz"] is None and tags["gap_against"] is False   # no 5-day range here
    runs = [x for x in on["shadow"] if x.get("arm") == "runner"]
    assert [x["event"] for x in runs] == ["filled", "closed"]
    assert runs[0]["paired"] == p.trade_id and runs[0]["fill"] == p.fill
    assert runs[-1]["exit_reason"] == "flatten" and runs[-1]["exit_fill"] == 1.45
    assert not [x for x in on["shadow"] if x["event"] == "fault"]


def test_a_failed_break_is_gated_and_logged_by_the_trap_arm_and_the_control_is_still_identical(tmp_path, monkeypatch):
    off = session_run(tmp_path / "off", monkeypatch, CFG, after=580.6)    # back under 581 three bars after the break
    on = session_run(tmp_path / "on", monkeypatch, ON, after=580.6)
    assert [strip_arms(x) for x in on["decisions"]] == off["decisions"]
    assert on["orders"] == off["orders"] and on["rows"] == off["rows"]
    traps = [x for x in on["shadow"] if x.get("arm") == "trap"]
    assert traps and traps[0]["side"] == "put" and traps[0]["signal_bar"] == "10:28"
    assert "gates" in traps[0]["why"] and set(traps[0]["why"]["gates"]) >= {"trend", "room", "contract"}
    assert not [x for x in on["shadow"] if x["event"] == "fault"]


def test_a_fault_in_an_arm_is_written_to_the_shadow_file_and_costs_the_control_nothing(tmp_path, monkeypatch):
    off = session_run(tmp_path / "off", monkeypatch, CFG)
    monkeypatch.setattr(setups, "tag_decision", lambda *a, **k: 1 / 0)
    monkeypatch.setattr(shadow.Shadow, "step", lambda *a, **k: 1 / 0)
    on = session_run(tmp_path / "on", monkeypatch, ON)
    assert on["orders"] == off["orders"] and on["rows"] == off["rows"]
    assert [strip_arms(x) for x in on["decisions"]] == off["decisions"]
    faults = {x["arm"] for x in on["shadow"] if x["event"] == "fault"}
    assert {"tags", "step"} <= faults


def test_the_leader_tape_is_read_at_the_signal_bars_close(tmp_path, monkeypatch):
    m = ts.Market()
    m.now = at("10:30")
    r = Runner(DAY, ON, ts.LIM, m, ts.Paper(m), lambda: m.now, lambda s: None, None, write=lambda *a, **k: True,
               state=tmp_path, kills=())
    t = r.leader_tape("SMH", at("10:26"))
    assert t is not None and t.close == pytest.approx(ts.closes()[27])
    assert r.leader_tape("SMH", at("10:26")) is t                           # once per bar


def test_arm_with_the_arms_on_logs_the_research_levels_and_marks_the_same_levels(tmp_path, monkeypatch):
    days, d = [], "2026-10-16"
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    rows = [{"t": f"{x}T04:00:00Z", "o": 570 + i * 0.1, "h": 571 + i * 0.1, "l": 569 + i * 0.1, "c": 570.5 + i * 0.1,
             "v": 1e6} for i, x in enumerate(days)]
    class Quiet:
        def fire(self, *a: Any, **k: Any) -> None: ...

        def once_per_day(self, *a: Any, **k: Any) -> None: ...

    def armed(name: str, cfg: dict[str, Any]) -> list[Mark]:
        monkeypatch.setattr(runner_o, "JOURNAL", tmp_path / name / "journal.jsonl")
        monkeypatch.setattr(runner_o.hc, "ping_async", lambda *a, **k: None)
        m = ts.Market()
        m.daily = lambda symbols, start, end: {"SPY": rows}
        r = Runner(DAY, {**cfg, "names": {**cfg["names"], "fallback": ["SPY"], "top_up": []}}, ts.LIM, m, ts.Paper(m),
                   lambda: m.now, lambda s: None, Quiet(), write=lambda *a, **k: True, state=tmp_path / name,
                   kills=(), macro=[{"date": days[-3], "severity": "high", "type": "cpi"},
                                    {"date": days[-2], "severity": "medium", "type": "fomc_minutes"}])
        m.now = at("09:25")
        r.arm()
        return r.names["SPY"].marks

    marks = {name: armed(name, cfg) for name, cfg in (("off", CFG), ("on", ON))}
    assert marks["on"] == marks["off"]
    (rec,) = [json.loads(x) for x in (tmp_path / "on" / "shadow" / "2026-10-19.jsonl").read_text().splitlines()]
    got = rec["levels"]["SPY"]
    assert rec["event"] == "levels" and {"SWH", "SWL", "EVH", "EVL", "ATH"} <= set(got)
    i = len(days) - 3
    assert got["EVH"] == pytest.approx(571 + i * 0.1)                      # the high-severity day, not the later one
    assert got["ATH"] == pytest.approx(571 + (len(days) - 1) * 0.1)
    assert got["SWL"] == pytest.approx(569 + (len(days) - 5) * 0.1)
    assert not (tmp_path / "off" / "shadow").exists()


# ---------------------------------------------------------------- review items (D1 to D9)
def test_two_names_and_a_failing_leader_fetch_leave_the_controls_orders_and_quotes_untouched(tmp_path, monkeypatch):
    """QQQ is looked at before SPY; its SMH fetch raises. Every order of the poll goes out before any arm's fetch,
    the control's orders, quotes and times are the same with the arms on and off, and only `leader_against` is
    unknown on QQQ's tags."""
    def smh_fails(m: Any) -> None:
        inner = m.minutes

        def minutes(symbols, start, end):
            if "SMH" in symbols:
                inner(symbols, start, end)                      # logged, then it fails
                raise TimeoutError("slow leader")
            return inner(symbols, start, end)
        m.minutes = minutes
    off = session_run(tmp_path / "off", monkeypatch, CFG, names=("QQQ", "SPY"), tweak=smh_fails)
    on = session_run(tmp_path / "on", monkeypatch, ON, names=("QQQ", "SPY"), tweak=smh_fails)
    assert on["orders"] == off["orders"] and on["plans"] == off["plans"] and on["rows"] == off["rows"]
    assert [strip_arms(x) for x in on["decisions"]] == off["decisions"]
    # the control's own calls are the same, in the same order, at the same clock, with the arms on
    assert [c for c in on["calls"] if "SMH" not in c[1]] == off["calls"]
    assert not any("SMH" in c[1] for c in off["calls"])
    # in every poll that placed an order, each SMH fetch came after every order of that poll
    polls = {c[2] for c in on["calls"] if c[0] == "place"}
    assert polls
    for t in polls:
        idx = [i for i, c in enumerate(on["calls"]) if c[2] == t]
        last_order = max(i for i in idx if on["calls"][i][0] == "place")
        assert all(i > last_order for i in idx if "SMH" in on["calls"][i][1])
    assert any("SMH" in c[1] for c in on["calls"])
    bar = next(json.loads(d) for d in on["decisions"] if json.loads(d)["root"] == "QQQ" and json.loads(d).get("signals"))
    t = bar["signals"][0]["arms"]
    assert t["leader_against"] is None and t["leader_fault"] == "TimeoutError"
    assert t["early"] is True and t["iv_cap"] == 0.35 and "ntz" in t and t["release"] and t["config"]
    spy = next(json.loads(d) for d in on["decisions"] if json.loads(d)["action"] == "entered")
    assert spy["root"] == "SPY" and spy["signals"][0]["arms"]["trade_id"] == on["r"].plans[0].trade_id
    assert "leader_against" not in spy["signals"][0]["arms"]


def test_a_failing_overnight_fetch_keeps_the_codes_from_the_daily_bars(tmp_path, monkeypatch):
    days, d = [], "2026-10-16"
    for _ in range(80):
        days.append(d)
        d = lv.prev_session(d)
    days.reverse()
    rows = [{"t": f"{x}T04:00:00Z", "o": 570 + i * 0.1, "h": 571 + i * 0.1, "l": 569 + i * 0.1, "c": 570.5 + i * 0.1,
             "v": 1e6} for i, x in enumerate(days)]
    monkeypatch.setattr(runner_o, "JOURNAL", tmp_path / "journal.jsonl")
    monkeypatch.setattr(runner_o.hc, "ping_async", lambda *a, **k: None)
    m = ts.Market()
    m.daily = lambda symbols, start, end: {"SPY": rows}
    inner = m.minutes

    def minutes(symbols, start, end):
        if start.astimezone(NEW_YORK).time() == dt.time(16, 0):
            raise TimeoutError("overnight")
        return inner(symbols, start, end)
    m.minutes = minutes
    r = Runner(DAY, {**ON, "names": {**ON["names"], "fallback": ["SPY"], "top_up": []}}, ts.LIM, m, ts.Paper(m),
               lambda: m.now, lambda s: None, None, write=lambda *a, **k: True, state=tmp_path, kills=())
    r.pager = type("P", (), {"fire": staticmethod(lambda *a: None), "once_per_day": staticmethod(lambda *a: None)})()
    m.now = at("09:25")
    r.arm()
    got = r.names["SPY"].research
    assert {"SWH", "SWL", "ATH"} <= set(got) and "ONH" not in got
    recs = [json.loads(x) for x in (tmp_path / "shadow" / "2026-10-19.jsonl").read_text().splitlines()]
    assert any(x["event"] == "fault" and x["arm"] == "overnight" for x in recs)


def test_a_malformed_research_arms_block_is_a_fault_and_never_stops_the_runner(tmp_path):
    bad = {**CFG, "research_arms": {"enabled": True, "tags": {}, "shadow": {}}}
    m = ts.Market()
    m.now = at("09:25")
    r = Runner(DAY, bad, ts.LIM, m, ts.Paper(m), lambda: m.now, lambda s: None, None, write=lambda *a, **k: True,
               state=tmp_path, kills=())
    assert r.shadow is None and not r.arms_cfg
    (rec,) = [json.loads(x) for x in (tmp_path / "shadow" / "2026-10-19.jsonl").read_text().splitlines()]
    assert rec["event"] == "fault" and rec["arm"] == "setup"
    r2 = Runner(DAY, {**CFG, "research_arms": "nonsense"}, ts.LIM, m, ts.Paper(m), lambda: m.now, lambda s: None,
                None, write=lambda *a, **k: True, state=tmp_path / "2", kills=())
    assert r2.shadow is None


def test_the_gap_codes_are_written_once_the_open_is_known(tmp_path):
    m = ts.Market()
    r = Runner(DAY, ON, ts.LIM, m, ts.Paper(m), lambda: m.now, lambda s: None, None, write=lambda *a, **k: True,
               state=tmp_path, kills=())
    nm = Name("SPY", [Mark("PDL", 570.0), Mark("PDH", 575.0)], {})
    two = series([579.0, 579.5])
    r.arms_gap("SPY", nm, two)
    r.arms_gap("SPY", nm, two)                                       # once a session
    assert nm.research == {"GAPH": two[0].o, "GAPL": 575.0}
    (rec,) = [json.loads(x) for x in (tmp_path / "shadow" / "2026-10-19.jsonl").read_text().splitlines()]
    assert rec["event"] == "levels" and rec["gap"] == {"GAPH": two[0].o, "GAPL": 575.0} and rec["release"]


def test_a_chain_error_still_logs_each_trap_signal_as_refused(tmp_path, monkeypatch):
    def chain_fails_late(m: Any) -> None:
        inner = m.chain

        def chain(root, expiry):
            if m.now >= at("10:28"):
                raise TimeoutError("chain")
            return inner(root, expiry)
        m.chain = chain
    on = session_run(tmp_path, monkeypatch, ON, after=580.6, tweak=chain_fails_late)
    traps = [x for x in on["shadow"] if x.get("arm") == "trap"]
    assert traps and all(x["event"] == "signal" and x["refused"] == "chain-unavailable" for x in traps)
    assert len({x["vid"] for x in traps}) == len(traps)


def test_refused_signals_are_not_written_again_after_a_restart_and_two_levels_get_two_ids():
    sh = book()
    a = shadow.Virtual("trap", shadow.vid_of("2026-10-19", "trap", "SPY", "10:28", "put", "PDH"), "SPY", "", "put",
                       "trap", "PDH", 581.0, 582.0, None, "10:28")
    b = shadow.Virtual("trap", shadow.vid_of("2026-10-19", "trap", "SPY", "10:28", "put", "PWH"), "SPY", "", "put",
                       "trap", "PWH", 581.2, 582.0, None, "10:28")
    assert a.vid != b.vid
    recs = sh.signal("trap", a, False, {}, at("10:28")) + sh.signal("trap", b, False, {}, at("10:28"))
    assert [r["vid"] for r in recs] == [a.vid, b.vid]
    assert sh.signal("trap", a, False, {}, at("10:28")) == []                     # once per id
    again = book()
    again.restore(recs)
    assert again.seen == {a.vid, b.vid} and again.trades == []
    assert again.signal("trap", a, False, {}, at("10:28")) == []


# ---------------------------------------------------------------- the verdict script (DEC-0041 point 7)
def trade(i: int, setup: str, rop: float, day: str) -> dict[str, Any]:
    return {"event": "trade_closed", "trade_id": f"{day}-O-{i}", "setup": setup, "symbol": "SPY" + day[2:4] +
            day[5:7] + day[8:10] + "C00581000", "rop": rop, "pnl": rop * 100, "counts": True}


def sessions_from(start: str, n: int) -> list[str]:
    out, d = [], start
    while len(out) < n:
        if lv.is_session(d):
            out.append(d)
        d = (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()
    return out


def tagged_book(n_days: int, per_day: int, cfg_hash: str = "c1", change_from: int | None = None):
    trades, decisions = [], []
    for k, day in enumerate(sessions_from("2026-11-05", n_days)):
        for j in range(per_day):
            i = k * per_day + j
            flag = j % 2 == 0
            trades.append(trade(i, "retest", -0.2 if flag else 0.3, day))
            h = "c2" if change_from is not None and k >= change_from else cfg_hash
            decisions.append({"root": "SPY", "action": "entered", "signals": [{"arms": {
                "trade_id": f"{day}-O-{i}", "ntz": flag, "release": "abc", "config": h}}]})
    return trades, decisions


def test_a_tag_trial_shows_counts_only_until_its_count_then_its_verdict():
    t = av.BY_NAME["OC-NTZ-RETEST"]
    trades, decisions = tagged_book(10, 4)
    us, unknown = av.units(t, trades, decisions, [])
    res = av.decide(t, us, "2026-12-01")
    assert res == {"trial": "OC-NTZ-RETEST", "hypothesis": "HYP-0034", "status": "pending", "sessions": 10,
                   "tagged": 20, "rest": 20}                           # counts only, no return of any kind
    trades, decisions = tagged_book(25, 4)
    us, _ = av.units(t, trades, decisions, [])
    res = av.decide(t, us, "2027-01-01")
    assert res["status"] == "passes" and res["quantity"] == pytest.approx(0.5) and res["ci_session"][0] > 0
    assert av.units(av.BY_NAME["OC-NTZ-REJECT"], trades, decisions, [])[0] == []          # another base setup


def test_a_tag_trial_stops_at_a_config_change_and_closes_without_a_verdict_on_its_date():
    t = av.BY_NAME["OC-NTZ-RETEST"]
    trades, decisions = tagged_book(25, 4, change_from=10)
    us, _ = av.units(t, trades, decisions, [])
    assert {u.session for u in us} == set(sessions_from("2026-11-05", 10))
    assert av.decide(t, us, "2027-11-05")["status"] == "closed-no-verdict"
    for d in decisions:
        d["signals"][0]["arms"]["release"] = ""                                      # unstamped: not in any window
    assert av.units(t, trades, decisions, [])[0] == []


def test_the_runner_trial_is_paired_and_trap_is_its_own_mean():
    days = sessions_from("2026-11-05", 22)
    trades, shadow_ = [], []
    for k, day in enumerate(days):
        for j in range(2):
            i = k * 2 + j
            trades.append(trade(i, "retest", 0.1, day))
            shadow_.append({"event": "closed", "arm": "runner", "paired": f"{day}-O-{i}", "rop": 0.3 if j else -0.05,
                            "release": "abc", "config": "c1"})
            shadow_.append({"event": "closed", "arm": "trap", "vid": f"{day}-trap-SPY-10:28-put-PWH-{j}",
                            "rop": 0.2, "release": "abc", "config": "c1"})
    run = av.decide(av.BY_NAME["OC-RUNNER-RETEST"], av.units(av.BY_NAME["OC-RUNNER-RETEST"], trades, [], shadow_)[0],
                    "2027-01-01")
    assert run["units"] == 44 and run["quantity"] == pytest.approx(((0.3 - 0.1) + (-0.05 - 0.1)) / 2)
    trap = av.decide(av.BY_NAME["OC-TRAP"], av.units(av.BY_NAME["OC-TRAP"], trades, [], shadow_)[0], "2027-01-01")
    assert trap["status"] == "passes" and trap["quantity"] == pytest.approx(0.2)


def test_the_verdict_script_writes_each_report_once_and_prints_counts_only_before(tmp_path, capsys):
    spec = importlib.util.spec_from_file_location("arms_verdict_script", ROOT / "scripts" / "options_clone_arms_verdict.py")
    assert spec is not None and spec.loader is not None
    v = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(v)
    state, out = tmp_path / "state", tmp_path / "exp"
    (state / "decisions").mkdir(parents=True)
    trades, decisions = tagged_book(10, 4)
    j = tmp_path / "journal.jsonl"
    j.write_text("\n".join(json.dumps(r) for r in trades))
    (state / "decisions" / "a.jsonl").write_text("\n".join(json.dumps(d) for d in decisions))
    args = ["--journal", str(j), "--state", str(state), "--out", str(out), "--today", "2026-12-01"]
    assert v.main(args) == 0 and not out.exists()
    printed = capsys.readouterr().out
    assert "OC-NTZ-RETEST: pending, counts only" in printed and "quantity" not in printed and "0.3" not in printed
    trades, decisions = tagged_book(25, 4)
    j.write_text("\n".join(json.dumps(r) for r in trades))
    (state / "decisions" / "a.jsonl").write_text("\n".join(json.dumps(d) for d in decisions))
    args[-1] = "2027-01-01"
    assert v.main(args) == 0
    report = out / "OC-NTZ-RETEST" / "report.md"
    assert "passes" in report.read_text() and json.loads((out / "OC-NTZ-RETEST" / "result.json").read_text())
    first = report.read_text()
    assert v.main(args) == 0 and report.read_text() == first
    assert "report exists, not written again" in capsys.readouterr().out
