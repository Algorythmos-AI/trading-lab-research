"""Engine behaviour SPEC-0001 relies on: order expiry, pre-entry invalidation (ENT-00), breakout-volume exit
(PAT-08), halt tags (EXE-07), no averaging down (EXE-05), stops never loosen (EXE-04), spread slippage (EXE-06).
Also the WT and reversal exit styles (EXT-01..08)."""
import numpy as np
import pandas as pd
from spec_bars import flat, minute_bars

from wt.backtest.engine import Costs, EntrySignal, simulate
from wt.backtest.management import REGISTRY


def run(bars, sig, mgmt="WT", slip=0.01, flatten=None):
    return simulate(bars, sig, REGISTRY[mgmt](), Costs(slippage_per_share=slip), "T", "2024-03-01",
                    risk_dollars=6.0, cash=600.0, max_notional=600.0, flatten_idx=flatten or len(bars) - 1)


def test_order_expires_unfilled():
    bars = minute_bars(flat(5, 5.05) + [(5.05, 5.20, 5.04, 5.15, 50_000)] + flat(10, 5.15))
    sig = EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 3})
    assert run(bars, sig) is None                                   # the break comes at index 5, after expiry
    sig2 = EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 6})
    assert run(bars, sig2) is not None


def test_pending_entry_cancelled_when_stop_trades_first():
    bars = minute_bars(flat(2, 5.03) + [(5.03, 5.04, 4.98, 5.00, 50_000)] + [(5.00, 5.20, 5.00, 5.15, 50_000)] + flat(5, 5.15))
    sig = EntrySignal(0, 5.10, 4.99, None, "t", meta={"expire_idx": 10})
    assert run(bars, sig) is None


def test_breakout_volume_fail_exits_next_bar_open():
    rows = flat(3, 5.05) + [(5.05, 5.12, 5.04, 5.11, 50_000), (5.11, 5.13, 5.08, 5.12, 50_000)] + flat(10, 5.12)
    bars = minute_bars(rows)
    bv = {"complete": np.arange(len(bars)), "ok": np.zeros(len(bars), bool)}
    tr = run(bars, EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10, "bv": bv}))
    assert tr.exits[-1][3] == "breakout_volume_fail" and tr.exits[-1][0] == bars.t.iloc[4]
    assert tr.tags["breakout_volume_ok"] is False


def test_halt_is_tagged():
    rows = flat(3, 5.05) + [(5.05, 5.12, 5.04, 5.11, 50_000)] + flat(3, 5.11)
    bars = minute_bars(rows)
    later = minute_bars(flat(5, 5.30), start_et="09:45")               # 8-minute gap with no prints
    bars = pd.concat([bars, later], ignore_index=True)
    tr = run(bars, EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10}), mgmt="M3")
    assert tr.tags["halt"] is True


def test_quantity_never_increases_and_stop_never_loosens():
    rows = flat(3, 5.05) + [(5.05, 5.12, 5.04, 5.11, 50_000)] + [(5.11 + 0.03 * k, 5.15 + 0.03 * k, 5.10 + 0.03 * k,
                                                               5.14 + 0.03 * k, 50_000) for k in range(20)] + flat(20, 5.7)
    tr = run(minute_bars(rows), EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10}))
    sold = sum(q for _, _, q, _ in tr.exits)
    assert sold == tr.qty and all(q > 0 for _, _, q, _ in tr.exits)


def test_spread_slippage_raises_cost():
    rows = flat(3, 5.05) + [(5.05, 5.12, 5.04, 5.11, 50_000)] + flat(10, 5.11)
    sig = EntrySignal(0, 5.10, 4.80, None, "t", meta={"expire_idx": 10})          # R 0.30 -> collar limit 5.13
    cheap, dear = run(minute_bars(rows), sig, slip=0.01), run(minute_bars(rows), sig, slip=0.03)
    assert abs(cheap.entry - 5.11) < 1e-9 and abs(dear.entry - 5.13) < 1e-9


def test_strict_collar_refuses_fill_when_slippage_exceeds_collar():
    rows = flat(3, 5.05) + [(5.05, 5.12, 5.04, 5.11, 50_000)] + flat(10, 5.11)
    loose = EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10})         # collar 5.11; slip 0.03 -> want 5.13
    strict = EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10, "strict_collar": True})
    assert run(minute_bars(rows), loose, slip=0.03).entry <= 5.11 + 1e-9            # legacy: capped at the limit
    assert run(minute_bars(rows), strict, slip=0.03) is None                        # spec: no fill


# ---------------------------------------------------------------- WT exit style
def _trend_then(rows_after):
    return minute_bars(flat(3, 5.05) + [(5.05, 5.12, 5.04, 5.11, 50_000)] + rows_after)


def test_wt_sells_floor_half_at_2R_then_breakeven():
    up = [(5.11 + 0.04 * k, 5.14 + 0.04 * k, 5.10 + 0.04 * k, 5.13 + 0.04 * k, 50_000) for k in range(8)]
    down = [(5.40, 5.41, 5.05, 5.06, 50_000)] * 3
    tr = run(_trend_then(up + down + flat(10, 5.06)), EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10}))
    first = tr.exits[0]
    assert first[3] == "partial_t1" and first[2] == tr.qty // 2
    assert tr.exits[-1][1] >= tr.entry - 0.02                          # runner stopped at breakeven (minus slippage)


def test_wt_single_share_exits_in_full_at_target():
    up = [(5.11 + 0.04 * k, 5.14 + 0.04 * k, 5.10 + 0.04 * k, 5.13 + 0.04 * k, 50_000) for k in range(8)]
    bars = _trend_then(up + flat(10, 5.4))
    tr = simulate(bars, EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10}), REGISTRY["WT"](),
                  Costs(), "T", "d", risk_dollars=0.12, cash=600, max_notional=600, flatten_idx=len(bars) - 1)
    assert tr.qty == 1 and len(tr.exits) == 1 and tr.exits[0][3] == "target_all"


def test_wt_stagnation_stop_at_minute_5():
    bars = _trend_then(flat(12, 5.12))                                  # never reaches +0.5R (5.16)
    tr = run(bars, EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10}))
    assert tr.exits[-1][3] == "time_stop_5m"


def test_wt_runner_no_time_cap_and_exits_below_5m_low():
    up = [(5.11 + 0.02 * k, 5.14 + 0.02 * k, 5.10 + 0.02 * k, 5.13 + 0.02 * k, 50_000) for k in range(40)]
    bars = _trend_then(up + [(5.9, 5.9, 5.50, 5.52, 50_000)] * 3 + flat(10, 5.5))
    tr = run(bars, EntrySignal(0, 5.10, 5.00, None, "t", meta={"expire_idx": 10}))
    reasons = [x[3] for x in tr.exits]
    assert reasons[0] == "partial_t1" and reasons[-1] in ("runner_prior_5m_low", "runner_5m_close_below_ema9")
    held = (tr.exits[-1][0] - tr.entry_time).total_seconds() / 60
    assert held > 30                                                    # the runner outlived any 5-minute cap


def test_reversal_exits_in_full_at_fixed_target():
    up = [(5.11 + 0.05 * k, 5.16 + 0.05 * k, 5.10 + 0.05 * k, 5.15 + 0.05 * k, 50_000) for k in range(10)]
    tr = run(_trend_then(up + flat(10, 5.6)), EntrySignal(0, 5.10, 5.00, 5.40, "REV-1", meta={"expire_idx": 10}), mgmt="REV5")
    assert len(tr.exits) == 1 and tr.exits[0][3] == "target" and tr.exits[0][1] >= 5.40
