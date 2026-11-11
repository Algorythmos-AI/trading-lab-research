"""The Calendar page's market days: built from XNYS, checked against NYSE's published list, Alpaca's trading calendar
and the options desk."""
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from wt.options import levels

ROOT = Path(__file__).resolve().parents[2]
COMMITTED = ROOT / "dashboard" / "src" / "lib" / "market-calendar.json"
NYSE = json.loads((ROOT / "tests" / "fixtures" / "nyse" / "published_2026_2028.json").read_text())
ALPACA = json.loads((ROOT / "tests" / "fixtures" / "alpaca" / "calendar_2026_2029.json").read_text())
NEW_YORK = ZoneInfo("America/New_York")


def _script():
    spec = importlib.util.spec_from_file_location("build_market_calendar", ROOT / "scripts" / "build_market_calendar.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CAL = json.loads(COMMITTED.read_text())


def test_committed_file_is_what_the_script_builds():
    pytest.importorskip("exchange_calendars")
    assert COMMITTED.read_text() == _script().render(), "run `make schema` (scripts/build_market_calendar.py)"


def test_matches_nyse_published_list():
    years = tuple(NYSE["years"])
    assert years == ("2026", "2027", "2028")
    assert {h["date"]: h["name"] for h in CAL["holidays"] if h["date"][:4] in years} == NYSE["holidays"]
    assert [h["date"] for h in CAL["half_days"] if h["date"][:4] in years] == NYSE["early_closes_1pm"]
    assert {h["close_et"] for h in CAL["half_days"]} == {"13:00"}
    # NYSE: no New Year's Day holiday is observed in 2028 (1 January is a Saturday), so Friday 2027-12-31 trades.
    assert "2027-12-31" in CAL["sessions"]


def test_every_row_says_whether_nyse_has_published_its_year():
    script = _script()
    assert script.PUBLISHED_THROUGH == f"{NYSE['years'][-1]}-12-31"
    for row in CAL["holidays"] + CAL["half_days"]:
        assert row["quality"] == ("confirmed" if row["date"][:4] in NYSE["years"] else "expected"), row
    assert {r["date"] for r in CAL["holidays"] + CAL["half_days"] if r["quality"] == "expected"} == {
        "2029-01-01", "2029-01-15", "2029-02-19", "2029-03-30", "2029-05-28", "2029-06-19", "2029-07-04",
        "2029-09-03", "2029-11-22", "2029-07-03", "2029-11-23", "2029-12-24"}
    assert CAL["checked_against"] == script.CHECKED_AGAINST
    assert [c["through"] for c in CAL["checked_against"]] == [script.PUBLISHED_THROUGH, ALPACA["answered"]["last"]]


def test_matches_alpacas_calendar_over_the_whole_range():
    """The whole file, day by day, against Alpaca's answer (fetched once by hand; nothing calls it at run time)."""
    assert CAL["range"] == {"start": "2026-01-01", "end": ALPACA["answered"]["last"]}
    assert CAL["sessions"][0] == ALPACA["answered"]["first"]
    closed = set(ALPACA["closed_weekdays"])
    want, day = [], dt.date.fromisoformat(CAL["range"]["start"])
    while day.isoformat() <= CAL["range"]["end"]:
        if day.weekday() < 5 and day.isoformat() not in closed:
            want.append(day.isoformat())
        day += dt.timedelta(days=1)
    assert CAL["sessions"] == want
    assert [h["date"] for h in CAL["holidays"]] == ALPACA["closed_weekdays"]
    assert {h["date"]: h["close_et"] for h in CAL["half_days"]} == ALPACA["early_closes"]
    assert [CAL["open_et"]] == ALPACA["open_et"]
    by_year: dict[str, int] = {}
    for d in CAL["sessions"]:
        by_year[d[:4]] = by_year.get(d[:4], 0) + 1
    assert by_year == ALPACA["sessions_per_year"]


def test_matches_the_options_desk_list():
    """Python (wt.options.levels) and the page's file agree on every day of the range, close times included."""
    start = CAL["range"]["start"]
    assert {d for d in levels.HOLIDAYS if d >= start} == {h["date"] for h in CAL["holidays"]}
    assert {d for d in levels.HALF_DAYS if d >= start} == {h["date"] for h in CAL["half_days"]}
    assert levels.CALENDAR_THROUGH == CAL["range"]["end"]
    sessions = set(CAL["sessions"])
    closes = {h["date"]: h["close_et"] for h in CAL["half_days"]}
    day = dt.date.fromisoformat(start)
    while day.isoformat() <= CAL["range"]["end"]:
        iso = day.isoformat()
        assert levels.is_session(iso) == (iso in sessions), iso
        if iso in sessions:
            h, m = (int(x) for x in closes.get(iso, CAL["close_et"]).split(":"))
            bell = dt.datetime.combine(day, dt.time(h, m), NEW_YORK)
            # close_final_utc: 15 minutes after the bell, as a naive UTC time.
            final = (bell + dt.timedelta(minutes=15)).astimezone(dt.UTC).replace(tzinfo=None)
            assert levels.close_final_utc(iso) == final, iso
        day += dt.timedelta(days=1)


# The old range as the file and wt.options.levels had it before the calendar was extended to 2029 (origin/integration
# at 03a9206): per year, the sessions, the holidays (date, name) and the half days (date, close, label); and levels'
# holidays and half days up to 2027-12-31. Extending the range must not move a day inside it.
OLD_RANGE = {
    "2026": "d7b451d4fdd38ca3f7761d024d828282a3799a9630e0d50f4bebb4eb05650db5",
    "2027": "67c6ea7d6c6d785226b8a6dcbb36e58f8f8cf21496cf0eb202d998a17f20c6a9",
}
OLD_LEVELS = "b09a06508c01af7759d9ea9a4a5328948c934d25610567f1934a02395b143581"


def _digest(doc: object) -> str:
    return hashlib.sha256(json.dumps(doc, separators=(",", ":")).encode()).hexdigest()


def test_nothing_up_to_2027_changed():
    for y, want in OLD_RANGE.items():
        doc = {"sessions": [d for d in CAL["sessions"] if d[:4] == y],
               "holidays": [[h["date"], h["name"]] for h in CAL["holidays"] if h["date"][:4] == y],
               "half_days": [[h["date"], h["close_et"], h["label"]] for h in CAL["half_days"] if h["date"][:4] == y]}
        assert _digest(doc) == want, y
    old = {"holidays": sorted(d for d in levels.HOLIDAYS if d <= "2027-12-31"),
           "half_days": sorted(d for d in levels.HALF_DAYS if d <= "2027-12-31")}
    assert _digest(old) == OLD_LEVELS


def test_every_day_is_a_session_a_holiday_or_a_weekend():
    start, end = (dt.date.fromisoformat(CAL["range"][k]) for k in ("start", "end"))
    sessions = set(CAL["sessions"])
    holidays = {h["date"] for h in CAL["holidays"]}
    assert not sessions & holidays
    assert {h["date"] for h in CAL["half_days"]} <= sessions
    assert CAL["sessions"] == sorted(sessions)
    day = start
    while day <= end:
        iso = day.isoformat()
        if day.weekday() >= 5:
            assert iso not in sessions and iso not in holidays, iso
        else:
            assert (iso in sessions) != (iso in holidays), iso
        day += dt.timedelta(days=1)


def test_session_counts():
    by_year: dict[str, int] = {}
    for d in CAL["sessions"]:
        by_year[d[:4]] = by_year.get(d[:4], 0) + 1
    # 2029 stops at Monday 24 December: the 26th, 27th, 28th and 31st are past the range.
    assert by_year == {"2026": 251, "2027": 251, "2028": 251, "2029": 247}


def test_unknown_holiday_name_fails_the_build():
    mod = _script()
    with pytest.raises(SystemExit):
        mod._name("Founders Day", dt.date(2026, 3, 2))
