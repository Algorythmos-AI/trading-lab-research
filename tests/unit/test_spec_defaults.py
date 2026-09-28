"""No silent drift between SPEC-0001 and code: every threshold hard-coded as a function default must equal the value
in spec.yaml. (Generated configs are covered by test_spec_traceability; this covers defaults in code.)"""
import inspect

import pytest

from wt.backtest import management, portfolio
from wt.data import corpactions
from wt.scanner import checklist, intraday
from wt.signals import musts, patterns, spec_setups
from wt.specs.loader import load_spec

S = load_spec("SPEC-0001")


def hhmm(x: str) -> int:
    h, m = map(int, x.split(":"))
    return h * 60 + m


def d(fn, name):
    return inspect.signature(fn).parameters[name].default


CASES = [
    # candidate pool / splits
    (corpactions.suspect_split, "ratio_tol", S["candidate_pool"]["suspect_split"]["common_ratio_tol"]),
    (corpactions.suspect_split, "min_ratio", S["candidate_pool"]["suspect_split"]["min_ratio"]),
    (corpactions.suspect_split, "max_dollar_surge", S["candidate_pool"]["suspect_split"]["max_dollar_volume_surge"]),
    (corpactions.suspect_split, "lookback", S["candidate_pool"]["suspect_split"]["lookback_sessions"]),
    # patterns
    (patterns.bull_flag, "pole", tuple(S["patterns"]["bull_flag"]["pole_green_candles"])),
    (patterns.bull_flag, "flag", tuple(S["patterns"]["bull_flag"]["flag_candles"])),
    (patterns.bull_flag, "retrace_max", S["patterns"]["bull_flag"]["retrace_max_of_pole"]),
    (patterns.bull_flag, "flag_vol_max", S["patterns"]["bull_flag"]["flag_candle_vol_max_of_pole_peak"]),
    (patterns.bull_flag, "high_conviction_vol", S["patterns"]["bull_flag"]["flag_candle_vol_high_conviction"]),
    (patterns.bull_flag, "ema_n", S["patterns"]["bull_flag"]["holds_ema"]),
    (patterns.flat_top, "tol", S["patterns"]["flat_top"]["resistance_tolerance_usd"]),
    (patterns.flat_top, "touches", S["patterns"]["flat_top"]["resistance_touches_min"]),
    (patterns.abcd, "retrace_max", S["patterns"]["abcd"]["retrace_max_of_ab"]),
    (patterns.breakout_volume_ok, "n", S["patterns"]["breakout_volume"]["bars_for_average"]),
    (patterns.breakout_volume_ok, "ratio", S["patterns"]["breakout_volume"]["min_ratio_vs_20bar_avg"]),
    # musts
    (musts.first_minute_volume_ok, "minimum", S["execution"]["gap_and_go_first_minute_volume_min"]),
    (musts.spread_ok, "maximum", S["execution"]["spread_max_usd"]),
    (musts.reward_risk_ok, "min_rr", S["execution"]["min_reward_risk"]),
    # entries
    (spec_setups.gg_level_break, "window_end", hhmm(S["entries"]["GG-1"]["window"][1])),
    (spec_setups.gg_level_break, "stop_cap", S["entries"]["GG-1"]["stop_cap_usd"]),
    (spec_setups.orb_ladder, "orb5_end", hhmm(S["entries"]["GG-2"]["orb_5m"]["window"][1])),
    (spec_setups.continuation_5m, "first", hhmm(S["entries"]["GG-3"]["window"][0])),
    (spec_setups.continuation_5m, "last", hhmm(S["entries"]["GG-3"]["window"][1])),
    (spec_setups.continuation_5m, "fresh_after", hhmm(S["entries"]["GG-3"]["fresh_after"])),
    (spec_setups.red_to_green, "window_end", hhmm(S["entries"]["GG-4"]["window"][1])),
    (spec_setups.micro_pullback_1m, "vol_min", S["execution"]["momentum_volume_min"]),
    (spec_setups.micro_pullback_1m, "body_max_of_prior_range", S["entries"]["MP-1"]["pullback_candle"]["red_body_max_of_prior_range"]),
    (spec_setups.micro_pullback_1m, "wick_min_body", S["entries"]["MP-1"]["pullback_candle"]["or_lower_wick_min_body_multiple"]),
    (spec_setups.micro_pullback_1m, "fresh_hod_bars", S["entries"]["MP-1"]["fresh_hod_within_bars"]),
    (spec_setups.micro_pullback_1m, "near_atr", S["entries"]["MP-1"]["near_ema"]["max_distance_atr1m"]),
    (spec_setups.micro_pullback_1m, "expiry_bars", S["entries"]["MP-1"]["entry_expiry_bars"]),
    (spec_setups.reversal_long, "window", tuple(hhmm(x) for x in S["scanners"]["reversal_hybrid"]["active_window"])),
    (spec_setups.reversal_long, "min_target_usd", S["scanners"]["reversal_hybrid"]["target_ema9_5m_min_distance_usd"]),
    # scanners
    (intraday.hod_mask, "window", tuple(hhmm(x) for x in S["scanners"]["high_of_day"]["active_window"])),
    (intraday.hod_mask, "price", tuple(S["scanners"]["high_of_day"]["price_usd"])),
    (intraday.hod_mask, "vol_min", S["scanners"]["high_of_day"]["volume_today_min_shares"]),
    (intraday.hod_mask, "rvol_min", S["scanners"]["high_of_day"]["rvol_min"]),
    (intraday.hod_mask, "surge_min", S["scanners"]["high_of_day"]["volume_surge_5min_min_ratio"]),
    (intraday.hod_mask, "float_max", S["scanners"]["high_of_day"]["float_max_shares"]),
    (intraday.rev_qualifies, "price", tuple(S["scanners"]["reversal_hybrid"]["price_usd"])),
    (intraday.rev_qualifies, "vol_min", S["scanners"]["reversal_hybrid"]["volume_today_min_shares"]),
    (intraday.rev_qualifies, "adv5_min", S["scanners"]["reversal_hybrid"]["adv5_min_shares"]),
    (intraday.rev_qualifies, "rvol_min", S["scanners"]["reversal_hybrid"]["rvol_min"]),
    (intraday.rev_qualifies, "reds", S["scanners"]["reversal_hybrid"]["consecutive_5m_candles_min"]),
    (intraday.rev_qualifies, "bb_n", S["scanners"]["reversal_hybrid"]["bollinger"]["period"]),
    (intraday.rev_qualifies, "bb_k", S["scanners"]["reversal_hybrid"]["bollinger"]["std"]),
    (intraday.rev_qualifies, "rsi_n", S["scanners"]["reversal_hybrid"]["rsi"]["period"]),
    (intraday.rev_qualifies, "rsi_max", S["scanners"]["reversal_hybrid"]["rsi"]["oversold_below"]),
    # chart musts
    (checklist.overhead_levels, "lookback", S["chart_filters"]["window"]["levels_lookback_sessions"]),
    (checklist.overhead_levels, "swing_each_side", S["chart_filters"]["window"]["swing_high_bars_each_side"]),
    (checklist.pm_consolidation, "check", tuple(hhmm(x) for x in S["chart_filters"]["pm_consolidation"]["check_window"])[:1]
     + (hhmm(S["chart_filters"]["pm_consolidation"]["check_window"][1]) + 1,)),
    (checklist.pm_consolidation, "top_fraction", S["chart_filters"]["pm_consolidation"]["lows_in_top_fraction_of_range"]),
    (checklist.former_runner, "lookback", S["former_runner"]["lookback_sessions"]),
    (checklist.former_runner, "window", S["former_runner"]["multi_day_window_sessions"]),
    (checklist.former_runner, "ratio", S["former_runner"]["move_min_ratio"]),
    (checklist.atr14, "n", S["chart_filters"]["window"]["atr_period"]),
    # exits and risk
    (management.WT.__init__, "minutes", S["exits"]["WT"]["stagnation"]["time_stop_unresolved_minutes"]),
    (management.WT.__init__, "resolved_R", S["exits"]["WT"]["stagnation"]["resolved_if_R_at_least"]),
    (management.MeanRevert5.__init__, "minutes", S["exits"]["REV"]["stagnation"]["time_stop_unresolved_minutes"]),
    (portfolio.admit_day, "max_consecutive_losers", S["risk"]["max_consecutive_losers_per_day"]),
    (portfolio.admit_day, "max_daily_loss_R", S["risk"]["max_daily_loss_R"]),
    (portfolio.admit_day, "risk_pct", S["risk"]["per_trade_risk_pct_of_equity"]),
]


@pytest.mark.parametrize("fn,param,expected", CASES, ids=[f"{c[0].__qualname__}.{c[1]}" for c in CASES])
def test_code_default_equals_spec(fn, param, expected):
    assert d(fn, param) == expected


def test_attempts_match_spec():
    for k, v in spec_setups.ATTEMPTS.items():
        assert v == S["entries"][k]["attempts"], k
