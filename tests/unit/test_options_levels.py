"""The Options desk's levels engine and the probation rules' replay (wt.options.levels, wt.options.rules).

Every bar here is synthetic and seeded: real pulls never enter this repository. Agreement with the code the
after-close routine ran before it moved here was checked outside the repo on the same generator (240 level sets,
438 rule triggers, no difference); the golden values below pin that behaviour from now on.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import random

import pytest

from wt.options import levels as lv
from wt.options import rules


def sessions(end: str, n: int) -> list[str]:
    out: list[str] = []
    d = end
    while len(out) < n:
        if lv.is_session(d):
            out.append(d)
        d = (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat()
    return out[::-1]


def synth(seed: int, n: int = 320, end: str = "2026-10-09", start: float = 100.0) -> dict[str, list]:
    """An IBKR-shaped daily history: a random walk with the odd wide day and the odd close outside the range.

    The noise is a sum of uniforms, so it is plain arithmetic and the same on every machine: the fingerprint
    below must not depend on a maths library's last digit."""
    rng = random.Random(seed)

    def noise(scale: float) -> float:
        return (rng.random() + rng.random() + rng.random() - 1.5) * 2 * scale

    raw: dict[str, list] = {"time": [], "open": [], "high": [], "low": [], "close": [], "volume": []}
    px = start
    for d in sessions(end, n):
        o = px * (1 + noise(0.004))
        c = o * (1 + 0.0003 + noise(0.012 * (3 if rng.random() < 0.04 else 1)))
        h = max(o, c) * (1 + abs(noise(0.004)))
        low = min(o, c) * (1 - abs(noise(0.004)))
        if rng.random() < 0.02:
            h = max(o, c) - 0.01
        for k, v in zip(("time", "open", "high", "low", "close", "volume"), (d + "T00:00:00", o, h, low, c, 1e6), strict=True):
            raw[k].append(v)
        px = c
    return raw


def bars(seed: int = 1, **kw) -> list[lv.Bar]:
    return lv.load_ibkr(synth(seed, **kw)).bars


def flat(n: int = 40, end: str = "2026-10-09", px: float = 100.0, rng: float = 1.0) -> list[lv.Bar]:
    """Identical quiet days: every level is known by hand."""
    return [lv.Bar(d, px, px + rng / 2, px - rng / 2, px) for d in sessions(end, n)]


# ---- calendar

def test_sessions_skip_weekends_and_holidays_and_the_calendar_refuses_what_it_does_not_cover():
    assert lv.is_session("2026-10-09") and not lv.is_session("2026-10-10") and not lv.is_session("2026-11-26")
    assert lv.next_session("2026-10-09") == "2026-10-12" and lv.prev_session("2026-10-12") == "2026-10-09"
    assert lv.next_session("2026-04-02") == "2026-04-06"          # over Good Friday
    assert lv.next_session("2026-12-31") == "2027-01-04"          # over New Year's Day and a weekend
    with pytest.raises(ValueError, match="calendar only covers"):
        lv.is_session("2028-01-03")
    assert all(dt.date.fromisoformat(d).weekday() < 5 for d in lv.HOLIDAYS | lv.HALF_DAYS)
    assert not (lv.HOLIDAYS & lv.HALF_DAYS)


def test_a_close_is_final_fifteen_minutes_after_the_bell_in_either_season_and_on_a_half_day():
    assert lv.close_final_utc("2026-10-09") == dt.datetime(2026, 10, 9, 20, 15)      # daylight time
    assert lv.close_final_utc("2026-12-01") == dt.datetime(2026, 12, 1, 21, 15)      # standard time
    assert lv.close_final_utc("2026-11-27") == dt.datetime(2026, 11, 27, 18, 15)     # 13:00 close
    assert lv.close_final_utc("2026-11-02") == dt.datetime(2026, 11, 2, 21, 15)      # the day after the clocks go back
    assert lv.close_final_utc("2027-03-15") == dt.datetime(2027, 3, 15, 20, 15)      # the day after they go forward


# ---- loading

def test_a_clean_history_loads_with_nothing_to_report_and_metadata_is_ignored():
    raw = {**synth(3), "chart_start": "nonsense", "chart_end": "nonsense"}
    got = lv.load_ibkr(raw, since="2026-01-01")
    assert got.problems == [] and got.dropped_partial is None
    assert got.bars[0].d >= "2026-01-01" and got.bars[-1].d == "2026-10-09"
    assert [b.d for b in got.bars] == sorted(b.d for b in got.bars)


def test_a_close_outside_the_range_widens_the_bar_and_never_drops_it():
    raw = synth(3)
    i = len(raw["time"]) - 5
    raw["high"][i] = raw["close"][i] - 0.02
    got = lv.load_ibkr(raw)
    b = next(x for x in got.bars if x.d == raw["time"][i][:10])
    assert b.d in got.widened and b.h == max(raw["open"][i], raw["close"][i]) and b.l <= min(b.o, b.c)


def test_an_unfinished_session_is_dropped_until_its_close_is_final():
    raw = synth(3)
    before = lv.load_ibkr(raw, now_utc=dt.datetime(2026, 10, 9, 20, 14))
    assert before.dropped_partial == "2026-10-09" and before.bars[-1].d == "2026-10-08"
    after = lv.load_ibkr(raw, now_utc=dt.datetime(2026, 10, 9, 20, 15))
    assert after.dropped_partial is None and after.bars[-1].d == "2026-10-09"


def test_what_should_stop_a_run_is_named():
    assert lv.load_ibkr({"time": []}).problems == ["result has no OHLC arrays"]
    short = synth(3)
    short["close"] = short["close"][:-1]
    assert lv.load_ibkr(short).problems == ["OHLC arrays have different lengths"]
    raw = synth(3)
    n = len(raw["time"])
    for k in raw:
        del raw[k][n - 10]                                           # a missing session
    raw["time"][n - 20] = "2026-09-12T00:00:00"                      # a Saturday
    raw["open"][n - 30] = -1                                         # a price that is not one
    for k in ("open", "high", "low", "close"):                       # a 2:1 split three bars from the end
        raw[k][-3:] = [v / 2 for v in raw[k][-3:]]
    problems = " | ".join(lv.load_ibkr(raw).problems)
    for want in ("missing session(s) between", "bar on a non-trading day", "non-positive or missing price", "split"):
        assert want in problems, want
    dup = synth(3)
    for k in dup:
        dup[k].append(dup[k][-1])
    assert any("duplicate bar" in p for p in lv.load_ibkr(dup).problems)


# ---- levels

def test_levels_for_a_quiet_history_are_what_arithmetic_says():
    got = lv.levels_for(flat(), "2026-10-12")
    by = {x.name: x for x in got["levels"]}
    assert (by["PDH"].price, by["PDL"].price, by["PDC"].price) == (100.5, 99.5, 100.0)
    assert by["PWH"].price == 100.5 and by["PML"].price == 99.5 and by["52WH"].price == 100.5
    assert by["MA20"].price == pytest.approx(100.0) and "MA50" not in by and "WTDH" not in by      # Monday; 40 bars
    assert got["atr14"] == pytest.approx(1.0) and got["from_bar"] == "2026-10-09"
    assert got["close_strength"] == {"pos": 0.5, "chip": "MID"}
    assert got["prev_week"] == ["2026-10-05", "2026-10-09"] and got["prev_month"] == "2026-09"
    assert not got["half_day"] and lv.levels_for(flat(end="2026-11-25"), "2026-11-27")["half_day"]


def test_levels_use_only_bars_before_the_session_and_refuse_stale_or_thin_history():
    hist = bars(5)
    want = lv.levels_for(hist, "2026-10-09")
    poisoned = [*hist[:-1], lv.Bar("2026-10-09", 9e6, 9e6, 1e-6, 9e6)]
    assert lv.levels_for(poisoned, "2026-10-09") == want                 # the session's own bar is never read
    with pytest.raises(ValueError, match="bars are stale"):
        lv.levels_for(hist, "2026-10-14")
    with pytest.raises(ValueError, match="at least 30"):
        lv.levels_for(hist[-20:], "2026-10-12")


def test_week_and_month_levels_roll_on_the_right_bar():
    hist = bars(7, end="2026-12-31", n=330)
    wed = lv.levels_for([b for b in hist if b.d < "2026-10-07"], "2026-10-07")
    names = {x.name for x in wed["levels"]}
    assert {"WTDH", "WTDL"} <= names and wed["prev_week"] == ["2026-09-28", "2026-10-02"]
    mon = lv.levels_for([b for b in hist if b.d < "2026-10-05"], "2026-10-05")
    assert "WTDH" not in {x.name for x in mon["levels"]}
    first = lv.levels_for([b for b in hist if b.d < "2026-10-01"], "2026-10-01")
    assert first["prev_month"] == "2026-09"
    # The short Thanksgiving week is one week: Friday's half day still belongs to it.
    fri = lv.levels_for([b for b in hist if b.d < "2026-11-27"], "2026-11-27")
    assert fri["prev_week"] == ["2026-11-16", "2026-11-20"] and fri["half_day"]
    # ISO week 53 of 2026 runs into January: for the first full week of 2027 it is the previous week, whole.
    hist27 = bars(7, end="2027-01-08", n=330)
    jan = lv.levels_for([b for b in hist27 if b.d < "2027-01-04"], "2027-01-04")
    assert jan["prev_week"] == ["2026-12-28", "2026-12-31"] and jan["prev_month"] == "2026-12"


@pytest.mark.parametrize("seed", range(12))
def test_zones_come_in_order_and_account_for_every_level(seed):
    """Zones are not disjoint: a level inside an earlier supply or demand band opens a zone of its own, because
    merging compares lows only. That is the engine as it has always run; this test does not claim otherwise."""
    got = lv.levels_for(bars(seed), "2026-10-12")
    zones = got["zones"]
    assert sum(len(z["members"]) for z in zones) == len(got["levels"])
    assert sum(z["weight"] for z in zones) == sum(x.weight for x in got["levels"])
    for z in zones:
        assert z["lo"] <= z["hi"] and z["big"] == (z["weight"] >= 5)
        assert z["side"] == ("support" if (z["lo"] + z["hi"]) / 2 < got["last"]["close"] else "resistance")
    for a, b in zip(zones, zones[1:], strict=False):
        assert a["lo"] <= b["lo"]                                       # in order from the lowest
    for x in got["levels"]:
        if x.tf == "sd":
            assert x.lo is not None and x.hi is not None and x.lo < x.hi and x.lo <= x.price <= x.hi


def test_zones_merge_from_their_lowest_member_without_chaining():
    mk = lambda name, price, w=1: lv.Level(name, price, "day", w)          # noqa: E731
    # 100.0, 100.4 and 100.8 are each within 0.5% of the next, but 100.8 is not within 0.5% of 100.0.
    zones = lv.merge_zones([mk("A", 100.0), mk("B", 100.4), mk("C", 100.8), mk("D", 103.0, 5)], ref=101.0)
    assert [(z["members"], z["weight"]) for z in zones] == [(["A", "B"], 2), (["C"], 1), (["D"], 5)]
    assert [z["side"] for z in zones] == ["support", "support", "resistance"] and [z["big"] for z in zones] == [False, False, True]
    band = lv.Level("DEMAND", 99.5, "sd", 2, lo=99.0, hi=100.0)
    (z,) = lv.merge_zones([band, mk("PDL", 99.2)], ref=101.0)
    assert (z["lo"], z["hi"], z["weight"]) == (99.0, 100.0, 3)


def test_a_demand_zone_is_the_quiet_base_before_a_strong_day_until_a_close_breaks_it():
    hist = flat(40)
    strong = lv.Bar(hist[-3].d, 100.0, 104.0, 99.9, 103.9)                 # four times the usual range, closing on its high
    after = [lv.Bar(b.d, 104.0, 104.5, 103.5, 104.0) for b in hist[-2:]]
    zones = lv.supply_demand([*hist[:-3], strong, *after])
    assert [(x.name, x.lo, x.hi) for x in zones] == [("DEMAND", 99.5, 100.5)]
    broken = [*hist[:-3], strong, after[0], lv.Bar(hist[-1].d, 104.0, 104.0, 99.0, 99.2)]
    assert [x.name for x in lv.supply_demand(broken)] == ["SUPPLY"]     # used up; the day that broke it left a base of its own


def test_the_expected_move_and_the_close_strength():
    assert lv.expected_move(100, 0.2, 1) == pytest.approx(100 * 0.2 / 252 ** 0.5)
    assert lv.expected_move(100, 0.2, 5) == pytest.approx(100 * 0.2 * (5 / 252) ** 0.5)
    assert lv.close_strength(lv.Bar("d", 1, 2, 1, 2)) == (1.0, "STRONG")
    assert lv.close_strength(lv.Bar("d", 2, 2, 1, 1)) == (0.0, "WEAK")
    assert lv.close_strength(lv.Bar("d", 1, 1, 1, 1)) == (0.5, "MID")


def test_the_live_state_reads_gaps_tests_and_breaks():
    got = lv.levels_for(flat(), "2026-10-12")                              # PDH 100.5, PDL 99.5, ATR 1; one big zone at each
    assert lv.state(100.0, {**got, "zones": []}) == "INSIDE"
    assert lv.state(100.0, got, minutes_in=5) == "NO TRADE"
    assert lv.state(102.0, {**got, "zones": []}, session_open=101.5) == "GAP ABOVE"
    assert lv.state(98.0, {**got, "zones": []}, session_open=98.5) == "GAP BELOW"
    assert lv.state(102.0, {**got, "zones": []}) == "ABOVE PDH" and lv.state(98.0, {**got, "zones": []}) == "BELOW PDL"
    assert lv.state(100.4, got) == "TESTING RESISTANCE" and lv.state(99.6, got) == "TESTING SUPPORT"


def test_the_engine_gives_the_same_levels_it_always_has():
    """A fingerprint of twelve seeded histories. It changes only when the arithmetic does, which needs a decision
    record: every stored edition was built with this arithmetic."""
    doc = []
    for seed in range(12):
        got = lv.levels_for(bars(seed), "2026-10-12")
        doc.append([round(got["atr14"], 6), got["close_strength"],
                    [(x.name, round(x.price, 6), x.weight, None if x.lo is None else round(x.lo, 6)) for x in got["levels"]],
                    [(round(z["lo"], 6), round(z["hi"], 6), z["weight"], z["members"], z["side"]) for z in got["zones"]]])
    assert hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest() == GOLDEN


GOLDEN = "2f6dfcc15f9fdc0c96b8274aaca8019ad62ef15fd8aef1a52df5986c91366f8e"


# ---- the probation rules

def hour(i: int, o: float, h: float, low: float, c: float) -> tuple:
    return (f"2026-10-12T{9 + i}:30", o, h, low, c)


def test_each_rule_triggers_once_on_the_hourly_close_and_is_scored_in_r():
    got = lv.levels_for(flat(), "2026-10-12")                              # PDH 100.5, PDL 99.5, close 100, ATR 1
    up = [hour(0, 100, 100.4, 99.9, 100.3), hour(1, 100.3, 101.0, 100.2, 100.9), hour(2, 100.9, 101.2, 100.6, 101.0),
          hour(3, 101.0, 102.1, 100.9, 102.0), hour(4, 102.0, 102.2, 101.8, 102.1)]
    (t,) = rules.probation_triggers(up, got)
    # Entry on the close across 100.5; stop a fifth of ATR under the level; target two risks away. Bar 3's high of
    # 102.1 does not count: the target is 102.10000000000002 in floating point. Bar 4's 102.2 does.
    assert t == {"rule": "brk_PDH_close", "side": "call", "trigger_bar": "2026-10-12T10:30", "entry": 100.9,
                 "stop": 100.3, "target": 102.1, "exit": "target", "r": 2.0}
    stopped = [*up[:2], hour(2, 100.9, 101.0, 100.2, 100.4), hour(3, 100.4, 100.5, 100.1, 100.2)]
    (t,) = [x for x in rules.probation_triggers(stopped, got) if x["rule"] == "brk_PDH_close"]
    assert (t["exit"], t["r"]) == ("stop", -1.0)                           # a stop is exactly one risk
    both = [*up[:2], hour(2, 100.9, 102.5, 100.0, 101.0), hour(3, 101.0, 101.1, 100.9, 101.0)]
    (t,) = [x for x in rules.probation_triggers(both, got) if x["rule"] == "brk_PDH_close"]
    assert (t["exit"], t["r"]) == ("stop", -1.0)                           # stop and target in one bar count as the stop
    drift = [*up[:2], hour(2, 100.9, 101.0, 100.7, 100.8), hour(3, 100.8, 101.3, 100.7, 101.2)]
    (t,) = rules.probation_triggers(drift, got)
    assert t["exit"] == "close" and t["r"] == pytest.approx((101.2 - 100.9) / 0.6, abs=1e-3)


def test_the_other_three_rules_and_no_entry_on_the_last_bar():
    got = lv.levels_for(flat(), "2026-10-12")
    down = [hour(0, 100, 100.1, 99.6, 99.7), hour(1, 99.7, 99.8, 99.0, 99.1), hour(2, 99.1, 99.2, 97.6, 97.7), hour(3, 97.7, 97.8, 97.5, 97.6)]
    (t,) = rules.probation_triggers(down, got)
    assert (t["rule"], t["side"], t["entry"], t["stop"], t["target"], t["exit"], t["r"]) == ("brk_PDL_close", "put", 99.1, 99.7, 97.9, "target", 2.0)
    reclaim = [hour(0, 100, 100.1, 99.0, 99.3), hour(1, 99.3, 99.9, 99.2, 99.8), hour(2, 99.8, 100.0, 99.7, 99.9), hour(3, 99.9, 100.0, 99.8, 99.9)]
    got_rules = {x["rule"]: x for x in rules.probation_triggers(reclaim, got)}
    assert got_rules["reclaim_PDL_close"]["side"] == "call" and got_rules["reclaim_PDL_close"]["stop"] == pytest.approx(99.0 - 0.05, abs=0.01)
    reject = [hour(0, 100, 101.0, 99.9, 100.8), hour(1, 100.8, 100.9, 100.1, 100.2), hour(2, 100.2, 100.3, 100.0, 100.1), hour(3, 100.1, 100.2, 100.0, 100.1)]
    got_rules = {x["rule"]: x for x in rules.probation_triggers(reject, got)}
    assert got_rules["reject_PDH_close"]["side"] == "put" and got_rules["reject_PDH_close"]["stop"] == pytest.approx(101.0 + 0.05, abs=0.01)
    late = [hour(0, 100, 100.2, 99.9, 100.1), hour(1, 100.1, 101.0, 100.0, 100.9)]
    assert rules.probation_triggers(late, got) == []                       # the cross is on the last bar: nothing to hold
    assert rules.probation_triggers([], got) == [] and set(rules.RULES) == {"brk_PDH_close", "reclaim_PDL_close", "brk_PDL_close", "reject_PDH_close"}


@pytest.mark.parametrize("seed", range(20))
def test_every_result_is_between_a_full_stop_and_a_full_target(seed):
    got = lv.levels_for(bars(seed), "2026-10-12")
    rng = random.Random(seed)
    px = got["last"]["close"]
    hb = []
    for i in range(7):
        c = px * (1 + rng.gauss(0, 0.008))
        hb.append(hour(i, px, max(px, c) * 1.002, min(px, c) * 0.998, c))
        px = c
    out = rules.probation_triggers(hb, got)
    assert len({x["rule"] for x in out}) == len(out)                       # each rule at most once a session
    for x in out:
        assert -1.0 <= x["r"] <= 2.0 and x["exit"] in ("stop", "target", "close")
        assert (x["exit"] == "stop") == (x["r"] == -1.0) or x["exit"] == "close"
        side = 1 if x["side"] == "call" else -1
        assert (x["entry"] - x["stop"]) * side > 0 and (x["target"] - x["entry"]) * side > 0


def test_a_band_with_half_its_edges_is_refused_and_a_target_means_two_r():
    with pytest.raises(TypeError, match="both its low and its high"):
        lv.merge_zones([lv.Level("A", 100.0, "sd", 1, lo=99.0)], ref=100.0)
    got = lv.levels_for(flat(), "2026-10-12")
    for seed in range(40):
        rng = random.Random(seed)
        px = 100.0
        hb = []
        for i in range(7):
            c = px * (1 + (rng.random() - 0.5) * 0.03)
            hb.append(hour(i, px, max(px, c) * 1.002, min(px, c) * 0.998, c))
            px = c
        for x in rules.probation_triggers(hb, got):
            assert (x["exit"] == "target") == (x["r"] == 2.0) and (x["exit"] == "stop") == (x["r"] == -1.0)
