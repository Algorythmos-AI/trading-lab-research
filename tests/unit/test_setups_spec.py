"""SPEC-0001 setups (ENT-GG-1..4, ENT-MP-1, ENT-REV-1) and the execution musts (EXE-01..03) on hand-built days."""
import numpy as np
from spec_bars import flat, minute_bars

from wt.signals.musts import first_minute_volume_ok, next_half_dollar_above, reward_risk_ok, spread_ok
from wt.signals.patterns import Pattern
from wt.signals.spec_setups import (continuation_5m, gg_level_break, micro_pullback_1m, orb_ladder, red_to_green,
                                    reversal_long)


# ---------------------------------------------------------------- musts
def test_musts():
    assert first_minute_volume_ok(100_000) and not first_minute_volume_ok(99_999)
    assert spread_ok(0.05) and not spread_ok(0.06) and not spread_ok(None) and not spread_ok(float("nan"))
    assert reward_risk_ok(5.01, 4.91, 5.21) and not reward_risk_ok(5.01, 4.91, 5.20)
    assert reward_risk_ok(5.01, 4.91, None)                      # blue sky
    assert next_half_dollar_above(5.01) == 5.5 and next_half_dollar_above(5.5) == 6.0 and next_half_dollar_above(4.99) == 5.0


# ---------------------------------------------------------------- GG-1
OPEN = [(5.00, 5.05, 4.95, 5.02, 150_000)]                     # the 09:30 bar: 150k shares, high 5.05


def test_gg1_lowest_unbroken_level():
    bars = minute_bars(OPEN + flat(40, 5.02))
    pat = Pattern("bull_flag", trigger=5.10, stop=4.96, end_idx=0, high=5.20, meta={})
    sig = gg_level_break(bars, {"pm_high": 5.60, "pm_pattern": pat, "overhead": [6.00]})
    assert sig.trigger == 5.11 and sig.stop == 4.95 and sig.meta["level"] == "pm_pattern"
    assert sig.meta["expire_idx"] == 30                          # 10:00 bar


def test_gg1_skips_levels_already_broken_by_first_bar():
    bars = minute_bars(OPEN + flat(40, 5.02))
    sig = gg_level_break(bars, {"pm_high": 5.04, "overhead": []})  # 09:30 high 5.05 already above PMH
    assert sig is None


def test_gg1_stop_capped_at_20_cents_and_needs_2to1_room():
    bars = minute_bars([(5.00, 5.05, 4.50, 5.02, 150_000)] + flat(40, 5.02))
    sig = gg_level_break(bars, {"pm_high": 5.30, "overhead": [7.0]})
    assert sig.stop == round(5.31 - 0.20, 4)
    assert gg_level_break(bars, {"pm_high": 5.30, "overhead": [5.60]}) is None   # 0.29 room < 2 x 0.20


def test_gg_needs_first_minute_volume():
    bars = minute_bars([(5.00, 5.05, 4.95, 5.02, 90_000)] + flat(40, 5.02))
    assert gg_level_break(bars, {"pm_high": 5.30}) is None
    assert orb_ladder(bars, {}) is None and red_to_green(bars, {}) is None


# ---------------------------------------------------------------- GG-2
def test_orb_1m_only_on_second_candle():
    bars = minute_bars(OPEN + [(5.03, 5.10, 5.01, 5.08, 80_000)] + flat(40, 5.08))
    sig = orb_ladder(bars, {"overhead": []})
    assert sig.setup == "GG-2:orb_1m" and sig.trigger == 5.06 and sig.stop == 4.94 and sig.meta["expire_idx"] == 2


def test_orb_falls_back_to_5m_when_second_candle_does_not_break():
    rows = OPEN + [(5.02, 5.04, 4.99, 5.00, 60_000), (5.00, 5.08, 4.98, 5.06, 60_000),   # break on 3rd candle: not a 1m ORB
                   (5.06, 5.07, 5.00, 5.01, 40_000), (5.01, 5.03, 4.97, 5.02, 40_000)] + flat(40, 5.02)
    sig = orb_ladder(minute_bars(rows), {"overhead": []})
    assert sig.setup == "GG-2:orb_5m" and sig.bar_index == 4 and sig.trigger == 5.09 and sig.stop == 4.94
    assert sig.meta["expire_idx"] == 20                          # 09:50


def test_orb_goes_on_to_5m_when_the_1m_order_lacks_2to1_room():
    rows = OPEN + [(5.03, 5.20, 5.01, 5.18, 80_000), (5.18, 5.22, 5.10, 5.20, 60_000), (5.20, 5.21, 5.12, 5.15, 40_000),
                   (5.15, 5.19, 5.11, 5.16, 40_000)] + flat(40, 5.16)
    ctx = {"overhead": [5.15]}                                   # 1m ORB: 0.09 room < 2 x 0.12 risk, so no 1m order
    sig = orb_ladder(minute_bars(rows), ctx)                     # (the search used to stop here and return None)
    assert sig.setup == "GG-2:orb_5m" and sig.bar_index == 4 and sig.trigger == 5.23 and sig.stop == 4.94


# ---------------------------------------------------------------- GG-4
def test_red_to_green_needs_a_close_below_open_first():
    rows = OPEN[:1] + [(5.02, 5.03, 4.90, 4.92, 50_000), (4.92, 4.95, 4.85, 4.94, 50_000),
                       (4.94, 5.08, 4.93, 5.06, 60_000)] + flat(40, 5.06)
    rows[0] = (5.00, 5.05, 4.95, 4.98, 150_000)                  # first bar closes red
    sig = red_to_green(minute_bars(rows), {"overhead": []})
    assert sig.setup == "GG-4" and sig.bar_index == 2 and sig.trigger == 5.01 and sig.stop == 4.84
    green = [(5.00, 5.05, 4.99, 5.04, 150_000)] + [(5.04, 5.10, 5.03, 5.09, 50_000)] * 5 + flat(40, 5.09)
    assert red_to_green(minute_bars(green), {"overhead": []}) is None      # never traded below the open


def test_red_to_green_keeps_looking_after_a_bar_without_2to1_room():
    rows = [(5.00, 5.05, 4.95, 4.98, 150_000), (4.98, 5.00, 4.85, 4.90, 50_000),
            (4.90, 5.08, 4.89, 5.06, 60_000),                    # new high: trigger 5.01, stop 4.84, overhead 5.20 too near
            (5.06, 5.25, 5.05, 5.22, 60_000),                    # trigger 5.09: still under 5.20
            (5.22, 5.30, 5.20, 5.28, 60_000)] + flat(40, 5.28)   # trigger 5.26: blue sky, 2:1 holds
    sig = red_to_green(minute_bars(rows), {"overhead": [5.20]})  # (the search used to stop at the first new high)
    assert sig.setup == "GG-4" and sig.bar_index == 3 and sig.trigger == 5.26 and sig.stop == 4.84
    assert sig.meta["expire_idx"] == 5
    capped = rows[:3] + flat(40, 5.06)
    assert red_to_green(minute_bars(capped), {"overhead": [5.20]}) is None     # no later bar with room: no trade


# ---------------------------------------------------------------- GG-3
def test_continuation_5m_bull_flag_after_0945():
    pm = minute_bars(flat(60, 4.00, v=5_000), start_et="08:30")
    rows = [(4.00, 4.05, 3.98, 4.04, 150_000)] + flat(14, 4.04, v=20_000)                     # 09:30-09:45 quiet
    up = []
    for _k, (lo, hi) in enumerate([(4.04, 4.20), (4.20, 4.36), (4.36, 4.52)]):                 # 09:45-10:00: 3 green 5m bars
        up += [(lo + (hi - lo) * i / 5, lo + (hi - lo) * (i + 1) / 5, lo + (hi - lo) * i / 5 - 0.005,
                lo + (hi - lo) * (i + 1) / 5, 60_000) for i in range(5)]
    flag = [(4.52, 4.52, 4.49, 4.50, 6_000)] * 5                                              # 10:00-10:05 flag, light volume
    after = flat(60, 4.50, v=6_000)
    bars = minute_bars(rows + up + flag + after)
    sig = continuation_5m(bars, {"pm_bars": pm, "overhead": []})
    assert sig is not None and sig.setup == "GG-3:bull_flag"
    assert sig.bar_index == 34 and sig.meta["expire_idx"] == 90               # signal 10:04 close; expires 11:00


# ---------------------------------------------------------------- MP-1
def test_micro_pullback_red_candle_near_ema():
    base = [(4.00 + 0.02 * i, 4.03 + 0.02 * i, 3.99 + 0.02 * i, 4.02 + 0.02 * i, 200_000) for i in range(12)]
    pull = [(4.24, 4.245, 4.18, 4.23, 90_000)]                    # small red candle below the HOD, low at EMA9
    bars = minute_bars(base + pull + flat(10, 4.25, v=90_000))
    mask = np.ones(len(bars), bool)
    sig = micro_pullback_1m(bars, {"mp_mask": mask})
    assert sig is not None and sig.bar_index == 12 and sig.trigger == 4.255 and sig.stop == 4.17
    assert sig.target == 4.5 and sig.meta["expire_idx"] == 15


def test_micro_pullback_respects_universe_mask():
    base = [(4.00 + 0.02 * i, 4.03 + 0.02 * i, 3.99 + 0.02 * i, 4.02 + 0.02 * i, 200_000) for i in range(12)]
    bars = minute_bars(base + [(4.24, 4.245, 4.18, 4.23, 90_000)] + flat(10, 4.25))
    assert micro_pullback_1m(bars, {"mp_mask": np.zeros(len(bars), bool)}) is None


# ---------------------------------------------------------------- REV-1 (warm-up + oversold flush)
def test_reversal_long_signals_on_oversold_flush(monkeypatch):
    import wt.signals.spec_setups as ss
    monkeypatch.setattr(ss, "curve_at", lambda m, curve=None: 0.5)
    prev = minute_bars(flat(390, 50.0, v=20_000, spread=0.05), day="2024-02-29")
    rows = flat(60, 50.0, v=20_000, spread=0.05)
    px = 50.0
    for _ in range(15):                                           # 10:30-10:45: three big red 5-minute buckets
        rows.append((px, px + 0.02, px - 0.62, px - 0.60, 40_000))
        px -= 0.60
    for _ in range(5):                                            # 10:45-10:50: small-range exhaustion bucket at LOD
        rows.append((px, px + 0.01, px - 0.07, px - 0.06, 40_000))
        px -= 0.06
    rows += [(px, px + 0.3, px - 0.05, px + 0.2, 30_000)] * 10
    bars = minute_bars(rows)
    sig = reversal_long(bars, {"prev_rth": prev, "adv5": 8_000_000, "adv20": 1_000_000})
    assert sig is not None and sig.setup == "REV-1" and sig.bar_index == 79          # 10:49 bar closes the bucket
    assert sig.meta["expire_idx"] == 85 and sig.stop == 40.68        # LOD 40.69 - $0.01; trigger valid 10:50-10:55
    assert sig.target > sig.trigger and sig.target - sig.trigger >= 2 * (sig.trigger - sig.stop)


# ---------------------------------------------------------------- causality: future bars never change a signal
def _perturb_after(bars, i, seed=7):
    b = bars.astype({"o": float, "h": float, "l": float, "c": float, "v": float})
    rng = np.random.default_rng(seed)
    cols = ["o", "h", "l", "c"]
    k = len(b) - i - 1
    if k > 0:
        b.loc[i + 1:, cols] = b.loc[i + 1:, cols].to_numpy() * (1 + rng.normal(0, 0.05, (k, 1)))
        b.loc[i + 1:, "v"] = b.loc[i + 1:, "v"].to_numpy() * rng.uniform(0.2, 5.0, k)
        b["h"] = b[cols].max(axis=1)
        b["l"] = b[cols].min(axis=1)
    return b


def _same(a, b):
    return (a.bar_index, a.trigger, a.stop, a.target, a.setup) == (b.bar_index, b.trigger, b.stop, b.target, b.setup)


def test_setups_are_causal():
    pat = Pattern("bull_flag", trigger=5.10, stop=4.96, end_idx=0, high=5.20, meta={})
    cases = []
    bars = minute_bars(OPEN + flat(40, 5.02))
    cases.append((gg_level_break, bars, {"pm_high": 5.60, "pm_pattern": pat, "overhead": [6.0]}, 0))
    bars = minute_bars(OPEN + [(5.02, 5.04, 4.99, 5.00, 60_000), (5.00, 5.08, 4.98, 5.06, 60_000),
                               (5.06, 5.07, 5.00, 5.01, 40_000), (5.01, 5.03, 4.97, 5.02, 40_000)] + flat(40, 5.02))
    cases.append((orb_ladder, bars, {"overhead": []}, 1))                   # rolling: decided through the fill bar
    rows = [(5.00, 5.05, 4.95, 4.98, 150_000), (5.02, 5.03, 4.90, 4.92, 50_000), (4.92, 4.95, 4.85, 4.94, 50_000),
            (4.94, 5.08, 4.93, 5.06, 60_000)] + flat(40, 5.06)
    cases.append((red_to_green, minute_bars(rows), {"overhead": []}, 1))
    base = [(4.00 + 0.02 * i, 4.03 + 0.02 * i, 3.99 + 0.02 * i, 4.02 + 0.02 * i, 200_000) for i in range(12)]
    bars = minute_bars(base + [(4.24, 4.245, 4.18, 4.23, 90_000)] + flat(10, 4.25, v=90_000))
    cases.append((micro_pullback_1m, bars, {"mp_mask": np.ones(len(bars), bool)}, 0))
    for fn, bars, ctx, lag in cases:
        sig = fn(bars, ctx)
        assert sig is not None, fn.__name__
        for seed in range(5):
            alt = fn(_perturb_after(bars, sig.bar_index + lag, seed), ctx)
            assert alt is not None and _same(sig, alt), fn.__name__
