"""Clock-aligned bar helpers (SPEC-0001; plan D36).

`common.resample_5m` groups 1-minute bars by POSITION (every 5 rows), which drifts out of alignment when a
thin stock has minutes with no trades. These helpers bucket by CLOCK time (ET minute of day) instead:
bucket k of width w spans [anchor + k*w, anchor + (k+1)*w). A bucket counts as complete at 1-minute index
i once its end is <= that bar's end (bars are stamped at their start, so bar i ends at minute_i + 1).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from wt.core.clock import ET

RTH_OPEN = 9 * 60 + 30          # 09:30 ET in minutes of day
PM_OPEN = 4 * 60                 # 04:00 ET


def et_minutes(bars: pd.DataFrame) -> np.ndarray:
    """Minute of day in ET for each bar start."""
    t = pd.to_datetime(bars["t"], utc=True).dt.tz_convert(ET)
    return (t.dt.hour * 60 + t.dt.minute).to_numpy()


def resample_clock(bars: pd.DataFrame, width: int, anchor: int = RTH_OPEN) -> tuple[pd.DataFrame, np.ndarray]:
    """Resample 1-minute bars into clock-aligned `width`-minute bars.

    Returns (buckets, last_done):
      buckets: one row per non-empty bucket: k, start (minute), end (minute), o, h, l, c, v, first_i, last_i
      last_done[i]: row index in `buckets` of the last bucket complete at 1-minute index i (-1 if none).
    """
    if bars.empty:
        return pd.DataFrame(columns=["k", "start", "end", "o", "h", "l", "c", "v", "first_i", "last_i"]), np.array([], int)
    m = et_minutes(bars)
    k = (m - anchor) // width
    df = pd.DataFrame({"k": k, "o": bars.o.to_numpy(), "h": bars.h.to_numpy(), "l": bars.l.to_numpy(),
                       "c": bars.c.to_numpy(), "v": bars.v.to_numpy(), "i": np.arange(len(bars))})
    g = df.groupby("k", sort=True)
    b = pd.DataFrame({"o": g.o.first(), "h": g.h.max(), "l": g.l.min(), "c": g.c.last(), "v": g.v.sum(),
                      "first_i": g.i.min(), "last_i": g.i.max()}).reset_index()
    b["start"] = anchor + b.k * width
    b["end"] = b.start + width
    b = b[["k", "start", "end", "o", "h", "l", "c", "v", "first_i", "last_i"]].reset_index(drop=True)
    ends = b.end.to_numpy()
    bar_end = m + 1
    last_done = np.searchsorted(ends, bar_end, side="right") - 1      # buckets with end <= bar_end
    return b, last_done.astype(int)


def bucket_complete_at(b: pd.DataFrame, bars: pd.DataFrame, width: int) -> np.ndarray:
    """1-minute index at which each bucket is known complete: its last 1-minute bar if that bar ends the
    bucket; otherwise the first 1-minute bar at or after the bucket end (or -1 if the data ends first)."""
    m = et_minutes(bars)
    out = []
    for _, r in b.iterrows():
        li = int(r.last_i)
        if m[li] + 1 >= r.end:
            out.append(li)
        else:
            nxt = np.nonzero(m >= r.end)[0]
            out.append(int(nxt[0]) if len(nxt) else -1)
    return np.array(out, int)
