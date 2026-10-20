"""The options clone's pure strategy code (DEC-0030): every rule shown taken and refused, on synthetic bars."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
import yaml

from wt.options import chain, regime, session, setups
from wt.options import levels as lv
from wt.options.regime import NEW_YORK, Bar
from wt.options.setups import Mark

ROOT = Path(__file__).resolve().parents[2]
CFG = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
DAY = dt.date(2026, 10, 19)                     # a Monday session
OPEN = dt.datetime.combine(DAY, dt.time(9, 30), NEW_YORK)


def bar(i: int, o: float, h: float, low: float, c: float, v: float = 1000.0) -> Bar:
    s = OPEN + dt.timedelta(minutes=2 * i)
    return Bar(s, s + dt.timedelta(minutes=2), o, h, low, c, v, c * v)


def series(closes: list[float], spread: float = 0.05) -> list[Bar]:
    out, prev = [], closes[0]
    for i, c in enumerate(closes):
        out.append(bar(i, prev, max(prev, c) + spread, min(prev, c) - spread, c))
        prev = c
    return out


# ---------------------------------------------------------------- regime
def test_minute_bars_keep_the_session_and_drop_what_cannot_be_read():
    rows = [{"t": "2026-10-19T13:29:00Z", "o": 1, "h": 1, "l": 1, "c": 1, "v": 5},        # 09:29 New York
            {"t": "2026-10-19T13:30:00Z", "o": 10, "h": 11, "l": 9, "c": 10.5, "v": 100},
            {"t": "2026-10-19T13:31:00Z", "o": "x", "h": 11, "l": 9, "c": 10.5, "v": 100},
            {"t": "2026-10-19T13:32:00Z", "o": 10, "h": 11, "l": -1, "c": 10.5, "v": 100}]
    got = regime.minute_bars(rows, DAY)
    assert [b.start.strftime("%H:%M") for b in got] == ["09:30"]


def test_two_minute_bars_count_only_once_finished():
    rows = [{"t": f"2026-10-19T13:{30 + i}:00Z", "o": 10 + i, "h": 10.5 + i, "l": 9.5 + i, "c": 10.2 + i, "v": 10}
            for i in range(5)]
    ms = regime.minute_bars(rows, DAY)
    now = OPEN + dt.timedelta(minutes=5)
    two = regime.resample(ms, 2, now)
    assert [(b.start.strftime("%H:%M"), b.o, b.c) for b in two] == [("09:30", 10, 11.2), ("09:32", 12, 13.2)]
    assert two[0].h == 11.5 and two[0].l == 9.5 and two[0].v == 20


def test_the_regime_word():
    up = series([100 + 0.05 * i for i in range(30)])
    assert regime.read(up, 14, 9, 20, 3.0).word == "trend-up"
    down = series([100 - 0.05 * i for i in range(30)])
    assert regime.read(down, 14, 9, 20, 3.0).word == "trend-down"
    shock = up[:-1] + [bar(29, up[-2].c, up[-2].c + 5, up[-2].c - 0.1, up[-2].c + 4.5)]
    assert regime.read(shock, 14, 9, 20, 3.0).word == "shock"
    assert regime.read(up[:5], 14, 9, 20, 3.0).word == "unknown"


# ---------------------------------------------------------------- retest (HYP-0029)
RT = CFG["setups"]["retest"]
L = Mark("PDH", 100.0)


def test_a_break_and_retest_call_is_taken_on_the_bar_that_closes_away():
    bars = [bar(0, 99.7, 99.85, 99.6, 99.8), bar(1, 99.8, 99.95, 99.75, 99.9),
            bar(2, 99.9, 100.4, 99.9, 100.3),           # A: the break
            bar(3, 100.3, 100.35, 100.1, 100.2),         # the touch: low within one ATR of 100
            bar(4, 100.2, 100.5, 100.15, 100.4)]         # B: the first close above the touch's close
    got = setups.retest(bars, [L], 0.2, RT)
    assert [(s.setup, s.side, s.entry, s.invalidation) for s in got] == [("retest", "call", 100.4, pytest.approx(99.8))]


def test_a_close_back_through_the_level_cancels_the_retest():
    bars = [bar(0, 99.7, 99.85, 99.6, 99.8), bar(1, 99.8, 99.95, 99.75, 99.9), bar(2, 99.9, 100.4, 99.9, 100.3),
            bar(3, 100.3, 100.35, 99.9, 99.95), bar(4, 99.95, 100.5, 99.9, 100.4)]
    assert all(s.side != "call" or s.setup != "retest" for s in setups.retest(bars, [L], 0.2, RT))


def test_the_signal_fires_once_not_on_every_later_bar():
    bars = [bar(0, 99.7, 99.85, 99.6, 99.8), bar(1, 99.8, 99.95, 99.75, 99.9), bar(2, 99.9, 100.4, 99.9, 100.3),
            bar(3, 100.3, 100.35, 100.1, 100.2), bar(4, 100.2, 100.5, 100.15, 100.4), bar(5, 100.4, 100.6, 100.35, 100.5)]
    assert setups.retest(bars, [L], 0.2, RT) == []


def test_a_retest_that_comes_too_late_is_no_signal():
    far = [bar(0, 99.7, 99.85, 99.6, 99.8), bar(1, 99.8, 99.95, 99.75, 99.9), bar(2, 99.9, 100.4, 99.9, 100.6)]
    far += [bar(3 + i, 100.6, 100.8, 100.55, 100.7) for i in range(RT["max_bars_to_retest"] + 1)]
    n = len(far)
    far += [bar(n, 100.7, 100.75, 100.1, 100.2), bar(n + 1, 100.2, 100.5, 100.15, 100.4)]
    assert setups.retest(far, [L], 0.2, RT) == []


def test_a_put_retest_is_the_mirror():
    bars = [bar(0, 100.3, 100.4, 100.15, 100.2), bar(1, 100.2, 100.25, 100.05, 100.1), bar(2, 100.1, 100.1, 99.6, 99.7),
            bar(3, 99.7, 99.9, 99.65, 99.8), bar(4, 99.8, 99.85, 99.5, 99.6)]
    got = setups.retest(bars, [L], 0.2, RT)
    assert [(s.side, s.invalidation) for s in got] == [("put", pytest.approx(100.2))]


# ---------------------------------------------------------------- rejection (HYP-0030)
RJ = CFG["setups"]["rejection"]
S = Mark("PWH", 100.0, strong=True)


def test_a_rejection_needs_the_poke_and_the_next_close():
    bars = [bar(0, 99.6, 99.85, 99.55, 99.8), bar(1, 99.8, 100.3, 99.75, 99.9), bar(2, 99.9, 99.95, 99.6, 99.7)]
    got = setups.rejection(bars, [S], RJ)
    assert [(s.setup, s.side, s.entry, s.invalidation) for s in got] == [("rejection", "put", 99.7, 100.3)]
    # the poke alone is not a signal: B closes back above
    assert setups.rejection(bars[:2] + [bar(2, 99.9, 100.2, 99.85, 100.1)], [S], RJ) == []


def test_a_rejection_only_at_a_strong_level():
    bars = [bar(0, 99.6, 99.85, 99.55, 99.8), bar(1, 99.8, 100.3, 99.75, 99.9), bar(2, 99.9, 99.95, 99.6, 99.7)]
    assert setups.rejection(bars, [Mark("PDH", 100.0, strong=False)], RJ) == []


def test_a_long_wick_counts_even_when_the_poke_closes_above():
    bars = [bar(0, 99.6, 99.85, 99.55, 99.8), bar(1, 99.95, 100.6, 99.9, 100.1),   # 0.6 of 0.7 is above the level
            bar(2, 100.1, 100.15, 99.6, 99.7)]
    assert [s.side for s in setups.rejection(bars, [S], RJ)] == ["put"]
    short_wick = [bar(0, 99.6, 99.85, 99.55, 99.8), bar(1, 99.5, 100.2, 99.5, 100.1), bar(2, 100.1, 100.15, 99.6, 99.7)]
    assert setups.rejection(short_wick, [S], RJ) == []


def test_a_call_rejection_is_the_mirror_at_support():
    bars = [bar(0, 100.4, 100.45, 100.15, 100.2), bar(1, 100.2, 100.25, 99.7, 100.1), bar(2, 100.1, 100.4, 100.05, 100.3)]
    assert [(s.side, s.invalidation) for s in setups.rejection(bars, [S], RJ)] == [("call", 99.7)]


# ---------------------------------------------------------------- gates
G = CFG["gates"]


def tape(close: float, vw: float | None, ema_fast: float, a: float = 0.2, word: str = "trend-up") -> regime.Tape:
    return regime.Tape(close, vw, ema_fast, ema_fast, a, close, close, 0.1, word)


SIG = setups.Signal("retest", "call", L, 100.4, 99.8, "09:40")
MARKS = [Mark("PDL", 98.0), L, Mark("PWH", 102.0)]


def test_every_gate_passes_for_a_clean_trade():
    g = setups.gate(SIG, tape(100.4, 100.0, 100.3), tape(500, 499, 499.5), MARKS, 3.0, G)
    assert g.ok and g.failed == [] and set(g.as_json()) == {"trend", "extension", "room", "reach", "shock"}


@pytest.mark.parametrize("name, kwargs", [
    ("trend", {"me": tape(100.4, 100.6, 100.3)}),                       # the name below its VWAP for a call
    ("trend", {"spy": tape(500, 501, 499.5)}),                          # SPY below its VWAP
    ("extension", {"me": tape(100.4, 100.0, 99.9)}),                    # 2.5 ATRs from the fast EMA
    ("room", {"marks": [Mark("PDL", 98.0), L, Mark("X", 101.0)]}),      # 0.6 away, under twice the 0.6 risk
    ("reach", {"move": 1.0}),                                           # the next level is 1.6 away
    ("shock", {"me": tape(100.4, 100.0, 100.3, word="shock")}),
])
def test_each_gate_refuses_on_its_own(name, kwargs):
    g = setups.gate(SIG, kwargs.get("me", tape(100.4, 100.0, 100.3)), kwargs.get("spy", tape(500, 499, 499.5)),
                    kwargs.get("marks", MARKS), kwargs.get("move", 3.0), G)
    assert g.failed == [name]


# ---------------------------------------------------------------- the contract
C = {**CFG["contract"], "quote_stale_flat_s": CFG["feeds"]["quote_stale_flat_s"]}
NOW = dt.datetime(2026, 10, 19, 15, 0, tzinfo=dt.UTC)


def snap(k: float, bid: float, ask: float, delta: float, vol: float = 10000, side: str = "C", age_s: float = 2) -> tuple[str, dict]:
    sym = f"SPY261019{side}{int(k * 1000):08d}"
    t = (NOW - dt.timedelta(seconds=age_s)).isoformat().replace("+00:00", "Z")
    return sym, {"latestQuote": {"bp": bid, "ap": ask, "t": t}, "greeks": {"delta": delta},
                 "impliedVolatility": 0.2, "dailyBar": {"v": vol}}


def test_occ_symbols():
    c = chain.parse_occ("SPY261019C00580000")
    assert (c.root, c.expiry, c.side, c.strike) == ("SPY", DAY, "call", 580.0)
    assert chain.parse_occ("SPY1261019C00580000") is None


def test_the_nearest_strike_that_passes_every_check_is_chosen():
    raw = dict([snap(580, 1.10, 1.12, 0.52), snap(581, 0.70, 0.72, 0.38), snap(579, 1.60, 1.62, 0.64),
                snap(582, 0.40, 0.42, 0.25), snap(578, 2.10, 2.12, 0.74)])
    qs = chain.parse_snapshots(raw)
    oi = {q.contract.symbol: 5000.0 for q in qs}
    got = chain.pick(qs, "SPY", "call", DAY, 580.4, NOW, C, oi, set(), late=False)
    assert got.quote.contract.strike == 580
    assert got.reasons == {"delta-below-floor": 1, "premium-over-cap": 1}


@pytest.mark.parametrize("change, reason", [
    ({"age_s": 120}, "stale-quote"),
    ({"bid": 0.95, "ask": 1.15}, "spread-too-wide"),
    ({"vol": 100}, "volume-below-floor"),
    ({"bid": 1.2, "ask": 1.1}, "no-two-sided-quote"),                   # crossed
])
def test_a_contract_is_refused_for_exactly_one_reason(change, reason):
    args = {"bid": 1.10, "ask": 1.12, "vol": 10000, "age_s": 2} | change
    raw = dict([snap(580, args["bid"], args["ask"], 0.52, vol=args["vol"], age_s=args["age_s"])])
    got = chain.pick(chain.parse_snapshots(raw), "SPY", "call", DAY, 580.0, NOW, C,
                     {"SPY261019C00580000": 5000.0}, set(), late=False)
    assert got.quote is None and got.reasons == {reason: 1}


def test_open_interest_the_late_delta_floor_and_a_held_contract():
    raw = dict([snap(580, 1.10, 1.12, 0.38)])
    qs = chain.parse_snapshots(raw)
    sym = "SPY261019C00580000"
    assert chain.pick(qs, "SPY", "call", DAY, 580, NOW, C, {sym: 10.0}, set(), False).reasons == {"open-interest-below-floor": 1}
    assert chain.pick(qs, "SPY", "call", DAY, 580, NOW, C, {sym: 5000.0}, set(), True).reasons == {"delta-below-floor": 1}
    assert chain.pick(qs, "SPY", "call", DAY, 580, NOW, C, {sym: 5000.0}, {sym}, False).reasons == {"already-held": 1}
    assert chain.pick(qs, "SPY", "put", DAY, 580, NOW, C, {}, set(), False).reasons == {"no-same-day-contract": 1}


def test_the_entry_limit_is_the_ask_plus_the_buffer_never_above_the_cap():
    assert chain.entry_limit(1.00, 2, 2.00) == 1.02
    assert chain.entry_limit(1.99, 2, 2.00) == 2.00


# ---------------------------------------------------------------- the session
def test_names_from_today_focus_else_the_fallback():
    focus = {"items": [{"symbol": "TSLA", "rank": 2}, {"symbol": "PLTR", "rank": 1}, {"symbol": "spy", "rank": 4}]}
    assert session.names(focus, "2026-10-19", "2026-10-19", ["SPY", "QQQ"], 6) == (["PLTR", "TSLA", "SPY"], "focus")
    assert session.names(focus, "2026-10-16", "2026-10-19", ["SPY", "QQQ"], 6) == (["SPY", "QQQ"], "fallback")
    assert session.names(None, None, "2026-10-19", ["SPY", "QQQ"], 6) == (["SPY", "QQQ"], "fallback")


def test_marks_and_which_are_strong():
    levels = {"levels": [lv.Level("PDH", 101.0, "day", 1), lv.Level("PWL", 97.0, "week", 2),
                         lv.Level("MA20", 99.0, "ma", 1), lv.Level("52WH", 120.0, "52w", 3)],
              "zones": [{"lo": 99, "hi": 99, "weight": 5, "members": ["MA20"], "side": "support", "big": True}]}
    got = session.marks(levels, CFG["levels"]["names"], CFG["levels"]["strong"], (100.5, 99.5))
    assert [(m.name, m.strong) for m in got] == [("PWL", True), ("MA20", True), ("PMKL", False), ("PMKH", False),
                                                 ("PDH", False)]


def test_the_session_clock_and_a_half_day():
    ck = session.clock("2026-10-19", CFG["day"])
    assert (ck.first_entry.strftime("%H:%M"), ck.last_entry.strftime("%H:%M"), ck.flatten.strftime("%H:%M")) == \
        ("10:00", "14:30", "15:10") and not ck.half_day
    half = session.clock("2026-11-27", CFG["day"])
    assert half.half_day and half.flatten.strftime("%H:%M") == "12:10" and half.close.strftime("%H:%M") == "13:00"


def test_the_move_left_shrinks_through_the_day():
    ck = session.clock("2026-10-19", CFG["day"])
    early = session.remaining_move(580, 0.15, ck.first_entry, ck)
    late = session.remaining_move(580, 0.15, ck.last_entry, ck)
    assert early > late > 0 and session.remaining_move(580, None, ck.first_entry, ck) is None


def test_events_close_entries():
    at = dt.datetime(2026, 10, 19, 14, 10, tzinfo=NEW_YORK)
    macro = [{"date": "2026-10-19", "time_et": "14:00", "type": "fomc_decision", "policy": "blackout_window"}]
    assert session.event_block(at, "SPY", macro, [], G, ["SPY", "QQQ"]) == "macro-blackout:fomc_decision"
    later = at.replace(hour=13, minute=40)
    assert session.event_block(later, "SPY", macro, [], G, ["SPY", "QQQ"]) is None
    assert session.event_block(later, "TSLA", macro, [], G, ["SPY", "QQQ"]) == "fomc-single-name"
    earn = [{"symbol": "TSLA", "date": "2026-10-16", "when": "amc"}]
    assert session.event_block(later, "TSLA", [], earn, G, ["SPY", "QQQ"]) == "earnings"
    assert session.event_block(later, "SPY", [], earn, G, ["SPY", "QQQ"]) is None


def test_the_real_earnings_calendar_blocks_a_name_on_its_report_day_and_the_day_after():
    from wt.live.runner_o import load_events
    macro, earnings = load_events()
    rows = {(r["symbol"], r["date"]) for r in earnings}
    assert ("TSLA", "2026-10-21") in rows and ("META", "2026-10-21") in rows
    assert all(r["when"] in ("bmo", "amc", "during") and r["quality"] in ("confirmed", "expected") for r in earnings)
    for day, blocked in (("2026-10-20", False), ("2026-10-21", True), ("2026-10-22", True), ("2026-10-23", False)):
        at = dt.datetime.fromisoformat(day + "T11:00").replace(tzinfo=NEW_YORK)
        for name in ("TSLA", "META"):
            assert (session.event_block(at, name, [], earnings, G, ["SPY", "QQQ"]) == "earnings") is blocked, (name, day)
        assert session.event_block(at, "SPY", [], earnings, G, ["SPY", "QQQ"]) is None


def test_missing_greeks_are_worked_out_from_the_mid_and_marked_modelled():
    raw = dict([snap(580, 1.10, 1.12, 0.52)])
    sym = next(iter(raw))
    del raw[sym]["greeks"], raw[sym]["impliedVolatility"]
    (q,) = chain.parse_snapshots(raw)
    assert q.delta is None and q.iv is None
    (m,) = chain.with_model([q], 580.4, 240)
    assert m.modelled and 0.4 < m.delta < 0.6 and 0.05 < m.iv < 1.0
    got = chain.pick([m], "SPY", "call", DAY, 580.4, NOW, C, {sym: 5000.0}, set(), late=False)
    assert got.quote is not None and got.quote.contract.strike == 580
    (same,) = chain.with_model([chain.parse_snapshots(dict([snap(580, 1.10, 1.12, 0.52)]))[0]], 580.4, 240)
    assert not same.modelled and same.delta == 0.52                     # a feed delta is kept as sent
