"""Paper B's live signal: the runner acts only on a signal on the bar that just closed. The backtest version never
signals on the last bar (it enters from the next one), so without `live=True` the runner could never enter."""
import numpy as np
import pandas as pd
import pytest

from wt.signals import setups


def day_bars(n=390, drift=0.02):
    t = pd.date_range("2026-09-30 13:30", periods=n, freq="1min", tz="UTC")
    c = 500 * (1 + np.linspace(0, drift, n))
    return pd.DataFrame({"t": t, "o": c, "h": c, "l": c, "c": c, "v": 1e5})


def first_live_signal(bars, sigma, prev_close, live):
    """What the runner sees: at each minute only the closed bars, acting when the signal is on the newest one."""
    for k in range(1, len(bars) + 1):
        closed = bars.iloc[:k].reset_index(drop=True)
        s = setups.b_intraday_momentum(closed, sigma, prev_close, live=live)
        if s and s.bar_index == k - 1:
            return s
    return None


@pytest.mark.parametrize("drift, sigma, prev_close", [(0.02, 0.002, 499.0), (0.01, 0.003, 500.0), (0.03, 0.001, 495.0)])
def test_the_runner_sees_the_backtests_signal_when_its_bar_closes(drift, sigma, prev_close):
    bars = day_bars(drift=drift)
    backtest = setups.b_intraday_momentum(bars, sigma, prev_close)
    assert backtest is not None
    live = first_live_signal(bars, sigma, prev_close, live=True)
    assert live is not None and (live.bar_index, live.trigger, live.stop) == (backtest.bar_index, backtest.trigger, backtest.stop)


def test_without_live_the_runner_never_enters():
    bars = day_bars()
    assert setups.b_intraday_momentum(bars, 0.002, 499.0) is not None
    assert first_live_signal(bars, 0.002, 499.0, live=False) is None


def test_live_changes_nothing_for_a_full_day():
    bars = day_bars()
    a = setups.b_intraday_momentum(bars.iloc[:-1], 0.002, 499.0)
    b = setups.b_intraday_momentum(bars, 0.002, 499.0)
    assert (a.bar_index, a.trigger, a.stop) == (b.bar_index, b.trigger, b.stop)
