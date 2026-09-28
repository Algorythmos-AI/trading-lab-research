"""Random-entry controls for SPEC-0001 trials (EVL-05; plan D26).

For each real signal (symbol-day), a control seed picks a random 1-minute bar j inside the trial's window. It rests
a buy at that bar's high + $0.01 for the next bar only, with the SAME stop distance (R) as the real signal. The
control trade then goes through the same costs, collar, exits and day-level admission. Per seed, the admitted
control trades' mean R forms one draw of the control distribution. The real mean is compared with those draws
(stats.random_control_pvalue).
"""
from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

from wt.backtest.engine import EntrySignal
from wt.signals.bars import et_minutes

TICK = 0.01
WINDOWS = {"GG-1": (571, 600), "GG-2": (571, 590), "GG-3": (590, 660), "GG-4": (571, 600),
           "MP-1": (571, 690), "REV-1": (575, 930)}


def control_signal(bars: pd.DataFrame, real: EntrySignal, trial: str, seed: int) -> EntrySignal | None:
    m = et_minutes(bars)
    lo, hi = WINDOWS[trial]
    idx = np.nonzero((m >= lo) & (m < hi))[0]
    idx = idx[idx < len(bars) - 1]
    if not len(idx):
        return None
    key = f"{trial}|{bars.t.iloc[0]}|{real.trigger:.4f}|{real.stop:.4f}|{seed}"          # stable across processes
    rng = np.random.default_rng(int(hashlib.sha1(key.encode()).hexdigest()[:8], 16))
    j = int(rng.choice(idx))
    risk = real.trigger - real.stop
    trig = round(float(bars.h.iloc[j]) + TICK, 4)
    return EntrySignal(j, trig, round(trig - risk, 4), None, f"CONTROL:{trial}",
                       meta={"strict_collar": True, "expire_idx": j + 2})
