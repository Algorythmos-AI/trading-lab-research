"""Which contracts the tape samples, and how often (DEC-0060 section 2, EXP-0041 `recording`).

Pure functions of a contract, the stock's mid and the market calendar; the recorder and the probe share them so the
probe measures exactly what the recorder will ask for.
"""
from __future__ import annotations

import bisect
import datetime as dt
import json
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from wt.core.config import ROOT
from wt.options.chain import parse_occ

CALENDAR = ROOT / "dashboard" / "src" / "lib" / "market-calendar.json"


@dataclass(frozen=True)
class Rules:
    """EXP-0041's frozen tier rules. The probe's narrowing order changes these only by a dated README line."""
    t1_max_sessions: int = 5
    t1_strike_pct: float = 3.0
    t1_max_ask: float = 3.00
    t1_max_per_name: int = 120
    t2_max_days: int = 14
    t2_strike_pct: float = 8.0


RULES = Rules()


@lru_cache(maxsize=1)
def sessions(path: Path = CALENDAR) -> tuple[str, ...]:
    """The regular New York sessions, oldest first, from the dashboard's market calendar."""
    data = json.loads(path.read_text())
    return tuple(sorted(str(s) for s in data["sessions"]))


def sessions_to_expiry(today: dt.date, expiry: dt.date, cal: Sequence[str] | None = None) -> int | None:
    """Regular sessions from `today` to `expiry` (today is 0); None when either is not a listed session."""
    days = cal if cal is not None else sessions()
    a, b = today.isoformat(), expiry.isoformat()
    i, j = bisect.bisect_left(days, a), bisect.bisect_left(days, b)
    if i >= len(days) or days[i] != a or j >= len(days) or days[j] != b or j < i:
        return None
    return j - i


def tier(symbol: str, ask: float | None, stock_mid: float, today: dt.date, rules: Rules = RULES,
         cal: Sequence[str] | None = None) -> int | None:
    """1, 2, or None (not recorded) for one contract at one sample. Adjusted contracts are never recorded."""
    c = parse_occ(symbol)
    if c is None or stock_mid <= 0:
        return None
    off = abs(c.strike - stock_mid) / stock_mid * 100
    days = (c.expiry - today).days
    if days < 0:
        return None
    n = sessions_to_expiry(today, c.expiry, cal)
    if (n is not None and n <= rules.t1_max_sessions and off <= rules.t1_strike_pct
            and ask is not None and 0 < ask <= rules.t1_max_ask):
        return 1
    if days <= rules.t2_max_days and off <= rules.t2_strike_pct:
        return 2
    return None


def cap_tier1(candidates: Sequence[tuple[str, float]], stock_mid: float, rules: Rules = RULES) -> list[str]:
    """At most `t1_max_per_name` tier-1 symbols, nearest strikes first (ties by symbol)."""
    def dist(item: tuple[str, float]) -> tuple[float, str]:
        return (abs(item[1] - stock_mid), item[0])
    return [s for s, _ in sorted(candidates, key=dist)[:rules.t1_max_per_name]]
