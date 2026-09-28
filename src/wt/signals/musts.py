"""Execution musts (SPEC-0001 EXE-01..EXE-03, SCN-HOD-07). Pure checks used by setups and the runner."""
from __future__ import annotations

import math


def first_minute_volume_ok(v0: float, minimum: float = 100_000) -> bool:
    """EXE-01: the 09:30 bar traded at least `minimum` shares (Gap and Go)."""
    return v0 is not None and not math.isnan(v0) and v0 >= minimum


def spread_ok(spread_usd: float | None, maximum: float = 0.05) -> bool:
    """EXE-02 / SCN-HOD-07: NBBO spread at the signal <= maximum. Unknown spread fails (D28)."""
    return spread_usd is not None and not math.isnan(spread_usd) and 0 <= spread_usd <= maximum + 1e-9


def nearest_above(levels, price: float) -> float | None:
    """Smallest level strictly above `price` (levels: any iterable of floats), or None (blue sky)."""
    above = [x for x in levels if x is not None and x > price + 1e-9]
    return min(above) if above else None


def reward_risk_ok(trigger: float, stop: float, ceiling: float | None, min_rr: float = 2.0) -> bool:
    """EXE-03: room from the trigger to the ceiling (nearest overhead level, or the target) is at least
    `min_rr` x the risk. No ceiling (blue sky) passes."""
    risk = trigger - stop
    if risk <= 0:
        return False
    return ceiling is None or (ceiling - trigger) >= min_rr * risk - 1e-9


def next_half_dollar_above(price: float) -> float:
    """The next half- or whole-dollar mark strictly above `price` (MP-1 target)."""
    return math.floor(price * 2 + 1e-9) / 2 + 0.5
