"""Pattern detectors (PAT-01..PAT-10) and clock-aligned bars (D36) on hand-built bars."""
import numpy as np
import pandas as pd

from wt.signals.bars import resample_clock
from wt.signals.patterns import abcd, breakout_volume_ok, bull_flag, flat_top, pm_pattern


def mk(rows, start="2024-03-01 14:30"):
    """rows: (o, h, l, c, v) tuples at consecutive minutes from 09:30 ET (14:30 UTC in March, EST)."""
    t = pd.date_range(start, periods=len(rows), freq="1min", tz="UTC")
    o, h, l, c, v = zip(*rows, strict=False)
    return pd.DataFrame({"t": t, "o": o, "h": h, "l": l, "c": c, "v": v})


BASE = [(4.90, 4.95, 4.88, 4.92, 1000)] * 12                          # quiet base so EMA9 sits below the pole


def flag_bars(retrace_to=4.80, flag_vol=3000, flag_n=2):
    pole = [(4.92, 4.35 + 0.1, 4.90, 4.40, 20000)]                      # placeholder replaced below
    pole = [(4.40, 4.62, 4.38, 4.60, 20000), (4.60, 4.82, 4.58, 4.80, 30000),
            (4.80, 5.02, 4.78, 5.00, 40000)]                             # 3 green, pole low 4.38, high 5.02
    flag = [(5.00, 5.00, retrace_to, retrace_to + 0.05, flag_vol)] * flag_n
    base = [(4.40, 4.42, 4.36, 4.40, 1000)] * 12
    return mk(base + pole + flag)


def test_bull_flag_detected_with_trigger_and_stop():
    b = flag_bars(retrace_to=4.92)                                       # retrace (5.02-4.92)/(5.02-4.38)=15.6%
    p = bull_flag(b, len(b) - 1)
    assert p is not None and p.kind == "bull_flag"
    assert p.trigger == 5.00 and p.stop == 4.92 and p.meta["pole_bars"] == 3 and p.meta["flag_bars"] == 2


def test_bull_flag_rejects_retrace_over_25pct():
    b = flag_bars(retrace_to=4.80)                                       # (5.02-4.80)/0.64 = 34%
    assert bull_flag(b, len(b) - 1) is None


def test_bull_flag_rejects_heavy_flag_volume():
    b = flag_bars(retrace_to=4.92, flag_vol=25000)                       # 25k >= 50% of the 40k peak
    assert bull_flag(b, len(b) - 1) is None


def test_bull_flag_high_conviction_tag():
    b = flag_bars(retrace_to=4.92, flag_vol=5000)                        # 12.5% of peak
    assert bull_flag(b, len(b) - 1).meta["high_conviction_volume"] is True


def test_bull_flag_rejects_flag_above_pole_high():
    rows = [(4.40, 4.42, 4.36, 4.40, 1000)] * 12 + [(4.40, 4.62, 4.38, 4.60, 20000), (4.60, 4.82, 4.58, 4.80, 30000),
            (4.80, 5.02, 4.78, 5.00, 40000), (5.00, 5.10, 4.95, 4.97, 3000)]
    b = mk(rows)
    assert bull_flag(b, len(b) - 1) is None


def test_flat_top_detects_resistance_and_higher_lows():
    rows = [(4.40, 4.42, 4.36, 4.40, 1000)] * 10 + [(4.40, 4.60, 4.38, 4.58, 9000), (4.58, 4.78, 4.56, 4.76, 9000),
            (4.76, 5.00, 4.74, 4.95, 9000), (4.95, 5.00, 4.85, 4.90, 4000), (4.90, 5.00, 4.88, 4.97, 4000)]
    b = mk(rows)
    p = flat_top(b, len(b) - 1)
    assert p is not None and p.trigger == 5.00 and p.stop == 4.88


def test_flat_top_rejects_lower_lows():
    rows = [(4.40, 4.42, 4.36, 4.40, 1000)] * 10 + [(4.40, 4.60, 4.38, 4.58, 9000), (4.58, 4.78, 4.56, 4.76, 9000),
            (4.76, 5.00, 4.90, 4.95, 9000), (4.95, 5.00, 4.80, 4.90, 4000)]
    b = mk(rows)
    assert flat_top(b, len(b) - 1) is None


def test_abcd_higher_low_and_retrace_limit():
    #            A=4.00 ... B=5.00 ... C=4.50 (50% retrace) ... signal bar above C and EMA9, B unbroken
    rows = [(4.05, 4.10, 4.00, 4.05, 1000), (4.05, 4.50, 4.04, 4.45, 1000), (4.45, 5.00, 4.44, 4.95, 1000),
            (4.95, 4.96, 4.70, 4.72, 1000), (4.72, 4.75, 4.50, 4.55, 1000), (4.55, 4.80, 4.56, 4.78, 1000)]
    b = mk(rows)
    e = np.full(len(b), 4.40)                                              # EMA9 below price at the signal
    p = abcd(b, len(b) - 1, ema_values=e)
    assert p is not None and p.trigger == 5.00 and p.stop == 4.50 and abs(p.meta["retrace"] - 0.5) < 1e-9


def test_abcd_rejects_deep_retrace():
    rows = [(4.05, 4.10, 4.00, 4.05, 1000), (4.05, 4.50, 4.04, 4.45, 1000), (4.45, 5.00, 4.44, 4.95, 1000),
            (4.95, 4.96, 4.30, 4.32, 1000), (4.32, 4.40, 4.31, 4.38, 1000)]      # C=4.30 -> 70% retrace
    b = mk(rows)
    assert abcd(b, len(b) - 1, ema_values=np.full(len(b), 4.0)) is None


def test_breakout_volume_rule():
    v = np.array([100.0] * 20 + [250.0])
    assert breakout_volume_ok(v, 20) and not breakout_volume_ok(np.array([100.0] * 20 + [150.0]), 20)


def test_pm_pattern_requires_upper_half_of_flag():
    b = flag_bars(retrace_to=4.92)
    assert pm_pattern(b, price_0925=4.99) is not None                   # flag range 4.92-5.00, mid 4.96
    assert pm_pattern(b, price_0925=4.93) is None


def test_clock_resample_aligns_with_missing_minutes():
    t = pd.to_datetime(["2024-03-01 14:30", "2024-03-01 14:31", "2024-03-01 14:36", "2024-03-01 14:37"], utc=True)
    b = pd.DataFrame({"t": t, "o": [1, 2, 3, 4], "h": [1, 2, 3, 4], "l": [1, 2, 3, 4], "c": [1, 2, 3, 4], "v": [1, 1, 1, 1]})
    buckets, done = resample_clock(b, 5)
    assert list(buckets.start) == [570, 575] and list(buckets.c) == [2, 4]    # 09:30-09:35, 09:35-09:40
    assert list(done) == [-1, -1, 0, 0]                                     # first bucket known complete at 09:36
