"""Stage 1 of the Options desk's selection (wt.options.select, DEC-0046).

Every bar here is synthetic: hand-built series, or a seeded random walk for the golden file. No real market data, no
result, ledger or journal is read. Expected numbers are worked out by hand in the comments beside them.
"""
from __future__ import annotations

import ast
import copy
import datetime as dt
import json
import math
import random
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

from wt.options import edition
from wt.options import levels as lv
from wt.options import select as sel
from wt.risk import events as ev

ROOT = Path(__file__).resolve().parents[2]
RECORD = ROOT / "research" / "decisions" / "DEC-0046-options-two-stage-selection.md"
FIXTURES = ROOT / "tests" / "fixtures" / "options_select"
P, SHA = sel.load_params()
REF = "s1-test"
D = "2026-11-11"                      # a Wednesday; the next session is Thursday 2026-11-12
BANNED = ("accuracy", "win rate", "edge", "outperform", "better")


# ---------------------------------------------------------------- builders

def sessions(end: str, n: int) -> list[str]:
    out: list[str] = []
    d = end
    while len(out) < n:
        if lv.is_session(d):
            out.append(d)
        d = (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat()
    return out[::-1]


def series(closes: list[float], end: str = D, rng: float = 1.0, vol: float = 1_000_000.0,
           ranges: dict[int, float] | None = None) -> list[dict[str, Any]]:
    """Bars ending on `end`, one per session, open = close, high = close + range, low = close - range."""
    days = sessions(end, len(closes))
    out = []
    for i, (d, c) in enumerate(zip(days, closes, strict=True)):
        r = (ranges or {}).get(i - len(closes), rng)
        out.append({"d": d, "o": c, "h": c + r, "l": c - r, "c": c, "v": vol})
    return out


def flat(n: int = 260, last: float | None = None, end: str = D, **kw: Any) -> list[dict[str, Any]]:
    closes = [100.0] * n
    if last is not None:
        closes[-1] = last
    return series(closes, end=end, **kw)


def bundle(bars: dict[str, Any], earnings: list[dict[str, str]] | None = None,
           macro: list[dict[str, str]] | None = None, session: str = D,
           names: list[str] | None = None) -> dict[str, Any]:
    return {"schema": sel.BUNDLE_SCHEMA, "version": sel.BUNDLE_VERSION, "session": session,
            "names": names if names is not None else list(bars), "bars": bars,
            "earnings_rows": earnings or [], "macro_rows": macro or []}


def run(bars: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return sel.run_bundle(bundle(bars, **kw), P, sha=SHA, ref=REF)


def row(out: dict[str, Any], sym: str) -> dict[str, Any]:
    return next(r for r in out["names"] if r["symbol"] == sym)


def er(sym: str, date: str, when: str, quality: str = "confirmed") -> dict[str, str]:
    return {"symbol": sym, "date": date, "when": when, "source": "synthetic", "quality": quality}


def mr(date: str, severity: str = "high", kind: str = "cpi") -> dict[str, str]:
    return {"date": date, "time_et": "08:30", "type": kind, "severity": severity, "policy": "reduce",
            "source": "synthetic", "quality": "exact"}


def base(**extra: Any) -> dict[str, Any]:
    """SPY and QQQ flat at 100, plus the names given."""
    return {"SPY": flat(), "QQQ": flat(), **extra}


def bars_of(raw: list[dict[str, Any]]) -> list[lv.Bar]:
    got = sel.parse_bars(raw)
    assert got is not None
    return got


# ---------------------------------------------------------------- the factors

# The series used for F1, F3 and F5: 259 bars at close 100 (high 101, low 99), then a last bar at 102 (103 / 101).
# True ranges: 2 on every bar but the last, whose TR = max(103 - 101, |103 - 100|, |101 - 100|) = 3.
# ATR14 = (13 x 2 + 3) / 14 = 29/14 = 2.071429; ATR% = (29/14) / 102.

def test_f1_on_a_hand_built_series():
    out = run(base(X=flat(last=102.0)))
    # ret(20) = 102 / 100 - 1 = 0.02. F1 = 0.02 / ((29/14 / 102) x sqrt(20)) = 28.56 / (29 x 4.472136) = 0.220214
    assert row(out, "X")["factors"]["F1"]["value"] == 0.220214
    assert row(out, "SPY")["factors"]["F1"]["value"] == 0.0          # ret(20) = 0


def test_f2_is_atr5_over_atr20():
    # The last five bars have high 102 and low 98 around a close of 100: TR 4. ATR5 = 4; ATR20 = (15 x 2 + 5 x 4) / 20
    # = 2.5; F2 = 4 / 2.5 = 1.6.
    out = run(base(X=flat(ranges={-1: 2.0, -2: 2.0, -3: 2.0, -4: 2.0, -5: 2.0})))
    assert row(out, "X")["factors"]["F2"]["value"] == 1.6
    assert row(out, "SPY")["factors"]["F2"]["value"] == 1.0          # 2 / 2


def test_f3_close_inside_a_zone_is_zero():
    # Flat at 100: PDC, MA20, MA50 and MA200 are all 100.0 and merge into one zone [100, 100] of weight 1+1+2+3 = 7.
    # The close (100) is inside it: d = 0, F3 = -0 / ATR14 = 0.
    out = run(base())
    assert row(out, "SPY")["factors"]["F3"]["value"] == 0.0
    assert row(out, "SPY")["f3_distance_atr"] == 0.0


def test_f3_on_the_engine_leaves_out_the_prior_close_zone():
    # Close 102. The engine's zones (levels_for for 2026-11-12): [99] weight 9 (PWL, PML, 52WL, WTDL), [100.01, 100.1]
    # weight 6 (MA200, MA50, MA20), [101] weight 6 (PDL, PWH, PMH), [102] weight 1 made only of PDC, [103] weight 5
    # (PDH, 52WH, WTDH). The PDC zone holds the close but is left out; the nearest qualifying bound is 101 or 103,
    # d = 1. F3 = -1 / (29/14) = -14/29 = -0.482759.
    window = bars_of(flat(last=102.0))
    zones = lv.levels_for(window, "2026-11-12")["zones"]
    pdc = [z for z in zones if z["members"] == ["PDC"]]
    assert len(pdc) == 1 and pdc[0]["lo"] == 102.0 and pdc[0]["weight"] == 1
    out = run(base(X=flat(last=102.0)))
    assert row(out, "X")["factors"]["F3"]["value"] == -0.482759
    assert row(out, "X")["f3_distance_atr"] == 0.482759


def zone(lo: float, hi: float, weight: int, members: list[str]) -> lv.Zone:
    return {"lo": lo, "hi": hi, "weight": weight, "members": members, "side": "", "big": weight >= 5}


def test_zone_distance_rules():
    # Nearest bound of the nearest qualifying zone: close 102, zone [104, 105] -> d = 2; zone [99, 100.5] -> 1.5.
    assert sel.zone_distance([zone(104, 105, 5, ["A"]), zone(99, 100.5, 6, ["B"])], 102.0, P) == 1.5
    # Inside a zone: 0.
    assert sel.zone_distance([zone(101, 103, 5, ["A"])], 102.0, P) == 0.0
    # On a bound: inside (lo <= close <= hi): 0.
    assert sel.zone_distance([zone(102, 103, 5, ["A"])], 102.0, P) == 0.0
    # Weight 4 is under the floor of 5: ignored. Weight exactly 5 qualifies.
    assert sel.zone_distance([zone(101, 101, 4, ["A"])], 102.0, P) is None
    assert sel.zone_distance([zone(101, 101, 5, ["A"])], 102.0, P) == 1.0
    # A zone made only of the prior close is ignored even at weight 5 (the engine gives PDC weight 1, so this can
    # only be built by hand); a zone where PDC sits with another level is not "only the prior close".
    assert sel.zone_distance([zone(102, 102, 5, ["PDC"]), zone(105, 105, 5, ["A"])], 102.0, P) == 3.0
    assert sel.zone_distance([zone(102, 102, 5, ["PDC", "MA20"])], 102.0, P) == 0.0
    assert sel.zone_distance([], 102.0, P) is None


def test_no_qualifying_zone_gives_no_zone(monkeypatch):
    real = lv.levels_for

    def no_big_zone(bars: list[lv.Bar], session: str) -> lv.LevelSet:
        got = real(bars, session)
        if bars[-1].c == 102.0:
            got["zones"] = [zone(z["lo"], z["hi"], 4, z["members"]) for z in got["zones"]]
        return got

    monkeypatch.setattr(lv, "levels_for", no_big_zone)
    out = run(base(X=flat(last=102.0)))
    x = row(out, "X")
    assert x["reason"] == "no_zone" and x["data_valid"] and x["factors"] is None and x["final_rank"] is None
    assert x["eligibility"] == "no_zone" and not x["eligible"]
    assert out["status"] == "ok"


def test_f3_hand_built_zone(monkeypatch):
    # Close 102, one zone [104, 105] of weight 5: d = 2, F3 = -2 / (29/14) = -28/29 = -0.965517.
    real = lv.levels_for

    def one_zone(bars: list[lv.Bar], session: str) -> lv.LevelSet:
        got = real(bars, session)
        if bars[-1].c == 102.0:
            got["zones"] = [zone(104.0, 105.0, 5, ["PWH", "PMH"])]
        return got

    monkeypatch.setattr(lv, "levels_for", one_zone)
    assert row(run(base(X=flat(last=102.0))), "X")["factors"]["F3"]["value"] == -0.965517


def test_f4_close_position():
    # high == low: c = 0.5, F4 = max(0.5, 0.5) = 0.5.
    out = run(base(X=flat(ranges={-1: 0.0})))
    assert row(out, "X")["factors"]["F4"]["value"] == 0.5
    # Last bar high 103, low 101, close 102.5: c = 1.5 / 2 = 0.75, F4 = 0.75.
    b = flat(last=102.0)
    b[-1]["c"] = 102.5
    assert row(run(base(X=b)), "X")["factors"]["F4"]["value"] == 0.75
    # Close 101.4: c = 0.4 / 2 = 0.2, F4 = max(0.2, 0.8) = 0.8.
    b[-1]["c"] = 101.4
    assert row(run(base(X=b)), "X")["factors"]["F4"]["value"] == 0.8


def test_f5_against_spy():
    # ret(5) = 102 / 100 - 1 = 0.02; SPY's ret(5) = 0. F5 = 0.02 / ((29/14 / 102) x sqrt(5)) = 28.56 / (29 x 2.236068)
    # = 0.440428.
    out = run(base(X=flat(last=102.0)))
    assert row(out, "X")["benchmark"] == "SPY"
    assert row(out, "X")["factors"]["F5"]["value"] == 0.440428


def test_f5_spy_is_measured_against_qqq():
    # SPY ends at 102 (the series above), QQQ at 101: SPY's ret(5) = 0.02, QQQ's = 0.01.
    # F5 = |0.02 - 0.01| / ((29/14 / 102) x sqrt(5)) = 0.220214.
    out = run({"SPY": flat(last=102.0), "QQQ": flat(last=101.0)})
    assert row(out, "SPY")["benchmark"] == "QQQ" and row(out, "QQQ")["benchmark"] == "SPY"
    assert row(out, "SPY")["factors"]["F5"]["value"] == 0.220214


# ---------------------------------------------------------------- validity

def test_exactly_260_bars_pass_and_259_fail():
    out = run(base(X=flat(260), Y=flat(259)))
    assert row(out, "X")["data_valid"] and row(out, "X")["reason"] is None
    assert row(out, "Y")["reason"] == "short_history" and not row(out, "Y")["data_valid"]


def test_more_than_260_bars_reads_the_last_260():
    # A split 300 bars back is outside the window: not suspect.
    closes = [50.0] * 40 + [100.0] * 260
    out = run(base(X=series(closes)))
    assert row(out, "X")["reason"] is None


def test_last_bar_not_dated_on_the_session_is_stale():
    out = run(base(X=flat(end=lv.prev_session(D)), Z=[]))
    assert row(out, "X")["reason"] == "stale_bar"
    assert row(out, "Z")["reason"] == "stale_bar"                    # no bars at all


def test_a_name_missing_from_the_bars_is_stale():
    out = run(base(), names=["SPY", "QQQ", "X"])
    assert row(out, "X")["reason"] == "stale_bar"


def test_duplicate_or_out_of_order_dates_are_bad_bars():
    dup = flat()
    dup[-2]["d"] = dup[-3]["d"]
    swapped = flat()
    swapped[-3], swapped[-2] = swapped[-2], swapped[-3]
    out = run(base(X=dup, Y=swapped))
    assert row(out, "X")["reason"] == "bad_bar" and row(out, "Y")["reason"] == "bad_bar"


def test_high_below_low_or_low_at_zero_is_a_bad_bar():
    hl = flat()
    hl[-10]["h"], hl[-10]["l"] = 99.0, 101.0
    zero = flat()
    zero[-10]["l"] = 0.0
    neg_vol = flat()
    neg_vol[-10]["v"] = -1.0
    text = flat()
    text[-10]["c"] = "100"
    equal = flat()
    equal[-10]["h"] = equal[-10]["l"] = 100.0                           # high == low > 0 is valid
    out = run(base(A=hl, B=zero, C=neg_vol, E=text, F=equal))
    assert [row(out, s)["reason"] for s in "ABCEF"] == ["bad_bar", "bad_bar", "bad_bar", "bad_bar", None]


def test_split_ratio_bounds_are_valid_and_just_outside_is_suspect():
    # Close-to-close ratio of two adjacent bars: 50 / 100 = 0.5 exactly and 100 / 50 = 2.0 exactly are not suspect
    # (DEC-0046 and the config: a ratio equal to a bound is valid). 49.99 / 100 = 0.4999 and 100.02 / 50 = 2.0004 are.
    def with_jump(a: float, b: float) -> list[dict[str, Any]]:
        return series([a] * 130 + [b] * 130)

    out = run(base(H=with_jump(100.0, 50.0), T=with_jump(50.0, 100.0),
                   LO=with_jump(100.0, 49.99), HI=with_jump(50.0, 100.02)))
    assert row(out, "H")["reason"] is None and row(out, "T")["reason"] is None
    assert row(out, "LO")["reason"] == "suspect_split" and row(out, "HI")["reason"] == "suspect_split"


def test_validity_order_first_failing_check_wins():
    b = flat(259, end=lv.prev_session(D))                                # stale and short: stale is checked first
    b[-5]["l"] = 0.0                                                     # and a bad bar, checked before both
    assert sel.validity(bars_of(b), D, P) == "bad_bar"
    assert sel.validity(bars_of(flat(259, end=lv.prev_session(D))), D, P) == "stale_bar"
    assert sel.validity(None, D, P) == "bad_bar"


# ---------------------------------------------------------------- ranking

def test_average_ranks():
    # Larger first. 3 and 3 share places 1 and 2: 1.5 each; 1 takes place 3.
    assert sel.average_ranks({"A": 3.0, "B": 3.0, "C": 1.0}) == {"A": 1.5, "B": 1.5, "C": 3.0}
    # Three equal: places 1, 2, 3 -> 2 each.
    assert sel.average_ranks({"A": 0.0, "B": 0.0, "C": 0.0}) == {"A": 2.0, "B": 2.0, "C": 2.0}
    assert sel.average_ranks({}) == {}


def test_ties_share_the_average_rank_in_the_output():
    out = run(base())                                    # SPY and QQQ identical: every factor tied
    for f in sel.FACTORS:
        assert row(out, "SPY")["factors"][f]["rank"] == row(out, "QQQ")["factors"][f]["rank"] == 1.5
    assert row(out, "SPY")["score"] == 7.5               # 5 x 1.5


def several() -> dict[str, Any]:
    """Five names whose factors differ."""
    return base(A=flat(last=102.0), B=flat(last=101.0), C=flat(last=98.0, ranges={-1: 0.0}),
                E=flat(ranges={-1: 2.0, -2: 2.0}))


def test_an_ineligible_name_keeps_its_place_in_every_ranking():
    plain = run(several())
    gapped = run(several(), earnings=[er("B", D, "amc")])
    assert row(gapped, "B")["eligibility"] == "earnings_gap" and not row(gapped, "B")["eligible"]
    for a, b in zip(plain["names"], gapped["names"], strict=True):
        assert a["symbol"] == b["symbol"]
        assert a["factors"] == b["factors"] and a["score"] == b["score"] and a["final_rank"] == b["final_rank"]
    assert "B" not in gapped["picks"]
    assert [s for s in plain["picks"] if s != "B"] == gapped["picks"][:len([s for s in plain["picks"] if s != "B"])]


def patched(monkeypatch, by_close: dict[float, tuple[dict[str, float], float, float]]) -> None:
    """Replace the factor arithmetic with given raw values, found by the name's last close."""
    def fake(window: list[lv.Bar], bench: Any, nxt: str, p: sel.Params) -> sel.Computed:
        f, dist, dv = by_close[window[-1].c]
        return sel.Computed(dict(f), dist, dv, {})
    monkeypatch.setattr(sel, "factors", fake)


def same(v: float) -> dict[str, float]:
    return {f: v for f in sel.FACTORS}


def test_tie_break_chain_each_level_in_turn(monkeypatch):
    # Four names with equal factors (score 2.5 x 5 = 12.5 each).
    # Level 1, F3 distance: W 0.1 before the rest at 0.2.
    # Level 2, median dollar volume: among the 0.2s, X (9e6) before Y and Z (5e6).
    # Level 3, symbol: Y before Z.
    patched(monkeypatch, {101.0: (same(1.0), 0.2, 5e6), 102.0: (same(1.0), 0.2, 5e6),
                          103.0: (same(1.0), 0.2, 9e6), 104.0: (same(1.0), 0.1, 1e6)})
    out = run({"Z": flat(last=101.0), "Y": flat(last=102.0), "X": flat(last=103.0), "W": flat(last=104.0)})
    assert [r["symbol"] for r in out["names"]] == ["W", "X", "Y", "Z"]
    assert [r["final_rank"] for r in out["names"]] == [1, 2, 3, 4]
    assert {r["score"] for r in out["names"]} == {12.5}


def test_score_orders_before_the_tie_break(monkeypatch):
    # A ranks first on every factor (score 5), B second (10): B's smaller F3 distance does not lift it.
    patched(monkeypatch, {101.0: (same(2.0), 0.9, 1.0), 102.0: (same(1.0), 0.0, 1.0)})
    out = run({"A": flat(last=101.0), "B": flat(last=102.0)})
    assert [(r["symbol"], r["score"]) for r in out["names"]] == [("A", 5.0), ("B", 10.0)]


def test_rounding_to_six_decimals_decides_a_near_tie(monkeypatch):
    # Unrounded, A's F1 (0.1234564) is above B's (0.1234561) and A would rank first. Rounded to 6 decimals both are
    # 0.123456: a tie at 1.5 each. Every other factor is equal, so the scores tie and the F3 distance decides: B.
    fa = same(1.0) | {"F1": 0.1234564}
    fb = same(1.0) | {"F1": 0.1234561}
    patched(monkeypatch, {101.0: (fa, 0.3, 1.0), 102.0: (fb, 0.2, 1.0)})
    out = run({"A": flat(last=101.0), "B": flat(last=102.0)})
    assert row(out, "A")["factors"]["F1"] == row(out, "B")["factors"]["F1"] == {"value": 0.123456, "rank": 1.5}
    assert [r["symbol"] for r in out["names"]] == ["B", "A"]
    # The distance is rounded too: 0.2000004 and 0.2000001 tie, and the symbol decides.
    patched(monkeypatch, {101.0: (same(1.0), 0.2000004, 1.0), 102.0: (same(1.0), 0.2000001, 1.0)})
    out = run({"B": flat(last=101.0), "A": flat(last=102.0)})
    assert [r["symbol"] for r in out["names"]] == ["A", "B"]


# ---------------------------------------------------------------- events (R4)

def flags(out: dict[str, Any], sym: str) -> tuple[str, list[str]]:
    r = row(out, sym)
    return r["eligibility"], r["cautions"]


def test_earnings_window_on_an_ordinary_night():
    # D = Wednesday 2026-11-11, next session Thursday 2026-11-12. The window runs from after the close of D to the
    # close of the next session: D amc, next bmo, next during are in it; D bmo / during were before the close of D.
    names = {s: flat() for s in ("A", "B", "C", "E", "F", "G", "H", "I")}
    rows = [er("A", D, "amc"), er("B", "2026-11-12", "bmo"), er("C", "2026-11-12", "during"),
            er("E", "2026-11-12", "amc"),              # after the next close: later, a caution
            er("F", "2026-11-18", "bmo"),              # next session + 6 calendar days: still a caution
            er("G", "2026-11-19", "bmo"),              # + 7: outside, no mark
            er("H", D, "bmo"), er("I", D, "during")]   # already out before the close of D: no mark
    out = run(base(**names), earnings=rows)
    assert [flags(out, s)[0] for s in "ABC"] == ["earnings_gap"] * 3
    assert flags(out, "E") == ("eligible", ["earnings_later"])
    assert flags(out, "F") == ("eligible", ["earnings_later"])
    assert flags(out, "G") == ("eligible", [])
    assert flags(out, "H")[0] == "eligible" and flags(out, "I")[0] == "eligible"


def test_earnings_across_a_holiday_and_onto_a_half_day():
    # D = Wednesday 2026-11-25. Thursday 26 is Thanksgiving (closed), so the next session is Friday 27, a half day:
    # taken from the session calendar, not the clock. A report dated on the holiday is inside the window.
    d = "2026-11-25"
    names = {s: flat(end=d) for s in ("A", "B", "C", "E")}
    rows = [er("A", "2026-11-26", "bmo"), er("B", "2026-11-27", "during"), er("C", "2026-11-27", "amc"),
            er("E", d, "amc")]
    out = run({"SPY": flat(end=d), "QQQ": flat(end=d), **names}, earnings=rows, session=d)
    assert out["next_session"] == "2026-11-27"
    assert [flags(out, s)[0] for s in "ABE"] == ["earnings_gap"] * 3
    assert flags(out, "C") == ("eligible", ["earnings_later"])
    assert {"code": "next_session_half_day"} in out["market_notes"]


def test_friday_night_reaches_monday():
    # D = Friday 2026-11-13; next session Monday 16. A Saturday-dated row and Monday bmo are in the window.
    d = "2026-11-13"
    out = run({"SPY": flat(end=d), "QQQ": flat(end=d), "A": flat(end=d), "B": flat(end=d)},
              earnings=[er("A", "2026-11-14", "bmo"), er("B", "2026-11-16", "bmo")], session=d)
    assert out["next_session"] == "2026-11-16" and flags(out, "A")[0] == flags(out, "B")[0] == "earnings_gap"
    assert not any(n["code"] == "next_session_half_day" for n in out["market_notes"])


def test_an_expected_date_counts_as_a_date():
    out = run(base(A=flat()), earnings=[er("A", "2026-11-12", "bmo", quality="expected")])
    assert flags(out, "A")[0] == "earnings_gap"


def test_unknown_date_inside_the_expected_window_is_a_caution():
    # events.earnings_gaps with 75 days: a last row on 2026-08-27 is 76 days before D (stale); 2026-08-28 is exactly
    # 75 days (not stale). No row at all is unknown. SPY and QQQ report no earnings: never marked.
    rows = [er("A", "2026-08-27", "amc"), er("B", "2026-08-28", "amc")]
    out = run(base(A=flat(), B=flat(), C=flat()), earnings=rows)
    assert flags(out, "A") == ("eligible", ["earnings_date_unknown"])
    assert flags(out, "B") == ("eligible", [])
    assert flags(out, "C") == ("eligible", ["earnings_date_unknown"])
    assert flags(out, "SPY") == ("eligible", []) and flags(out, "QQQ") == ("eligible", [])


def test_a_malformed_earnings_row_is_counted_and_marks_its_name():
    bad = er("A", "2026-11-12", "bmo") | {"when": "soon"}
    out = run(base(A=flat()), earnings=[bad, er("A", "2026-12-01", "amc")])
    assert flags(out, "A") == ("eligible", ["earnings_row_unreadable"])
    assert out["unreadable_event_rows"] == {"earnings_rows": 1, "macro_rows": 0}


def test_high_macro_on_the_next_session_is_a_market_note_only():
    rows = [mr("2026-11-12", "high", "cpi"), mr("2026-11-12", "high", "fomc_decision"), mr("2026-11-12", "medium",
            "fomc_minutes"), mr(D, "high", "nfp"), {"date": "2026-11-12"}]
    out = run(base(), macro=rows)
    assert out["market_notes"] == [{"code": "macro_high_next_session", "types": ["cpi", "fomc_decision"]}]
    assert out["unreadable_event_rows"]["macro_rows"] == 1
    assert all(r["eligible"] for r in out["names"])
    assert run(base(), macro=[mr("2026-11-12", "medium")])["market_notes"] == []


# ---------------------------------------------------------------- missing data (R5)

def test_benchmark_missing():
    out = run({"QQQ": flat(), "A": flat()})                            # no SPY
    assert row(out, "A")["reason"] == "benchmark_missing" and row(out, "A")["data_valid"]
    assert row(out, "QQQ")["reason"] == "benchmark_missing"
    assert out["counts"] == {"names": 2, "data_valid": 2, "ranked": 0, "eligible": 0, "picked": 0}
    out = run({"SPY": flat(259), "QQQ": flat(), "A": flat()})           # SPY's bars not valid
    assert row(out, "A")["reason"] == "benchmark_missing" and row(out, "SPY")["reason"] == "short_history"
    assert row(out, "SPY")["factors"] is None                          # never defaulted


def test_the_benchmark_is_used_whatever_its_own_eligibility(monkeypatch):
    # SPY has an earnings row in the window (ineligible) and, in the second run, no zone: its bars are valid, so A's
    # F5 is still worked out from SPY's ret(5).
    out = run(base(A=flat(last=102.0)), earnings=[er("SPY", "2026-11-12", "bmo")])
    assert row(out, "SPY")["eligibility"] == "earnings_gap"
    assert row(out, "A")["factors"]["F5"]["value"] == 0.440428
    real = lv.levels_for

    def spy_no_zone(bars: list[lv.Bar], session: str) -> lv.LevelSet:
        got = real(bars, session)
        if bars[-1].c == 100.0:
            got["zones"] = []
        return got

    monkeypatch.setattr(lv, "levels_for", spy_no_zone)
    out = run({"SPY": flat(), "QQQ": flat(last=101.0), "A": flat(last=102.0)})
    assert row(out, "SPY")["reason"] == "no_zone"
    assert row(out, "A")["factors"]["F5"]["value"] == 0.440428


# ---------------------------------------------------------------- never fill (R6)

@pytest.mark.parametrize("eligible", [12, 5, 4, 3, 1, 0])
def test_never_fill(eligible: int):
    syms = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "PLTR", "AVGO", "AMD"]
    bars = {s: flat(last=100.0 + i * 0.25) for i, s in enumerate(syms)}
    gap = [er(s, D, "amc") for s in syms[eligible:]]
    out = run(bars, earnings=gap)
    assert out["counts"]["ranked"] == 12 and out["counts"]["eligible"] == eligible
    assert out["counts"]["picked"] == len(out["picks"]) == min(4, eligible)
    assert all(row(out, s)["eligible"] for s in out["picks"])
    ranked = [r["symbol"] for r in out["names"] if r["eligible"]]
    assert out["picks"] == ranked[:min(4, eligible)]
    assert out["selection_note"] == (None if eligible else "No selection tonight: data incomplete")
    assert [r["picked"] for r in out["names"]].count(True) == min(4, eligible)


def test_no_valid_name_is_no_selection():
    out = run({"SPY": flat(259), "QQQ": []})
    assert out["picks"] == [] and out["selection_note"] == P.no_selection_text
    assert out["counts"] == {"names": 2, "data_valid": 0, "ranked": 0, "eligible": 0, "picked": 0}


# ---------------------------------------------------------------- determinism and isolation

def test_shuffled_input_gives_byte_identical_output():
    b = several()
    rows = [er("B", D, "amc"), er("A", "2026-11-13", "bmo"), er("C", "2026-08-01", "amc")]
    macro = [mr("2026-11-12", "high", "cpi"), mr("2026-11-12", "high", "nfp")]
    first = sel.dumps(run(b, earnings=rows, macro=macro))
    rnd = random.Random(7)
    for _ in range(5):
        keys = list(b)
        rnd.shuffle(keys)
        rows2, macro2 = rows[:], macro[:]
        rnd.shuffle(rows2)
        rnd.shuffle(macro2)
        again = sel.dumps(run({k: copy.deepcopy(b[k]) for k in keys}, earnings=rows2, macro=macro2))
        assert again == first


def test_an_exception_in_one_name_does_not_fail_the_others(monkeypatch):
    real = lv.levels_for

    def boom(bars: list[lv.Bar], session: str) -> lv.LevelSet:
        if bars[-1].c == 101.0:
            raise RuntimeError("synthetic failure with text that must not be copied")
        return real(bars, session)

    monkeypatch.setattr(lv, "levels_for", boom)
    out = run(several())
    b = row(out, "B")
    assert b["reason"] == "internal_error" and b["error_class"] == "RuntimeError" and b["final_rank"] is None
    assert "synthetic failure" not in sel.dumps(out)
    assert out["status"] == "internal_error"
    assert out["counts"]["ranked"] == 5 and all(row(out, s)["final_rank"] for s in ("A", "C", "E", "SPY", "QQQ"))
    monkeypatch.undo()
    assert run(several())["status"] == "ok"


def test_an_exception_while_reading_bars_is_isolated_too(monkeypatch):
    real = sel.parse_bars

    def boom(raw: Any) -> list[lv.Bar] | None:
        if raw and raw[-1]["c"] == 101.0:
            raise KeyError("x")
        return real(raw)

    monkeypatch.setattr(sel, "parse_bars", boom)
    out = run(several())
    assert row(out, "B")["reason"] == "internal_error" and row(out, "B")["error_class"] == "KeyError"
    assert not row(out, "B")["data_valid"] and out["status"] == "internal_error"


# ---------------------------------------------------------------- parameters and the record

def record_sha() -> str:
    found = re.findall(r"`params_sha`[^`]*`([0-9a-f]{64})`", RECORD.read_text())
    assert len(set(found)) == 1, "DEC-0046 must name exactly one params_sha"
    return found[0]


def test_the_config_hash_is_the_one_dec_0046_names():
    assert sel.load_params()[1] == record_sha()


def test_the_hash_is_canonical_and_moves_with_any_value():
    cfg = yaml.safe_load((ROOT / "config" / "options_select.yaml").read_text())
    assert sel.params_sha(cfg) == SHA
    reordered = dict(reversed(list(cfg.items())))
    assert sel.params_sha(reordered) == SHA                             # key order does not count
    changed = copy.deepcopy(cfg)
    changed["zones"]["weight_floor"] = 6
    assert sel.params_sha(changed) != SHA
    assert sel.canonical_json({"b": 2.0, "a": 1}) == '{"a":1,"b":2.0}'


def test_the_config_holds_only_what_the_code_implements():
    cfg = yaml.safe_load((ROOT / "config" / "options_select.yaml").read_text())
    for path, value in ((("split_suspect", "bound_is_suspect"), True), (("tie_break",), ["symbol_a_to_z"]),
                        (("reason_codes",), ["stale_bar"]), (("history", "min_bars"), 20), (("extra",), 1)):
        bad = copy.deepcopy(cfg)
        node = bad
        for k in path[:-1]:
            node = node[k]
        node[path[-1]] = value
        with pytest.raises(sel.ParamsError):
            sel.params_from_mapping(bad)


def test_the_config_agrees_with_the_record_the_repo_and_the_code():
    assert (P.min_bars, P.f1_return, P.f5_return, P.atr, P.atr_fast, P.atr_slow) == (260, 20, 5, 14, 5, 20)
    assert (P.zone_weight_floor, P.split_low, P.split_high, P.decimals, P.pick_count) == (5, 0.5, 2.0, 6, 4)
    assert P.benchmark("SPY") == "QQQ" and P.benchmark("QQQ") == "SPY" and P.benchmark("AAPL") == "SPY"
    assert P.earnings_later_days == edition.EVENT_DAYS
    assert P.earnings_unknown_after_days == ev.EARNINGS_MAX_AGE_DAYS
    clone = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
    assert list(P.index_names) == clone["contract"]["index_names"]
    desk = yaml.safe_load((ROOT / "config" / "options_desk.yaml").read_text())["names"]
    assert len(desk) == 12 and P.benchmark_default in desk and set(P.benchmark_when.values()) <= set(desk)
    text = RECORD.read_text()
    for code in sel.REASON_CODES + sel.ELIGIBILITY_CODES + sel.CAUTION_CODES + sel.NOTE_CODES:
        assert f"`{code}`" in text, code
    for n in desk:
        assert n in text


def test_picker_ref_is_a_code_hash_not_a_clock():
    ref = sel.picker_ref()
    assert re.fullmatch(r"s1-[0-9a-f]{12}", ref) and ref == sel.picker_ref()


# ---------------------------------------------------------------- the CLI and the golden files

GOLDEN_NAMES = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "AMD"]


def golden_bundle() -> dict[str, Any]:
    """The golden input: a seeded random walk per name, prices in cents. Written to the fixture file once; the test
    below proves the file is this function's output."""
    rnd = random.Random(20261111)
    days = sessions(D, 270)
    bars: dict[str, Any] = {}
    for i, s in enumerate(GOLDEN_NAMES):
        c = 100.0 + 40 * i
        out = []
        for d in days:
            o = round(c * (1 + rnd.gauss(0, 0.004)), 2)
            c = round(c * (1 + rnd.gauss(0.0004, 0.016)), 2)
            h = round(max(o, c) * (1 + abs(rnd.gauss(0, 0.006))), 2)
            low = round(min(o, c) * (1 - abs(rnd.gauss(0, 0.006))), 2)
            out.append({"d": d, "o": o, "h": h, "l": low, "c": c, "v": int(5e6 + rnd.random() * 5e6)})
        bars[s] = out
    bars["AMD"] = bars["AMD"][:-1]                                       # one stale name
    return bundle(bars, earnings=[er("TSLA", "2026-11-12", "bmo"), er("AAPL", "2026-11-16", "amc"),
                                  er("NVDA", "2026-11-19", "amc"), er("AMD", "2026-11-04", "amc")],
                  macro=[mr("2026-11-12", "high", "cpi")])


def test_the_golden_bundle_is_the_generator_output():
    assert json.loads((FIXTURES / "stage1_bundle.json").read_text()) == golden_bundle()


def test_cli_round_trip_matches_the_golden_output(tmp_path):
    out = tmp_path / "out.json"
    assert sel.main(["stage1", "--bundle", str(FIXTURES / "stage1_bundle.json"), "--out", str(out)]) == 0
    got = json.loads(out.read_text())
    want = json.loads((FIXTURES / "stage1_output.json").read_text())
    assert got["picker_ref"] == sel.picker_ref() and got["params_sha"] == SHA
    for doc in (got, want):
        doc["picker_ref"] = "s1-golden"
    assert got == want
    assert sel.dumps(got) == (FIXTURES / "stage1_output.json").read_text()
    # What the golden night shows: AMD stale; SPY valid but with no zone of weight 5 near it (no_zone, from the real
    # engine), and its return still used as the others' benchmark; TSLA ranked but out on earnings; three eligible,
    # so three picks, never filled to four.
    assert row(got, "AMD")["reason"] == "stale_bar"
    assert row(got, "SPY")["reason"] == "no_zone" and row(got, "SPY")["data_valid"]
    assert all(row(got, s)["factors"] is not None for s in ("QQQ", "AAPL", "NVDA", "TSLA"))
    assert row(got, "TSLA")["eligibility"] == "earnings_gap" and row(got, "TSLA")["final_rank"] == 3
    assert row(got, "AAPL")["cautions"] == ["earnings_later"]
    assert got["counts"] == {"names": 6, "data_valid": 5, "ranked": 4, "eligible": 3, "picked": 3}
    assert got["picks"] == ["NVDA", "QQQ", "AAPL"]
    assert got["market_notes"] == [{"code": "macro_high_next_session", "types": ["cpi"]}]


def test_cli_refuses_a_bad_bundle(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(bundle(base()) | {"session": "2026-11-14"}))     # a Saturday
    assert sel.main(["stage1", "--bundle", str(bad), "--out", str(tmp_path / "o.json")]) == 2
    assert not (tmp_path / "o.json").exists()
    for broken in ({"schema": "x"}, bundle(base()) | {"names": ["spy"]}, bundle(base()) | {"extra": 1}, []):
        with pytest.raises(sel.BundleError):
            sel.check_bundle(broken)


def test_cli_exit_code_marks_an_internal_error(tmp_path, monkeypatch):
    path = tmp_path / "b.json"
    path.write_text(json.dumps(bundle(several())))
    real = lv.levels_for

    def boom(bars: list[lv.Bar], session: str) -> lv.LevelSet:
        if bars[-1].c == 101.0:
            raise ValueError("synthetic")
        return real(bars, session)

    monkeypatch.setattr(lv, "levels_for", boom)
    assert sel.main(["stage1", "--bundle", str(path), "--out", str(tmp_path / "o.json")]) == 1
    assert json.loads((tmp_path / "o.json").read_text())["status"] == "internal_error"


# ---------------------------------------------------------------- copy guard

def _keys(obj: Any) -> set[str]:
    if isinstance(obj, dict):
        return set(obj) | {k for v in obj.values() for k in _keys(v)}
    if isinstance(obj, list):
        return {k for v in obj for k in _keys(v)}
    return set()


def _banned(text: str) -> list[str]:
    low = text.lower().replace("_", " ")
    return [w for w in BANNED if re.search(rf"\b{w}\b", low)]


def test_no_claim_of_skill_in_the_module_the_output_or_the_config():
    tree = ast.parse((ROOT / "src" / "wt" / "options" / "select.py").read_text())
    docs = [ast.get_docstring(n) or "" for n in ast.walk(tree)
            if isinstance(n, ast.Module | ast.FunctionDef | ast.ClassDef)]
    assert not [d for d in docs if _banned(d)]
    out = json.loads((FIXTURES / "stage1_output.json").read_text())
    assert not [k for k in _keys(out) if _banned(k)]
    assert not _banned(P.no_selection_text)
    assert not _banned((ROOT / "config" / "options_select.yaml").read_text())


def opening_lines() -> str:
    text = RECORD.read_text()
    return text[:text.index("\n## ")]


def test_the_record_opens_with_the_governing_principle_and_claims_no_skill():
    head = " ".join(opening_lines().split())
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", head) if _banned(s)]
    # The only sentences that may carry these words: that passing the gate is NOT evidence the selection is better,
    # and that accuracy is claimed only by the registered experiment.
    assert len(sentences) == 2, sentences
    better, accuracy = sentences
    assert _banned(better) == ["better"] and "not evidence" in better
    assert _banned(accuracy) == ["accuracy"] and "only by the registered forward experiment" in accuracy
    assert "five-session" in head and "operational release gate" in head and "never a claim of skill" in head


def test_math_helpers_match_the_factor_definitions():
    # ret(k) is close over the close k bars before, minus 1: 102 / 100 - 1.
    w = bars_of(flat(last=102.0))
    assert math.isclose(sel.ret(w, 20), 0.02) and math.isclose(sel.ret(w, 5), 0.02)
    assert math.isclose(lv.atr(w, 14), 29 / 14)
