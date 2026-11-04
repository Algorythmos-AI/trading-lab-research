"""The Calendar page's market days: built from XNYS, checked against NYSE's published list and the options desk."""
import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

from wt.options import levels

ROOT = Path(__file__).resolve().parents[2]
COMMITTED = ROOT / "dashboard" / "src" / "lib" / "market-calendar.json"
NYSE = json.loads((ROOT / "tests" / "fixtures" / "nyse" / "published_2026_2027.json").read_text())


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
    assert {h["date"]: h["name"] for h in CAL["holidays"]} == NYSE["holidays"]
    assert [h["date"] for h in CAL["half_days"]] == NYSE["early_closes_1pm"]
    assert {h["close_et"] for h in CAL["half_days"]} == {"13:00"}


def test_matches_the_options_desk_list():
    years = ("2026", "2027")
    assert {d for d in levels.HOLIDAYS if d[:4] in years} == {h["date"] for h in CAL["holidays"]}
    assert {d for d in levels.HALF_DAYS if d[:4] in years} == {h["date"] for h in CAL["half_days"]}
    assert levels.CALENDAR_THROUGH == CAL["range"]["end"]


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
    assert by_year == {"2026": 251, "2027": 251}


def test_unknown_holiday_name_fails_the_build():
    mod = _script()
    with pytest.raises(SystemExit):
        mod._name("Founders Day", dt.date(2026, 3, 2))
