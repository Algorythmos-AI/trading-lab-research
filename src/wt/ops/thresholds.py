"""Operational thresholds: the single source for the jobs, the collector and the dashboard.

`scripts/gen_thresholds_ts.py` writes these into dashboard/src/lib/thresholds.gen.ts, so the dashboard's tones
come from the same numbers even when the snapshot is stale. Change a value here, then run `make schema`.

Disk is measured one way everywhere: free bytes on the volume that holds the repository, in decimal gigabytes
(1 GB = 10^9 bytes), the unit the jobs' floor has always used.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from wt.core.config import ROOT

DISK_FLOOR_GB = 3.0        # below this the trading jobs refuse (paper-b runs exits-only if it holds a position)
DISK_TARGET_GB = 15.0      # keep at least this free: under it the dashboard shows amber
SWAP_WARN_PCT = 85.0       # swap use above this is amber (swap files eat the same disk)
MIN_TRADES_STATS = 20      # below this many trades: no win rate CI, profit factor or Sharpe (they'd mislead)
MIN_SESSIONS_SHARPE = 30   # Sharpe needs at least this many eligible sessions
LOSS_LIMIT_AMBER = 0.5     # a loss limit is amber once half of it is used (red at the latch)

PUBLIC = {"DISK_FLOOR_GB": DISK_FLOOR_GB, "DISK_TARGET_GB": DISK_TARGET_GB, "SWAP_WARN_PCT": SWAP_WARN_PCT,
          "MIN_TRADES_STATS": MIN_TRADES_STATS, "MIN_SESSIONS_SHARPE": MIN_SESSIONS_SHARPE,
          "LOSS_LIMIT_AMBER": LOSS_LIMIT_AMBER}


def disk_free_gb(path: Path | None = None) -> float:
    """Free space in decimal GB on the volume holding ``path`` (default: the repository)."""
    return shutil.disk_usage(path or ROOT).free / 1e9


def disk_total_gb(path: Path | None = None) -> float:
    return shutil.disk_usage(path or ROOT).total / 1e9


def disk_tone(free_gb: float) -> str:
    """good | warn | bad, the same rule the dashboard applies."""
    if free_gb < DISK_FLOOR_GB:
        return "bad"
    return "warn" if free_gb < DISK_TARGET_GB else "good"
