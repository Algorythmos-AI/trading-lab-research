"""Write dashboard/src/lib/market-calendar.json from the XNYS exchange calendar (run by `make schema`).

The Calendar page's open days, holidays and half days come from here, never typed by hand. The range is fixed
(START..END), not the library's default window, so the output does not depend on the day it is run; the drift test
in tests/unit/test_market_calendar.py regenerates it and compares byte for byte, and checks it against NYSE's
published list (tests/fixtures/nyse/published_2026_2028.json) and against Alpaca's trading calendar as fetched once
by hand (tests/fixtures/alpaca/calendar_2026_2029.json). Needs the dev lock (exchange-calendars).

The range ends on 2029-12-31, a whole year. Alpaca's calendar answered only to Monday 2029-12-24 (ALPACA_THROUGH), so
the days after it (Christmas 2029 and the sessions of the 26th, 27th, 28th and 31st) rest on the library's rules
alone. Each holiday and half day carries a quality: "confirmed" through PUBLISHED_THROUGH, the end of the last year
NYSE's own page lists; "expected" after it while Alpaca agrees; and "rule" after ALPACA_THROUGH, where nothing but
the exchange's fixed rules in the pinned library stands behind the day. `checked_against` says the same per range.

A macro or earnings row after END fails the build: the page would not show it, and a release left out in silence is
worse than a stopped build. Rows before START are the history the paper runners and the backtests read; the page
draws no year before START, so they are left out of this file by design.

It also carries, for the same range, the repo's own event calendars as they stand: config/events/macro_events.csv
(the dates the paper runners trade around), config/events/earnings.csv and the Options desk's names
(config/options_desk.yaml). Dates, codes and tickers only: no source notes. The drift test fails when one of those
files changes and this one is not rebuilt.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dashboard" / "src" / "lib" / "market-calendar.json"
START, END = "2026-01-01", "2029-12-31"
# The last day of the last year NYSE publishes (its Holidays and Trading Hours page, read 2026-11-12: 2026 to 2028).
PUBLISHED_THROUGH = "2028-12-31"
# The last day Alpaca's /v2/calendar listed when it was fetched by hand (2026-11-12): it lists nothing after it.
ALPACA_THROUGH = "2029-12-24"
RULE_FROM = "2029-12-25"
# What the generated days were checked against, for the reader of the file. The checks themselves are the tests.
CHECKED_AGAINST = [
    {"source": "NYSE Holidays and Trading Hours", "read_on": "2026-11-12", "from": START, "through": PUBLISHED_THROUGH},
    {"source": "Alpaca /v2/calendar", "read_on": "2026-11-12", "from": START, "through": ALPACA_THROUGH},
    {"source": "exchange_calendars XNYS rules only", "from": RULE_FROM, "through": END,
     "note": f"rule only: after Alpaca's last listed day, {ALPACA_THROUGH}, and not published by NYSE"},
]
MACRO = ROOT / "config" / "events" / "macro_events.csv"
EARNINGS = ROOT / "config" / "events" / "earnings.csv"
DESK = ROOT / "config" / "options_desk.yaml"
CODE = r"^[a-z][a-z0-9_]{0,39}$"

# The library's rule names, in the words NYSE publishes. An unknown name fails the build rather than guessing.
HOLIDAY_NAMES = {
    "New Year's Day": "New Year's Day",
    "Dr. Martin Luther King Jr. Day": "Martin Luther King Jr. Day",
    "President's Day": "Washington's Birthday",
    "Good Friday": "Good Friday",
    "Memorial Day": "Memorial Day",
    "Juneteenth National Independence Day": "Juneteenth",
    "July 4th": "Independence Day",
    "Labor Day": "Labor Day",
    "Thanksgiving": "Thanksgiving Day",
    "Christmas": "Christmas Day",
}
# The fixed-date holidays: on any other date the closure is the observed day.
FIXED = {"New Year's Day": "01-01", "Juneteenth": "06-19", "Independence Day": "07-04", "Christmas Day": "12-25"}
HALF_DAY_NAMES = {
    "Black Friday": "Day after Thanksgiving",
    "Christmas Eve": "Christmas Eve",
    "Day Before Independence Day": "Day before Independence Day",
}


def _name(raw: str, day: dt.date) -> str:
    if raw not in HOLIDAY_NAMES:
        raise SystemExit(f"unknown XNYS holiday name {raw!r} on {day}: add it to HOLIDAY_NAMES")
    name = HOLIDAY_NAMES[raw]
    fixed = FIXED.get(name)
    return f"{name} (observed)" if fixed and day.strftime("%m-%d") != fixed else name


def _half_label(raw: str, day: dt.date) -> str:
    if day.month == 7 and day.day in (2, 3):
        return "Day before Independence Day"
    if raw not in HALF_DAY_NAMES:
        raise SystemExit(f"unknown XNYS early close {raw!r} on {day}: add it to HALF_DAY_NAMES")
    return HALF_DAY_NAMES[raw]


def _quality(day: dt.date) -> str:
    """The row's quality: "confirmed" when NYSE has published the day's year, "expected" when only Alpaca and the
    rules stand behind it, "rule" past ALPACA_THROUGH, where only the rules do."""
    iso = day.isoformat()
    if iso <= PUBLISHED_THROUGH:
        return "confirmed"
    return "expected" if iso <= ALPACA_THROUGH else "rule"


def _rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as f:
        return list(csv.DictReader(line for line in f if line.strip() and not line.startswith("#")))


def events() -> dict[str, Any]:
    import re

    import yaml

    for path, col in ((MACRO, "date"), (EARNINGS, "date")):
        late = [r[col] for r in _rows(path) if r[col] > END]
        if late:
            raise SystemExit(f"{path.name}: {len(late)} rows after the calendar's end {END} ({', '.join(late[:5])}): "
                             "extend END first")
    macro = []
    for r in _rows(MACRO):
        if START <= r["date"] <= END:
            if not re.match(CODE, r["type"]) or not re.match(r"^\d{2}:\d{2}$", r["time_et"]):
                raise SystemExit(f"{MACRO.name}: bad row {r}")
            macro.append({"date": r["date"], "time_et": r["time_et"], "code": r["type"], "quality": r["quality"]})
    earnings = []
    for r in _rows(EARNINGS):
        if START <= r["date"] <= END:
            if r["when"] not in ("bmo", "amc", "during") or r["quality"] not in ("confirmed", "expected"):
                raise SystemExit(f"{EARNINGS.name}: bad row {r}")
            earnings.append({"date": r["date"], "symbol": r["symbol"], "when": r["when"], "quality": r["quality"]})
    names = yaml.safe_load(DESK.read_text())["names"]
    return {
        "macro": sorted(macro, key=lambda e: (e["date"], e["time_et"], e["code"])),
        "earnings": sorted(earnings, key=lambda e: (e["date"], e["symbol"])),
        "options_names": [str(n) for n in names],
    }


def build() -> dict[str, Any]:
    import exchange_calendars as xcals
    import pandas as pd
    from zoneinfo import ZoneInfo

    ny = ZoneInfo("America/New_York")
    cal = xcals.get_calendar("XNYS", start=START, end=END)
    lo, hi = pd.Timestamp(START), pd.Timestamp(END)
    sessions = [ts.date() for ts in cal.sessions]
    if sessions[0] > dt.date.fromisoformat(START) + dt.timedelta(days=7) or sessions[-1] < dt.date.fromisoformat(END) - dt.timedelta(days=7):
        raise SystemExit(f"XNYS sessions cover {sessions[0]}..{sessions[-1]}, not {START}..{END}")

    regular = {ts.date(): str(n) for ts, n in cal.regular_holidays.holidays(lo, hi, return_name=True).items()}
    adhoc = {ts.date() for ts in cal.adhoc_holidays if lo <= ts <= hi}
    named_closes: dict[dt.date, str] = {}
    for _, rules in cal.special_closes:
        for ts, n in rules.holidays(lo, hi, return_name=True).items():
            named_closes[ts.date()] = str(n)

    session_set = set(sessions)
    holidays = []
    day = dt.date.fromisoformat(START)
    while day <= dt.date.fromisoformat(END):
        if day.weekday() < 5 and day not in session_set:
            if day in regular:
                holidays.append({"date": day.isoformat(), "name": _name(regular[day], day), "quality": _quality(day)})
            elif day in adhoc:
                holidays.append({"date": day.isoformat(), "name": "Special closure", "quality": _quality(day)})
            else:
                raise SystemExit(f"{day} is a weekday with no session and no XNYS holiday rule")
        day += dt.timedelta(days=1)

    half_days = []
    for ts in cal.early_closes:
        d = ts.date()
        close = cal.session_close(ts).tz_convert(ny)
        half_days.append({
            "date": d.isoformat(),
            "close_et": close.strftime("%H:%M"),
            "label": _half_label(named_closes.get(d, ""), d),
            "quality": _quality(d),
        })

    return {
        "source": "exchange_calendars XNYS",
        "generated_with": f"exchange-calendars {xcals.__version__}",
        "range": {"start": START, "end": END},
        "checked_against": CHECKED_AGAINST,
        "open_et": "09:30",
        "close_et": "16:00",
        "sessions": [d.isoformat() for d in sessions],
        "holidays": holidays,
        "half_days": sorted(half_days, key=lambda h: h["date"]),
        **events(),
    }


def render() -> str:
    return json.dumps(build(), indent=1) + "\n"


if __name__ == "__main__":
    OUT.write_text(render())
    print(f"wrote {OUT.relative_to(ROOT)}", file=sys.stderr)
