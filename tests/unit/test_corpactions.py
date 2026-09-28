"""Point-in-time split handling (POOL-02, POOL-03, CHT-07): no fake gaps, continuous history, fail-closed flags."""
import datetime as dt

import numpy as np
import pandas as pd

from wt.data.corpactions import SplitFactors, factor_series, suspect_split

D = [dt.date(2024, 1, 1) + dt.timedelta(days=i) for i in range(10)]


def _reverse_split_bars(split_idx=5, ratio=10.0):
    """Raw closes 0.20 before a 1:ratio reverse split, 2.00 after; volume falls by the same ratio."""
    raw_c = np.array([0.20] * split_idx + [0.20 * ratio] * (len(D) - split_idx))
    raw_v = np.array([1_000_000.0] * split_idx + [1_000_000.0 / ratio] * (len(D) - split_idx))
    raw = pd.DataFrame({"symbol": "ACME", "date": D, "c": raw_c, "v": raw_v})
    adj = raw.assign(c=np.array([0.20 * ratio] * len(D)))           # vendor adjusts history with the split
    return raw, adj


def test_factor_series_is_piecewise_constant():
    raw, adj = _reverse_split_bars()
    f = factor_series(raw, adj)
    assert list(f.f.round(6)) == [0.1] * 5 + [1.0] * 5


def test_no_fake_gap_on_the_split_day():
    raw, adj = _reverse_split_bars()
    sf = SplitFactors(factor_series(raw, adj))
    prev, d = D[4], D[5]
    adj_prev = sf.adjusted_prev_close("ACME", prev, d, raw_prev_close=0.20)
    assert abs(adj_prev - 2.00) < 1e-9
    assert abs(2.00 / adj_prev - 1) < 1e-9                         # gap = 0%, not +900%


def test_history_asof_is_continuous_and_volume_rescaled():
    raw, adj = _reverse_split_bars()
    sf = SplitFactors(factor_series(raw, adj))
    h = sf.adjust_asof(raw.assign(o=raw.c, h=raw.c, l=raw.c), D[9])
    assert np.allclose(h.c, 2.0)
    assert np.allclose(h.v, 100_000.0)


def test_history_asof_before_split_keeps_old_basis():
    raw, adj = _reverse_split_bars()
    sf = SplitFactors(factor_series(raw, adj))
    h = sf.adjust_asof(raw.iloc[:5], D[4])                          # seen from before the split: unchanged
    assert np.allclose(h.c, 0.20)


def test_unknown_symbol_has_factor_one():
    sf = SplitFactors(pd.DataFrame(columns=["symbol", "date", "f"]))
    assert sf.factor("ZZZ", D[0]) == 1.0


def test_suspect_split_flags_unrecorded_split_without_dollar_surge():
    raw, _ = _reverse_split_bars()                                  # vendor did NOT adjust: jump stays
    assert suspect_split(raw)


def test_genuine_runner_is_not_a_suspect_split():
    c = np.array([1.0] * 5 + [3.0] * 5)                              # +200% on news
    v = np.array([1_000_000.0] * 5 + [20_000_000.0] + [5_000_000.0] * 4)
    assert not suspect_split(pd.DataFrame({"date": D, "c": c, "v": v}))


def test_ordinary_moves_are_not_suspect():
    rng = np.random.default_rng(0)
    c = 10 * np.cumprod(1 + rng.normal(0, 0.03, 200))
    v = rng.integers(1e5, 1e6, 200).astype(float)
    assert not suspect_split(pd.DataFrame({"date": range(200), "c": c, "v": v}))
