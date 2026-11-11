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
    if isinstance(types, str):
        raise TypeError("types must be a collection of event types, not one string")
    horizon = today + dt.timedelta(days=days_ahead)
    last: dict[str, dt.date | None] = {t: None for t in types}
    for e in events() if rows is None else rows:
        t, d = e["type"], e["date"]
        if t in last:
            prev = last[t]
            last[t] = d if prev is None or d > prev else prev
    return {t: TypeCoverage(d is not None and d >= horizon, d) for t, d in last.items()}


EARNINGS_MAX_AGE_DAYS = 75

# The columns of each hand-kept file, as csv.DictReader reads them, and what a well-formed row holds. Shared by the
# CI checks (tests/unit/test_event_coverage.py) and the nightly host check (wt.options.pipeline_check), so the two
# never disagree on what counts as a row. Neither `events()` nor `coverage_ok` uses them: the paper runner reads
# the macro file as it always has.
MACRO_COLUMNS = ("date", "time_et", "type", "severity", "policy", "source", "quality")
EARNINGS_COLUMNS = ("symbol", "date", "when", "source", "quality")


def _blank(v: Any) -> bool:
    return not isinstance(v, str) or not v.strip()


def macro_row_problem(r: Mapping[str, Any]) -> str | None:
    """Why a macro_events.csv row (a csv.DictReader row) is malformed, in fixed words, or None when it is not."""
    if None in r or any(r.get(c) is None for c in MACRO_COLUMNS):
        return "wrong number of fields"
    try:
        dt.date.fromisoformat(str(r["date"]))
    except ValueError:
        return "unreadable date"
    try:
        h, m = (int(x) for x in str(r["time_et"]).split(":"))
    except ValueError:
        return "unreadable time_et"
    if not (0 <= h < 24 and 0 <= m < 60):
        return "unreadable time_et"
    if _blank(r["type"]):
        return "no type"
    if r["severity"] not in ("high", "medium"):
        return "unknown severity"
    if r["policy"] not in ("reduce", "blackout_window", "skip"):
        return "unknown policy"
    if r["quality"] not in ("exact", "approx", "derived"):
        return "unknown quality"
    if _blank(r["source"]):
        return "no source"
    return None


def earnings_row_problem(r: Mapping[str, Any]) -> str | None:
    """Why an earnings.csv row (a csv.DictReader row, comment lines skipped) is malformed, in fixed words, or None."""
    if None in r or any(r.get(c) is None for c in EARNINGS_COLUMNS):
        return "wrong number of fields"
    try:
        dt.date.fromisoformat(str(r["date"]).strip())
    except ValueError:
        return "unreadable date"
    if _blank(r["symbol"]):
        return "no symbol"
    if r["when"] not in ("bmo", "amc", "during"):
        return "unknown when"
    if r["quality"] not in ("confirmed", "expected"):
        return "unknown quality"
    if _blank(r["source"]):
        return "no source"
    return None


def single_names(names: Iterable[Any], index_names: Iterable[Any]) -> list[str]:
    """The desk's single-stock names, in order: `names` less the index funds (options_clone.yaml
    contract.index_names, SPY and QQQ), which report no earnings and are never required a row."""
    index = {str(n).strip().upper() for n in index_names}
    return [str(n) for n in names if str(n).strip().upper() not in index]


def desk_single_names() -> list[str]:
    """The Options desk's single-stock names: config/options_desk.yaml `names` less the clone's index names.
    Raises (OSError, KeyError, TypeError, yaml.YAMLError) when either file cannot be read as expected."""
    import yaml
    desk = yaml.safe_load((CONFIG_DIR / "options_desk.yaml").read_text())["names"]
    index = yaml.safe_load((CONFIG_DIR / "options_clone.yaml").read_text())["contract"]["index_names"]
    return single_names(desk, index)


def latest_earnings(rows: Iterable[Mapping[str, Any]]) -> dict[str, dt.date]:
    """Each symbol's latest earnings date (upper-cased, trimmed), passing over a row whose date cannot be read."""
    latest: dict[str, dt.date] = {}
    for r in rows:
        try:
            d = dt.date.fromisoformat(str(r.get("date") or "").strip())
        except ValueError:
            continue
        sym = str(r.get("symbol") or "").strip().upper()
        latest[sym] = max(d, latest.get(sym, d))
    return latest


def earnings_gaps(rows: Iterable[Mapping[str, Any]], names: Iterable[str], today: dt.date,
                  max_age_days: int = EARNINGS_MAX_AGE_DAYS) -> dict[str, dt.date | None]:
    """The names whose earnings dates (config/events/earnings.csv rows: `symbol`, `date`) have gone stale.

    For each of `names`, in order, whose latest row is more than `max_age_days` before `today`, that row's date;
    None for a name with no row. A name with a row inside the window, or a future one, is left out. A row whose
    date cannot be read is passed over. The next report of a name is due about a quarter after its last one, so a
    gap means its next date was never added."""
    if isinstance(names, str):
        raise TypeError("names must be a collection of symbols, not one string")
    latest = latest_earnings(rows)
    oldest = today - dt.timedelta(days=max_age_days)
    return {n: latest.get(n) for n in names if n not in latest or latest[n] < oldest}


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
