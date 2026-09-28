"""Chart musts (CHT-01..07): EMAs from prior days only, ATR window, level set, PM consolidation, former runner."""
import datetime as dt

import numpy as np
import pandas as pd
from spec_bars import minute_bars

from wt.scanner.checklist import atr14, former_runner, overhead_levels, pm_consolidation, trend, window_ok


def daily(closes, rng=0.02):
    c = np.asarray(closes, float)
    d = [dt.date(2023, 1, 2) + dt.timedelta(days=i) for i in range(len(c))]
    return pd.DataFrame({"date": d, "o": c, "h": c * (1 + rng), "l": c * (1 - rng), "c": c, "v": 1e6})


def test_trend_needs_200_bars_and_all_three_emas():
    assert not trend(daily(np.linspace(5, 10, 199))).ok                   # 199 bars: not enough history
    assert trend(daily(np.linspace(5, 10, 260))).ok                        # steady uptrend: above all three
    down = np.r_[np.linspace(5, 10, 200), np.linspace(10, 8, 60)]
    assert not trend(daily(down)).ok


def test_trend_uses_only_the_history_it_is_given():
    h = daily(np.linspace(5, 10, 260))
    t1 = trend(h)
    t2 = trend(h.iloc[:-1])                                                # "today" excluded -> different, never peeks
    assert t1.close != t2.close


def test_atr14():
    h = daily([10.0] * 20, rng=0.05)                                      # true range 1.0 per day
    assert abs(atr14(h) - 1.0) < 1e-9 and atr14(h.iloc[:10]) is None


def test_levels_include_prior_day_high_and_swing_highs():
    c = [10, 11, 13, 11, 10, 10.5, 10.2]
    h = daily(c, rng=0.0)
    lv = overhead_levels(h)
    assert 13.0 in lv and 10.2 in lv                                       # swing high 13; prior day high/close 10.2


def test_window_vs_atr_and_blue_sky():
    ok, room = window_ok(10.0, [10.3, 12.0], atr=0.5)
    assert not ok and abs(room - 0.3) < 1e-9                               # 0.30 of room < ATR 0.50
    assert window_ok(10.0, [11.0], atr=0.5)[0]
    assert window_ok(10.0, [9.0, 9.5], atr=0.5) == (True, None)
    assert not window_ok(10.0, [11.0], atr=None)[0]


def test_pm_consolidation_top_quartile_holds_and_late_spike_fails():
    ok_rows = [(3.0, 3.1, 2.9, 3.0, 1000)] * 270 + [(3.9, 4.0, 3.85, 3.95, 5000)] * 15        # 04:00-08:30 / 09:10-09:24
    mid = [(3.5, 3.6, 3.4, 3.5, 1000)] * 40                                                   # 08:30-09:10
    pm = minute_bars(ok_rows[:270] + mid + ok_rows[270:], start_et="04:00")
    assert pm_consolidation(pm)                                         # range 2.9-4.0, floor 3.725; lows 3.85
    spike = minute_bars(ok_rows[:270] + mid + [(3.5, 3.6, 3.4, 3.5, 1000)] * 14 + [(3.6, 4.0, 3.6, 4.0, 9000)],
                        start_et="04:00")
    assert not pm_consolidation(spike)                                  # lows at 3.40 before a last-minute spike


def test_former_runner():
    assert former_runner(daily([1, 1, 1.2, 1.6, 2.2, 1.8] + [1.5] * 50))   # +120% within 5 sessions
    assert not former_runner(daily(np.linspace(5, 7, 120)))
