"""Property test: shuffling/perturbing FUTURE bars must never change a signal already emitted."""
import numpy as np
import pandas as pd

from wt.signals import setups


def synth(n=240, seed=0):
    rng = np.random.default_rng(seed)
    c = 10 + np.cumsum(rng.normal(0, 0.03, n))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) + rng.random(n) * 0.03
    l = np.minimum(o, c) - rng.random(n) * 0.03
    t = pd.date_range("2026-01-05 14:30", periods=n, freq="1min", tz="UTC")
    return pd.DataFrame({"t": t, "o": o, "h": h, "l": l, "c": c, "v": rng.integers(1e4, 1e5, n)})


def perturb_after(b, i, seed):
    b2 = b.copy()
    rng = np.random.default_rng(seed)
    cols = ["o", "h", "l", "c"]
    b2.loc[i + 1:, cols] = b2.loc[i + 1:, cols].to_numpy() * (1 + rng.normal(0, 0.05, (len(b2) - i - 1, 1)))
    b2["h"] = b2[cols].max(axis=1)
    b2["l"] = b2[cols].min(axis=1)
    return b2


def check(fn, **kw):
    hits = 0
    for seed in range(40):
        b = synth(seed=seed)
        s = fn(b, **kw)
        if s is None:
            continue
        hits += 1
        s2 = fn(perturb_after(b, s.bar_index, seed + 100), **kw)
        assert s2 is not None and s2.bar_index == s.bar_index and s2.trigger == s.trigger and s2.stop == s.stop
    return hits


def test_s1_bull_flag_causal():
    assert check(setups.s1_bull_flag_5m, window=(0, 240), green_min=2, red_min=1, retrace_max=0.9) > 0


def test_s2_reversal_causal():
    assert check(setups.s2_extreme_reversal, window=(0, 240), rsi_max=45, rr_min=0.1, room_min=0.0, down_min=2) > 0


def test_s3_vwap_causal():
    assert check(setups.s3_vwap_pullback, window=(0, 240), touch_tol=0.003) > 0


def test_s5_retest_causal():
    assert check(setups.s5_breakout_retest, level=10.05, window=(0, 240)) > 0


def test_pm_high_break_causal():
    assert check(setups.s1_pm_high_break, pm_high=10.1, window=(0, 240)) > 0


def test_b_intraday_momentum_causal():
    kw = dict(sigma=0.002, prev_close=9.95)
    assert check(setups.b_intraday_momentum, **kw) >= 5
    assert check(setups.b_intraday_momentum, include_last=True, **kw) >= 5      # the live runner's reading of the rule
