"""Macro-event calendar (config/events/macro_events.csv) and entry policy checks."""
from __future__ import annotations

import csv
import datetime as dt
from functools import lru_cache

from wt.core.config import CONFIG_DIR

BLACKOUT_BEFORE_MIN, BLACKOUT_AFTER_MIN = 15, 30


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
