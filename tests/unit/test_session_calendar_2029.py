"""The exchange calendar's 2028 and 2029 (wt.options.levels): every holiday and early close by name, the boundary at
CALENDAR_THROUGH, and New York times across both clock changes of each year.

2028 is as NYSE publishes it; 2029 (to 24 December, where Alpaca's calendar ends) rests on the exchange's fixed rules
and Alpaca. tests/unit/test_market_calendar.py ties these lists to the Calendar page's file day by day.
"""
from __future__ import annotations

import datetime as dt

import pytest

from wt.options import chain, intraday
from wt.options import levels as lv
from wt.options import pipeline_check as pc

UTC = dt.UTC

HOLIDAYS = {
    # 2028: no New Year's Day holiday (1 January is a Saturday; NYSE does not move it to Friday 31 December 2027)
    "2028-01-17": "Martin Luther King Jr. Day",
    "2028-02-21": "Washington's Birthday",
    "2028-04-14": "Good Friday",
    "2028-05-29": "Memorial Day",
    "2028-06-19": "Juneteenth",
    "2028-07-04": "Independence Day",
    "2028-09-04": "Labor Day",
    "2028-11-23": "Thanksgiving Day",
    "2028-12-25": "Christmas Day",
    # 2029, to 24 December
    "2029-01-01": "New Year's Day",
    "2029-01-15": "Martin Luther King Jr. Day",
    "2029-02-19": "Washington's Birthday",
    "2029-03-30": "Good Friday",
    "2029-05-28": "Memorial Day",
    "2029-06-19": "Juneteenth",
    "2029-07-04": "Independence Day",
    "2029-09-03": "Labor Day",
    "2029-11-22": "Thanksgiving Day",
}
# 13:00 New York closes. 24 December 2028 is a Sunday, so 2028 has no Christmas Eve close.
EARLY_CLOSES = {
    "2028-07-03": "Day before Independence Day",
    "2028-11-24": "Day after Thanksgiving",
    "2029-07-03": "Day before Independence Day",
    "2029-11-23": "Day after Thanksgiving",
    "2029-12-24": "Christmas Eve",
}


def _next_weekday(d: str) -> str:
    x = dt.date.fromisoformat(d) + dt.timedelta(days=1)
    while x.weekday() >= 5:
        x += dt.timedelta(days=1)
    return x.isoformat()


def test_the_lists_are_exactly_these_days():
    assert {d for d in lv.HOLIDAYS if d >= "2028"} == set(HOLIDAYS)
    assert {d for d in lv.HALF_DAYS if d >= "2028"} == set(EARLY_CLOSES)


@pytest.mark.parametrize("day", sorted(HOLIDAYS), ids=lambda d: f"{d} {HOLIDAYS[d]}")
def test_each_holiday_is_closed_and_the_next_weekday_trades(day):
    assert dt.date.fromisoformat(day).weekday() < 5
    assert not lv.is_session(day)
    after = _next_weekday(day)
    assert lv.is_session(after)
    assert lv.next_session(day) == after
    assert lv.next_session(lv.prev_session(day)) == after


@pytest.mark.parametrize("day", sorted(EARLY_CLOSES), ids=lambda d: f"{d} {EARLY_CLOSES[d]}")
def test_each_early_close_trades_until_one_pm_new_york(day):
    assert lv.is_session(day) and day in lv.HALF_DAYS and day not in lv.HOLIDAYS
    d = dt.date.fromisoformat(day)
    bell = dt.datetime.combine(d, dt.time(13), intraday.NEW_YORK)
    assert lv.close_final_utc(day) == (bell + dt.timedelta(minutes=15)).astimezone(UTC).replace(tzinfo=None)
    assert chain.expiry_close(d) == bell
    assert intraday.slots(day)[-1][1] == bell


def test_the_first_and_last_session_of_each_year():
    assert lv.is_session("2027-12-31")                              # New Year's Day 2028 is not observed
    assert lv.next_session("2027-12-31") == "2028-01-03"
    assert lv.prev_session("2028-01-03") == "2027-12-31"
    assert lv.prev_session("2029-01-01") == "2028-12-29"            # the last session of 2028
    assert lv.next_session("2028-12-29") == "2029-01-02"            # over New Year's Day 2029
    assert lv.next_session("2029-12-21") == "2029-12-24"            # the last session the calendar covers


def test_leap_day_2028_is_a_session():
    assert lv.is_session("2028-02-29")
    assert lv.next_session("2028-02-28") == "2028-02-29" and lv.next_session("2028-02-29") == "2028-03-01"


def test_the_calendar_ends_on_2029_12_24_and_refuses_the_day_after():
    """Past CALENDAR_THROUGH is_session raises by design (a guessed session is worse than a stopped job); the
    pipeline check's calendar.sessions is what warns and pages before that."""
    assert lv.CALENDAR_THROUGH == "2029-12-24"
    assert lv.is_session("2029-12-24")
    assert lv.prev_session("2029-12-24") == "2029-12-21"
    for past in ("2029-12-25", "2029-12-26", "2030-01-02"):
        with pytest.raises(ValueError, match="calendar only covers through 2029-12-24"):
            lv.is_session(past)
    # The after-close run on the last covered session asks for the next one: the same wall 2027-12-31 was.
    with pytest.raises(ValueError, match="2029-12-24"):
        lv.next_session("2029-12-24")


def test_the_new_end_warns_from_90_days_and_pages_from_45_without_raising():
    m, e = pc.read_calendars()

    def sessions(day: str) -> pc.Check:
        return {c.id: c for c in pc.assess_calendars(day, m, e, pc.desk_names())}["calendar.sessions"]

    assert sessions("2026-11-12").ok
    assert sessions("2029-09-25").ok                                # 90 days left
    warn = sessions("2029-09-26")                                   # 89 days: the after-close run of Tue 25 Sep
    assert not warn.ok and warn.severity == "warn" and "2029-12-24" in warn.detail
    assert sessions("2029-11-09").severity == "warn"                # 45 days
    page = sessions("2029-11-12")                                   # 42 days: the after-close run of Fri 9 Nov
    assert not page.ok and page.severity == "fail"
    last = sessions("2029-12-24")
    assert not last.ok and last.severity == "fail" and "0 days after" in last.detail
    assert pc.calendar_alert([page]) == (f"{pc.CALENDAR_ALERT_KEY}:sessions", pc.CALENDAR_ALERT_PRIORITY)


# Friday before and Monday after each New York clock change: 2028-03-12, 2028-11-05, 2029-03-11, 2029-11-04.
CLOCKS = [
    ("2028-03-10", 5), ("2028-03-13", 4), ("2028-11-03", 4), ("2028-11-06", 5),
    ("2029-03-09", 5), ("2029-03-12", 4), ("2029-11-02", 4), ("2029-11-05", 5),
]


@pytest.mark.parametrize(("day", "behind"), CLOCKS)
def test_new_york_session_times_across_the_clock_changes(day, behind):
    d = dt.date.fromisoformat(day)
    assert lv.is_session(day)
    assert lv.close_final_utc(day) == dt.datetime(d.year, d.month, d.day, 16 + behind, 15)
    first, last = intraday.slots(day)[0], intraday.slots(day)[-1]
    assert first[0].astimezone(UTC) == dt.datetime(d.year, d.month, d.day, 9 + behind, 30, tzinfo=UTC)
    assert last[1].astimezone(UTC) == dt.datetime(d.year, d.month, d.day, 16 + behind, 0, tzinfo=UTC)
    assert chain.expiry_close(d).astimezone(UTC) == dt.datetime(d.year, d.month, d.day, 16 + behind, tzinfo=UTC)
