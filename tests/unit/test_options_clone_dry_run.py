"""EXP-0025's replay (DEC-0031): the clone's signal on scripted bars, priced and managed minute by minute."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
import yaml

from test_options_clone_session import DAY, L, NEXT, Market, at
from wt.options import dryrun, regime
from wt.options.setups import Mark

ROOT = Path(__file__).resolve().parents[2]
CFG = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
RISK = yaml.safe_load((ROOT / "config" / "risk.yaml").read_text())["O"]
MARKS = {"SPY": [Mark("PDL", 576.0), Mark("PDH", L), Mark("PWH", NEXT)]}
SYM = "SPY261019C00581000"


def minutes(after: float | None = None) -> dict[str, list[regime.Bar]]:
    m = Market()
    m.after = after
    rows = m.minutes(["SPY"], None, at("16:00"))["SPY"]
    return {"SPY": regime.minute_bars(rows, DAY)}


def obars(path) -> list[dryrun.OBar]:
    out, t = [], at("10:26")
    while t < at("16:00"):
        vw = path(t)
        out.append(dryrun.OBar(t, vw, vw + 0.01, vw - 0.01, vw, vw))
        t += dt.timedelta(minutes=1)
    return out


def run(path=lambda t: 1.40, after=None, mult=1.0, bars=None):
    return dryrun.replay_day(DAY, minutes(after), MARKS, lambda s: (bars if bars is not None else obars(path)) if s == SYM else [],
                             CFG, RISK, [], mult)


def test_the_signal_is_entered_at_the_next_minutes_price_plus_half_the_spread():
    d = run(lambda t: 1.40 if t < at("10:29") else 2.20)          # up before the five-minute time stop
    (tr,) = d.trades
    assert tr["setup"] == "retest" and tr["entered"] == "10:26" and tr["fill"] == pytest.approx(1.414)
    assert tr["exit_reason"] == "target" and tr["exit_fill"] == pytest.approx(1.414 * 1.5 - 0.0212, abs=1e-3)
    assert d.left_out["signal:retest"] == 1


def test_a_premium_stop_and_a_gap_below_it():
    (tr,) = run(lambda t: 1.40 if t < at("10:28") else 1.00).trades
    assert tr["exit_reason"] == "premium" and tr["exit_fill"] == pytest.approx(1.00 - 0.01, abs=1e-3)   # opened below


def test_the_time_stop_and_twice_the_spread_costs_more():
    one = run(lambda t: 1.40).trades[0]
    two = run(lambda t: 1.40, mult=2.0).trades[0]
    assert one["exit_reason"] == two["exit_reason"] == "time" and two["pnl"] < one["pnl"] < 0


def test_no_option_bar_and_over_the_cap_are_left_out_and_counted():
    d = run(bars=[])
    assert d.trades == [] and d.left_out["no-option-bar:retest"] == 1
    d = run(lambda t: 2.10)
    assert d.trades == [] and d.left_out["over-cap:retest"] == 1


def test_flat_by_15_10():
    (tr,) = run(lambda t: 1.40 + (0.05 if t >= at("10:27") else 0)).trades
    assert tr["exit_reason"] == "flatten" and tr["exited"] == "15:10"


def test_occ_and_strike():
    assert dryrun.nearest_strike(581.5) == 581.0 and dryrun.nearest_strike(581.51) == 582.0
    assert dryrun.occ("QQQ", DAY, "put", 500) == "QQQ261019P00500000"
