"""Random-entry controls (EVL-05): deterministic per seed, same risk distance, inside the trial window, causal."""
from spec_bars import flat, minute_bars

from wt.backtest.controls import control_signal
from wt.backtest.engine import EntrySignal


def test_control_is_deterministic_same_risk_and_in_window():
    bars = minute_bars(flat(60, 5.0))
    real = EntrySignal(0, 5.11, 4.95, None, "GG-1")
    a = control_signal(bars, real, "GG-1", seed=3)
    b = control_signal(bars, real, "GG-1", seed=3)
    assert (a.bar_index, a.trigger, a.stop) == (b.bar_index, b.trigger, b.stop)
    assert abs((a.trigger - a.stop) - 0.16) < 1e-9
    assert 1 <= a.bar_index < 30 and a.meta["expire_idx"] == a.bar_index + 2 and a.meta["strict_collar"]
    seeds = {control_signal(bars, real, "GG-1", seed=s).bar_index for s in range(40)}
    assert len(seeds) > 5                                                   # draws actually vary across seeds
