"""SCN-HOD (hod_mask) and SCN-REV (rev_qualifies) qualifiers on synthetic bars with a flat test volume curve."""
import numpy as np
import pandas as pd
from spec_bars import flat, minute_bars

from wt.scanner.intraday import hod_mask, rev_qualifies
from wt.signals.bars import resample_clock

CURVE = np.linspace(1 / 390, 1.0, 390)          # uniform intraday volume: share(t) = (minutes elapsed + 1) / 390


def surge_day(v_bar=200_000, price=5.0):
    rows = flat(5, price, v=10_000)                                              # 09:30-09:34 quiet
    rows += [(price + 0.05 * k, price + 0.05 * (k + 1), price + 0.05 * k - 0.01, price + 0.05 * (k + 1), v_bar)
             for k in range(15)]                                               # 09:35-09:49 new highs on volume
    return minute_bars(rows + flat(20, price + 0.75, v=5_000))


def test_hod_mask_requires_all_conditions():
    b = surge_day()
    cat = [pd.Timestamp("2024-03-01 13:00", tz="UTC")]                          # 08:00 ET headline
    m = hod_mask(b, adv20=300_000, float_shares=8e6, catalyst_times=cat, curve=CURVE)
    assert m[5:20].any() and not m[:5].any()                                  # only from 09:35, on new highs
    assert not hod_mask(b, adv20=300_000, float_shares=25e6, catalyst_times=cat, curve=CURVE).any()   # float > 20M
    assert not hod_mask(b, adv20=300_000, float_shares=8e6, catalyst_times=[], curve=CURVE).any()      # no catalyst
    late = [pd.Timestamp("2024-03-01 16:00", tz="UTC")]                          # 11:00 ET headline: after these bars
    assert not hod_mask(b, adv20=300_000, float_shares=8e6, catalyst_times=late, curve=CURVE)[:20].any()
    thin = surge_day(v_bar=40_000)                                              # never reaches 1M shares
    assert not hod_mask(thin, adv20=300_000, float_shares=8e6, catalyst_times=cat, curve=CURVE).any()
    assert not hod_mask(surge_day(price=12.0), adv20=300_000, float_shares=8e6, catalyst_times=cat, curve=CURVE).any()


def test_rev_qualifies_on_oversold_flush_only():
    prev = minute_bars(flat(390, 50.0, v=20_000, spread=0.05), day="2024-02-29")
    rows = flat(60, 50.0, v=20_000, spread=0.05)
    px = 50.0
    for _ in range(15):
        rows.append((px, px + 0.02, px - 0.62, px - 0.60, 40_000))
        px -= 0.60
    b = minute_bars(rows)
    p5, t5 = resample_clock(prev, 5)[0], resample_clock(b, 5)[0]
    p2, t2 = resample_clock(prev, 2)[0], resample_clock(b, 2)[0]
    k = len(t5) - 1
    ok, info = rev_qualifies(p5, t5, k, p2.c.to_numpy(float), t2, cum_vol=float(b.v.sum()), adv5=1e6, adv20=1e6, curve_share=0.3)
    assert ok and info["ema9_5m"] > t5.c.iloc[k]
    assert not rev_qualifies(p5, t5, 5, p2.c.to_numpy(float), t2[t2.end <= int(t5.end.iloc[5])], float(b.v[:30].sum()),
                             1e6, 1e6, 0.1)[0]                                   # before the flush: no signal
    assert not rev_qualifies(p5, t5, k, p2.c.to_numpy(float), t2, float(b.v.sum()), adv5=100_000, adv20=1e6, curve_share=0.3)[0]
