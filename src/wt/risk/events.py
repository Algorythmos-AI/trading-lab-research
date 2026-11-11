"""Macro-event calendar (config/events/macro_events.csv) and entry policy checks."""
from __future__ import annotations

import csv
import datetime as dt
from collections.abc import Iterable, Mapping
from functools import lru_cache
from typing import Any, NamedTuple

from wt.core.config import CONFIG_DIR

BLACKOUT_BEFORE_MIN, BLACKOUT_AFTER_MIN = 15, 30

# The event types that recur on a schedule and so must keep reaching into the future. One-off types
# (`fomc_emergency`) are left out: they are recorded after the fact and never scheduled ahead.
RECURRING_TYPES = ("cpi", "nfp", "fomc_decision", "fomc_minutes", "quad_witching")


class TypeCoverage(NamedTuple):
    ok: bool                 # the type's rows reach at least `days_ahead` beyond `today`
    last: dt.date | None     # the type's latest date, None when it has no rows


@lru_cache(maxsize=1)
def events() -> list[dict]:
    with open(CONFIG_DIR / "events" / "macro_events.csv") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["date"] = dt.date.fromisoformat(r["date"])
    return rows


def coverage_ok(today: dt.date, days_ahead: int = 30) -> bool:
    """Runner refuses to arm unless the calendar reaches >= days_ahead into the future."""
    return max(e["date"] for e in events()) >= today + dt.timedelta(days=days_ahead)


def coverage_by_type(today: dt.date, days_ahead: int, types: Iterable[str] = RECURRING_TYPES,
                     rows: Iterable[Mapping[str, Any]] | None = None) -> dict[str, TypeCoverage]:
    """Per event type: whether its rows reach at least `days_ahead` days beyond `today`, and its last date.

    Unlike `coverage_ok`, which looks at the latest row of any type, one type running out shows here even while
    another reaches years ahead. A type with no rows is not covered. `rows` defaults to the calendar file; rows of
    a type not in `types` are passed over. Reporting only: the paper runner arms on `coverage_ok`."""
    horizon = today + dt.timedelta(days=days_ahead)
    last: dict[str, dt.date | None] = {t: None for t in types}
    for e in events() if rows is None else rows:
        t, d = e["type"], e["date"]
        if t in last:
            prev = last[t]
            last[t] = d if prev is None or d > prev else prev
    return {t: TypeCoverage(d is not None and d >= horizon, d) for t, d in last.items()}


def policy(now_et: dt.datetime) -> tuple[str, str | None]:
    """Return ('ok'|'skip'|'reduce'|'blackout', event_type) for an entry at now_et."""
    d = now_et.date()
    worst = ("ok", None)
    for e in events():
        if e["date"] != d:
            continue
        if e["policy"] == "skip":
            return "skip", e["type"]
        if e["policy"] == "blackout_window":
            h, m = map(int, e["time_et"].split(":"))
            t = now_et.replace(hour=h, minute=m, second=0, microsecond=0)
            if t - dt.timedelta(minutes=BLACKOUT_BEFORE_MIN) <= now_et <= t + dt.timedelta(minutes=BLACKOUT_AFTER_MIN):
                return "blackout", e["type"]
        if e["policy"] == "reduce":
            worst = ("reduce", e["type"])
    return worst
