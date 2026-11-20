"""The registered gap entries read live (wt.live.setups_live, e1..e4) against the batch detectors and the engine.

Each day is run twice. The batch path is the registered one: the detector reads the whole day, then
wt.backtest.engine.simulate decides the fill (the probe `scripts/r3_run.py run_day` makes). The live path walks the
day one closed bar at a time: the rule's own function says which order rests for the next bar, and the first bar to
reach it is filled, or not, by the engine's own arithmetic. The two must agree on whether there is a trade, the bar
it enters on, the entry price, the stop, and the breakout-volume flag.

The walk never shows a rule a bar that has not closed: every call gets a prefix of the day.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from gap_days import AFTERS, E3_SETUPS, e3_day, random_day
from spec_bars import flat, minute_bars
from test_wt_live import same, walk

from wt.backtest.engine import Costs, simulate
from wt.backtest.management import REGISTRY
from wt.live import setups_live as sl
from wt.signals.patterns import Pattern
from wt.signals.spec_setups import continuation_5m, gg_level_break, orb_ladder, red_to_green

BATCH = {"e1": gg_level_break, "e2": orb_ladder, "e3": continuation_5m, "e4": red_to_green}
MIN_BARS = 30                       # scripts/r3_run.py run_day skips a name with fewer bars; so does this comparison


def batch(code: str, bars: pd.DataFrame, ctx: dict, slip: float, flatten: int, risk: float = 1e9, cash: float = 1e9):
    sig = BATCH[code](bars, ctx)
    if sig is None:
        return None, None
    return sig, simulate(bars, sig, REGISTRY["WT"](), Costs(slippage_per_share=slip), "ABC", "2024-03-01",
                         risk_dollars=risk, cash=cash, max_notional=cash, flatten_idx=flatten)


def live_bv(order: sl.GapOrder, bars: pd.DataFrame, pm, entry_i: int) -> tuple[int, bool] | None:
    """The breakout-volume verdict as a desk learns it: asked again at each bar's close, from closed bars only."""
    for j in range(entry_i, len(bars)):
        got = sl.gap_bv(order.bv, bars.iloc[: j + 1], pm, entry_i)
        if got is not None:
            assert got[0] == j, "the verdict is known at the close of the bar that completes the bucket, not later"
            return got
    return None


def compare(code: str, bars: pd.DataFrame, ctx: dict, slip: float) -> dict:
    """Run both paths and hold them together. Returns what happened, for the coverage counts."""
    flatten = len(bars) - 10
    sig, tr = batch(code, bars, ctx, slip, flatten)
    att = sl.gap_walk(bars, ctx, codes=(code,), slip=slip, last_bar=flatten)
    traded = att is not None and att.fill is not None
    assert (tr is not None) == traded, (code, sig, att)
    out = {"signal": sig is not None, "trade": traded, "setup": sig.setup if sig is not None else "",
           "reached_unfilled": att is not None and att.fill is None, "bv": None}
    if tr is None or att is None or att.fill is None:
        return out
    assert pd.Timestamp(bars.t.iloc[att.bar_i]) == pd.Timestamp(tr.entry_time), (code, att, tr.entry_time)
    assert att.fill == pytest.approx(tr.entry, abs=1e-9)
    assert att.order.stop == pytest.approx(tr.stop0, abs=1e-9) and att.order.trigger == pytest.approx(sig.trigger, abs=1e-9)
    assert att.order.signal_i == sig.bar_index
    verdict = live_bv(att.order, bars, ctx.get("pm_bars"), att.bar_i)
    if att.order.bv:
        assert tr.tags["breakout_volume_ok"] == (verdict is None or not verdict[1])
        out["bv"] = tr.tags["breakout_volume_ok"]
    else:
        assert "breakout_volume_ok" not in tr.tags and verdict is None
    # the whole trade at the desk's size: the live exit, told the verdict when it is known, makes the engine's exits
    _, sized = batch(code, bars, ctx, slip, flatten, risk=6.0, cash=600.0)
    if sized is not None:
        mine = walk(bars, sig, att.bar_i, sized.entry, sized.qty, flatten, bv_fail=bool(verdict and verdict[1]),
                    bv_i=verdict[0] if verdict else None, slip=slip)
        assert same(mine, sized.exits), (code, mine, sized.exits)
        out["exits"] = [e[3] for e in sized.exits]
    return out


@pytest.mark.parametrize("code", ["e1", "e2", "e4"])
def test_each_one_minute_rule_takes_the_batch_trade_on_many_random_days(code):
    seen = {"days": 0, "signals": 0, "trades": 0, "unfilled": 0, "thin": 0}
    setups, bv = set(), set()
    for seed in range(500):
        bars, ctx, slip = random_day(seed)
        if len(bars) < MIN_BARS:
            continue
        got = compare(code, bars, ctx, slip)
        seen["days"] += 1
        seen["thin"] += len(bars) < 130
        seen["signals"] += got["signal"]
        seen["trades"] += got["trade"]
        seen["unfilled"] += got["signal"] and not got["trade"]
        setups.add(got["setup"])
        bv.add(got["bv"])
    assert seen["days"] == 500 and seen["thin"] > 150
    assert seen["trades"] >= 25 and seen["unfilled"] >= 10, seen      # fills, and signals the engine did not fill
    if code == "e2":
        assert {"GG-2:orb_1m", "GG-2:orb_5m"} <= setups               # both legs of the ladder
    if code == "e1":
        assert {True, False} <= bv                                    # both breakout-volume outcomes


def test_the_five_minute_rule_takes_the_batch_trade_on_random_days():
    for seed in range(40):
        bars, ctx, slip = random_day(seed)
        if len(bars) >= MIN_BARS:
            compare("e3", bars, ctx, slip)


@pytest.mark.parametrize("setup", sorted(E3_SETUPS))
def test_the_five_minute_rule_takes_the_batch_trade_on_each_pattern_and_each_ending(setup):
    kind = {"flag": "GG-3:bull_flag", "flat_top": "GG-3:flat_top", "abcd": "GG-3:abcd"}[setup]
    results = {}
    for what in AFTERS:
        for v in (300_000, 4_000):                                    # a breakout minute with and without volume
            bars, ctx = e3_day(setup, what, v)
            got = compare("e3", bars, ctx, 0.01)
            assert got["setup"] == kind, (setup, what, got)
            results[(what, v)] = got
    assert results[("fill", 300_000)]["trade"] and results[("stall", 300_000)]["trade"]
    assert not results[("gap", 300_000)]["trade"] and not results[("stop_first", 300_000)]["trade"]
    assert not results[("never", 300_000)]["trade"]
    assert {r["bv"] for r in results.values() if r["trade"]} == {True, False}
    assert any("breakout_volume_fail" in r.get("exits", []) for r in results.values())
    assert any("stop" in r.get("exits", []) for r in results.values())


def test_thin_days_and_every_minute_days_both_reach_the_five_minute_rules_signal():
    bars, ctx = e3_day("flag", "fill")
    thin = bars.drop(index=[34, 36]).reset_index(drop=True)           # the flag's last minute and a later one never print
    assert compare("e3", thin, ctx, 0.01)["signal"] and compare("e3", bars, ctx, 0.01)["trade"]


# ---- the one order that may rest ------------------------------------------------------------------------------------------
def test_the_days_attempt_is_the_first_bar_to_reach_any_rules_order():
    hits = 0
    for seed in range(30):
        bars, ctx, slip = random_day(seed)
        if len(bars) < MIN_BARS:
            continue
        each = [sl.gap_walk(bars, ctx, codes=(c,), slip=slip) for c in sl.GAP_CODES]
        first = min((a.bar_i for a in each if a is not None), default=None)
        seen: set[str] = set()
        both = sl.gap_walk(bars, ctx, slip=slip, seen=seen)
        assert (both.bar_i if both is not None else None) == first
        if both is not None:
            hits += 1
            assert both.order.trigger == min(a.order.trigger for a in each if a is not None and a.bar_i == first)
            assert both.order.code in seen
    assert hits > 8


def test_the_lowest_trigger_is_chosen_and_ties_go_to_the_lower_rule():
    a, b = sl.GapOrder("e1", 5.11, 4.95, 0, 600), sl.GapOrder("e4", 5.06, 4.94, 3, 600, one_bar=True)
    assert sl.gap_choose([a, b]) is b and sl.gap_choose([]) is None
    assert sl.gap_choose([sl.GapOrder("e4", 5.06, 4.9, 0, 600), sl.GapOrder("e2", 5.06, 4.94, 0, 572)]).code == "e2"


OPEN = [(5.00, 5.05, 4.95, 5.02, 150_000)]


def test_an_order_rests_only_inside_its_own_window():
    bars = minute_bars(OPEN + flat(40, 5.02))
    ctx = {"pm_high": 5.10, "overhead": []}
    first = sl.gap_e1(bars.iloc[:1], ctx, 571)
    assert (first.trigger, first.stop, first.bv) == (5.11, 4.94, "1m") and sl.gap_e1(bars.iloc[:29], ctx, 599) is not None
    assert sl.gap_e1(bars.iloc[:30], ctx, 600) is None                 # 10:00: the window is over
    ctx = {"overhead": []}
    one = sl.gap_e2(bars.iloc[:1], ctx, 571)
    assert one.one_bar and one.valid_until == 572 and one.trigger == 5.06
    assert sl.gap_e2(bars.iloc[:1], ctx, 572) is None                  # the 09:31 minute did not print: no order
    assert sl.gap_e2(bars.iloc[:3], ctx, 573) is None                  # between the ladder's two legs nothing rests
    five = sl.gap_e2(bars.iloc[:5], ctx, 575)
    assert not five.one_bar and five.signal_i == 4 and five.valid_until == 590
    assert sl.gap_orders(bars.iloc[:0], ctx, 571) == [] and sl.gap_orders(bars, ctx, 660) == []


def test_the_ladder_goes_on_to_its_five_minute_leg_when_no_bar_prints_until_0935():
    rows = OPEN + flat(40, 5.02)
    bars = minute_bars(rows).drop(index=[1, 2, 3, 4]).reset_index(drop=True)     # 09:31 to 09:34 never print
    ctx = {"overhead": []}
    assert sl.gap_e2(bars.iloc[:1], ctx, 573) is None
    five = sl.gap_e2(bars.iloc[:1], ctx, 575)                          # the first five minutes are the 09:30 bar alone
    assert (five.trigger, five.stop, five.signal_i, five.one_bar) == (5.06, 4.94, 0, False)
    sig = orb_ladder(bars, ctx)
    assert sig.setup == "GG-2:orb_5m" and (sig.trigger, sig.stop, sig.bar_index) == (5.06, 4.94, 0)
    assert not compare("e2", bars, ctx, 0.01)["trade"]                 # the flat tape never reaches it: both agree


def test_an_order_whose_trigger_was_reached_or_whose_stop_traded_first_is_gone():
    ctx = {"pm_high": 5.10, "overhead": []}
    reached = minute_bars(OPEN + flat(3, 5.02) + [(5.02, 5.11, 5.02, 5.10, 50_000)] + flat(5, 5.10))
    assert sl.gap_e1(reached.iloc[:4], ctx, 574) is not None and sl.gap_e1(reached.iloc[:5], ctx, 575) is None
    under = minute_bars(OPEN + flat(3, 5.02) + [(5.02, 5.03, 4.90, 5.00, 50_000)] + flat(5, 5.00))
    assert sl.gap_e1(under.iloc[:4], ctx, 574) is not None and sl.gap_e1(under.iloc[:5], ctx, 575) is None   # under 4.94
    capped = sl.gap_e1(under.iloc[:1], {"pm_high": 5.30, "overhead": []}, 571)
    assert capped.stop == 5.11                                         # the stop is at most 20 cents under the trigger


def test_no_order_without_the_first_minutes_volume_or_the_0930_bar():
    thin = minute_bars([(5.00, 5.05, 4.95, 4.98, 90_000), (4.98, 5.00, 4.90, 4.95, 50_000)] + flat(40, 4.95))
    late = minute_bars([(5.00, 5.05, 4.95, 4.98, 150_000), (4.98, 5.00, 4.90, 4.95, 50_000)], start_et="09:31")
    for b in (thin, late):
        assert sl.gap_orders(b.iloc[:2], {"pm_high": 5.30, "overhead": []}, 572, codes=("e1", "e2", "e4")) == []


def test_the_red_to_green_order_is_repriced_at_every_bar_and_is_spent_once_one_triggers():
    rows = [(5.00, 5.05, 4.95, 4.98, 150_000), (4.98, 5.03, 4.85, 4.90, 50_000), (4.90, 4.97, 4.84, 4.95, 50_000),
            (4.95, 5.08, 4.93, 5.06, 60_000)] + flat(40, 5.06)
    bars, ctx = minute_bars(rows), {"overhead": []}
    first, second, third = (sl.gap_e4(bars.iloc[:n], ctx, 570 + n) for n in (1, 2, 3))
    assert (first.trigger, first.stop, first.signal_i) == (5.06, 4.94, 0)       # over the first bar's high
    assert (second.trigger, second.stop) == (5.04, 4.84) and (third.trigger, third.stop) == (5.01, 4.83)
    assert third.one_bar and sl.gap_e4(bars.iloc[:4], ctx, 574) is None         # 09:33 reached 5.01: spent
    green = minute_bars([(5.00, 5.05, 4.99, 5.04, 150_000)] + [(5.04, 5.10, 5.03, 5.09, 50_000)] * 5)
    assert all(sl.gap_e4(green.iloc[:n], ctx, 570 + n) is None for n in range(1, 6))


# ---- what the rules read, and the order on the cent grid ----------------------------------------------------------------
def test_the_context_is_the_batch_runs_context():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("r3_run", Path(__file__).resolve().parents[2] / "scripts" / "r3_run.py")
    r3 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(r3)
    pm = minute_bars(flat(30, 4.9, v=4_000), start_et="09:00").assign(symbol="ABC")
    pool = pd.DataFrame([
        {"symbol": "ABC", "pm_high": 5.3, "pm_pattern": "bull_flag", "pm_pattern_trigger": 5.1, "pm_pattern_stop": 4.96,
         "overhead_levels": [6.0, 7.5]},
        {"symbol": "XYZ", "pm_high": float("nan"), "pm_pattern": None, "pm_pattern_trigger": float("nan"),
         "pm_pattern_stop": float("nan"), "overhead_levels": None}])
    for row in pool.itertuples():
        theirs, mine = r3.ctx_for(row, pm), sl.gap_context(row, pm)
        assert mine["pm_high"] == theirs["pm_high"] and mine["overhead"] == theirs["overhead"]
        assert mine["pm_pattern"] == theirs["pm_pattern"] and mine["pm_bars"].equals(theirs["pm_bars"])
    as_dict = sl.gap_context(pool.iloc[0].to_dict(), None)
    assert as_dict["pm_pattern"] == Pattern("bull_flag", 5.1, 4.96, -1, 5.1) and len(as_dict["pm_bars"]) == 0


def test_staging_refuses_a_wide_or_unknown_spread_and_a_collar_the_simulation_never_fills():
    import datetime as dt
    bars, day = minute_bars(OPEN + flat(5, 5.02)), dt.date(2024, 3, 1)
    order = sl.GapOrder("e1", 5.31, 5.11, 0, 600, bv="1m")
    s, why = sl.gap_stage("ABC", 1, order, bars, day, 0.02, 571)
    assert why == "" and (s.trigger, s.limit, s.stop) == (5.31, 5.33, 5.11) and (s.expires_at.hour, s.expires_at.minute) == (10, 0)
    assert sl.gap_stage("ABC", 1, order, bars, day, None, 571)[1] == "spread"
    assert sl.gap_stage("ABC", 1, order, bars, day, 0.06, 571)[1] == "spread"
    assert sl.gap_stage("ABC", 1, order, bars, day, 0.05, 571)[1] == "collar"       # 2.5 cents of slippage, 2 of collar
    assert sl.gap_stage("ABC", 1, sl.GapOrder("e1", 5.31, 5.30, 0, 600), bars, day, 0.02, 571)[1] == "risk"
    quick, _ = sl.gap_stage("ABC", 2, sl.GapOrder("e4", 5.06, 4.84, 3, 600, one_bar=True), bars, day, 0.02, 574)
    assert (quick.expires_at.hour, quick.expires_at.minute) == (9, 35)             # the minute it was decided for
    assert sl.engine_entry(order, 5.40, 0.01) is None and sl.engine_entry(order, 5.25, 0.01) == pytest.approx(5.32)
    assert sl.engine_entry(order, 5.25, 0.025) is None


# ---- the exit's EMA is the engine's own arithmetic (review of #570, finding 4a) ----------------------------------------
def test_the_live_ema_is_the_engines_to_the_last_bit():
    from wt.backtest.management import ema as engine_ema
    flat_closes = np.full(40, 9.51)                                  # equal closes: the forms differ in the last bit
    assert np.array_equal(sl._ema(flat_closes, 9), engine_ema(flat_closes, 9))
    rng = np.random.default_rng(7)
    walk_ = 10 + np.cumsum(rng.normal(0, 0.05, 400))
    assert np.array_equal(sl._ema(walk_, 9), engine_ema(walk_, 9))


@pytest.mark.parametrize("code", ["e2", "e4"])
def test_a_close_exactly_on_the_ema_exits_in_both_or_neither(code):
    bars, ctx, slip = random_day(2219)                               # its 09:40 close ties the engine's EMA9
    got = compare(code, bars, ctx, slip)
    assert got["trade"] and got["exits"][-1] == "runner_5m_close_below_ema9"
