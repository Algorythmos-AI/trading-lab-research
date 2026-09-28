import pandas as pd
import pytest

from wt.backtest.engine import Costs, EntrySignal, simulate, size_position
from wt.backtest.management import M1HalfBreakeven, M3FixedTarget

ZERO = Costs(slippage_per_share=0.0, fee_per_share_sell=0.0, sec_fee_rate_sell=0.0)


def bars(rows):
    t = pd.date_range("2026-01-05 14:30", periods=len(rows), freq="1min", tz="UTC")
    df = pd.DataFrame(rows, columns=["o", "h", "l", "c", "v"])
    df.insert(0, "t", t)
    return df


def run(rows, sig, mgmt=None, costs=ZERO, flatten=None):
    b = bars(rows)
    return simulate(b, sig, mgmt or M3FixedTarget(), costs, "TEST", "2026-01-05", risk_dollars=10, cash=1e6,
                    max_notional=1e6, flatten_idx=flatten or len(b) - 1)


FLAT = [10.0, 10.0, 10.0, 10.0, 1e6]


def test_no_entry_on_signal_bar_itself():
    rows = [[10, 10.6, 9.9, 10.5, 1e6], FLAT, FLAT]          # signal bar 0 already exceeds trigger
    assert run(rows, EntrySignal(0, trigger=10.5, stop=10.0, target=11.5, setup="t")) is None


def test_gap_through_collar_no_fill():
    rows = [FLAT, [10.7, 10.8, 10.6, 10.7, 1e6], FLAT]       # opens above trigger + 10% R collar
    assert run(rows, EntrySignal(0, trigger=10.5, stop=10.0, target=11.5, setup="t")) is None


def test_stop_before_target_same_bar_is_pessimistic():
    rows = [FLAT, [10.4, 10.55, 10.4, 10.5, 1e6], [10.5, 11.6, 9.9, 10.0, 1e6], FLAT]
    tr = run(rows, EntrySignal(0, trigger=10.5, stop=10.0, target=11.5, setup="t"))
    assert tr.exits[-1][3] == "stop" and tr.exits[-1][1] == pytest.approx(10.0)
    assert tr.r_multiple(ZERO) == pytest.approx(-1.0)


def test_target_hit_gives_2R():
    rows = [FLAT, [10.4, 10.55, 10.4, 10.5, 1e6], [10.5, 11.6, 10.4, 11.5, 1e6], FLAT]
    tr = run(rows, EntrySignal(0, trigger=10.5, stop=10.0, target=11.5, setup="t"))
    assert tr.exits[-1][3] == "target" and tr.r_multiple(ZERO) == pytest.approx(2.0)


def test_m1_partial_then_breakeven_stop():
    rows = [FLAT, [10.4, 10.55, 10.4, 10.5, 1e6], [10.5, 11.6, 10.45, 11.4, 1e6], [11.0, 11.1, 10.4, 10.45, 1e6], FLAT]
    tr = run(rows, EntrySignal(0, trigger=10.5, stop=10.0, target=11.5, setup="t"), mgmt=M1HalfBreakeven())
    reasons = [e[3] for e in tr.exits]
    assert reasons[0] == "partial_t1" and reasons[-1] == "stop"
    assert tr.r_multiple(ZERO) == pytest.approx(1.0)       # half at +2R, half at breakeven


def test_eod_flatten():
    rows = [FLAT, [10.4, 10.55, 10.4, 10.5, 1e6]] + [[10.6, 10.7, 10.55, 10.6, 1e6]] * 5
    tr = run(rows, EntrySignal(0, trigger=10.5, stop=10.0, target=20, setup="t"), flatten=5)
    assert tr.exits[-1][3] == "eod_flatten"


def test_costs_reduce_R_and_stress_multiplier():
    rows = [FLAT, [10.4, 10.55, 10.4, 10.5, 1e6], [10.5, 11.6, 10.4, 11.5, 1e6], FLAT]
    sig = EntrySignal(0, trigger=10.5, stop=10.0, target=11.5, setup="t")
    r1 = run(rows, sig, costs=Costs()).r_multiple(Costs())
    c2 = Costs(cost_multiplier=2.0)
    r2 = run(rows, sig, costs=c2).r_multiple(c2)
    assert r2 < r1 < 2.0


def test_sizing_integer_and_caps():
    assert size_position(10.0, 9.8, risk_dollars=6, cash=600, max_notional=600) == 30
    assert size_position(50.0, 49.9, risk_dollars=6, cash=600, max_notional=600) == 12   # cash-capped
    assert size_position(700.0, 690.0, risk_dollars=6, cash=600, max_notional=600) == 0  # can't afford 1 share
