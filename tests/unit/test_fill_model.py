"""DEC-0011 M-FILL: trade-through target fills and a separate stop-slippage multiplier (synthetic bars only)."""
from dataclasses import replace

import pandas as pd
import pytest

from wt.backtest.engine import Costs, EntrySignal, simulate
from wt.backtest.management import M1HalfBreakeven, M3FixedTarget

ZERO = Costs(slippage_per_share=0.0, fee_per_share_sell=0.0, sec_fee_rate_sell=0.0)
FLAT = [10.0, 10.0, 10.0, 10.0, 1e6]
ENTRY = [10.4, 10.55, 10.4, 10.5, 1e6]          # triggers at 10.50; stop 10.00 -> R = 0.50, 2R target 11.50
SIG = EntrySignal(0, trigger=10.5, stop=10.0, target=11.5, setup="t")


def bars(rows):
    t = pd.date_range("2026-01-05 14:30", periods=len(rows), freq="1min", tz="UTC")
    df = pd.DataFrame(rows, columns=["o", "h", "l", "c", "v"])
    df.insert(0, "t", t)
    return df


def run(rows, mgmt=None, costs=ZERO, **kw):
    b = bars(rows)
    return simulate(b, SIG, mgmt or M3FixedTarget(), costs, "TEST", "2026-01-05", risk_dollars=10, cash=1e6,
                    max_notional=1e6, flatten_idx=len(b) - 1, **kw)


def test_touch_is_the_default_and_fills_at_the_target():
    rows = [FLAT, ENTRY, [11.0, 11.5, 10.9, 11.4, 1e6], FLAT]            # high touches 11.50 exactly
    for tr in (run(rows), run(rows, target_fill="touch")):
        assert tr.exits == [(bars(rows).t.iloc[2], 11.5, tr.qty, "target")]
        assert tr.exit_kinds == ["limit"]


def test_through_needs_one_tick_beyond_the_target():
    rows = [FLAT, ENTRY,
            [11.0, 11.5, 10.9, 11.4, 1e6],           # touch: no fill
            [11.4, 11.509, 11.3, 11.4, 1e6],         # 0.9 tick through: no fill
            [11.4, 11.51, 11.3, 11.5, 1e6],          # one full tick through: fills at the limit
            FLAT]
    tr = run(rows, target_fill="through")
    t, px, q, reason = tr.exits[0]
    assert (t, px, reason) == (bars(rows).t.iloc[4], 11.5, "target") and len(tr.exits) == 1


def test_through_never_fills_on_touches_only():
    rows = [FLAT, ENTRY] + [[11.0, 11.5, 10.9, 11.4, 1e6]] * 4 + [[11.2, 11.3, 11.1, 11.2, 1e6]]
    tr = run(rows, target_fill="through")
    assert [e[3] for e in tr.exits] == ["eod_flatten"] and tr.exit_kinds == ["market"]
    assert run(rows).exits[0][3] == "target"                             # the same path fills on a touch


def test_through_gap_open_fills_at_the_open():
    rows = [FLAT, ENTRY, [11.6, 11.7, 11.55, 11.6, 1e6], FLAT]
    tr = run(rows, target_fill="through")
    assert tr.exits[0][1] == pytest.approx(11.6) and tr.exits[0][3] == "target"


def test_through_applies_to_partial_targets_and_tick_is_a_parameter():
    rows = [FLAT, ENTRY, [11.0, 11.5, 10.9, 11.4, 1e6], [11.4, 11.52, 11.3, 11.4, 1e6], [11.0, 11.1, 10.4, 10.45, 1e6], FLAT]
    tr = run(rows, mgmt=M1HalfBreakeven(), target_fill="through")
    assert [e[3] for e in tr.exits] == ["partial_t1", "stop"] and tr.exits[0][0] == bars(rows).t.iloc[3]
    assert tr.exit_kinds == ["limit", "stop"]
    wide = run(rows, mgmt=M1HalfBreakeven(), target_fill="through", tick=0.05)   # 0.02 through < a 0.05 tick
    assert [e[3] for e in wide.exits] == ["eod_flatten"]


def test_unknown_target_fill_is_refused():
    with pytest.raises(ValueError, match="target_fill"):
        run([FLAT, ENTRY, FLAT], target_fill="cross")


def test_stop_slip_multiplier_hits_stop_fills_only():
    slip = Costs(slippage_per_share=0.02, fee_per_share_sell=0.0, sec_fee_rate_sell=0.0)
    stopped = [FLAT, ENTRY, [10.3, 10.35, 9.9, 10.0, 1e6], FLAT]
    base, stressed = run(stopped, costs=slip), run(stopped, costs=replace(slip, stop_slip_multiplier=3.0))
    assert base.entry == stressed.entry == pytest.approx(10.52)                    # entry slippage unchanged
    assert base.exits[0][1] == pytest.approx(10.0 - 0.02)
    assert stressed.exits[0][1] == pytest.approx(10.0 - 0.06) and stressed.exit_kinds == ["stop"]
    flat = [FLAT, ENTRY] + [[10.6, 10.7, 10.55, 10.6, 1e6]] * 4
    a, b = run(flat, costs=slip), run(flat, costs=replace(slip, stop_slip_multiplier=3.0))
    assert a.exits == b.exits and a.exits[0][1] == pytest.approx(10.6 - 0.02)     # market exits unchanged
    assert Costs().stop_slip() == Costs().slip()                                 # default: no change
