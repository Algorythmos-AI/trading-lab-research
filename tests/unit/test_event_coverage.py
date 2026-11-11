"""Coverage of the hand-kept calendars: the macro calendar per event type, and the earnings dates per desk name.

What fails CI here is only what can always be fixed at once: a malformed row, a desk name with no earnings row at
all, a scheduled expiry on a day the market is shut, and the functions themselves on synthetic rows.

Whether the calendars reach far enough ahead depends on the real date and on publishers (BLS, the companies) who
announce on their own timetable, so a hard failure would block unrelated pull requests and invite guessed dates.
Those checks read the real New York date (wt.core.clock.ET) and only warn, naming what runs short; the alarm that
acts on them belongs to the nightly host pipeline check.
"""
import csv
import datetime as dt
import json
import warnings

import pytest
import yaml

from wt.core.clock import ET
from wt.core.config import CONFIG_DIR, ROOT
from wt.risk import events

TODAY = dt.date(2026, 11, 11)
MACRO_DAYS_AHEAD = 45
MARKET_CALENDAR = ROOT / "dashboard" / "src" / "lib" / "market-calendar.json"
# The types that exist only on a trading session: an options expiry is a market event. Data releases (cpi, nfp)
# and Fed dates are set by their publishers and need no open market: BLS has released the jobs report on a market
# holiday (Good Friday, 2 April 2021), and a policy check on a closed day is simply never consulted.
SESSION_TYPES = ("quad_witching",)
# Past rows on a closed day, left as they are because past rows feed replays. The June 2026 expiry was Thursday
# 18 June (19 June was Juneteenth).
KNOWN_PAST_CLOSED = {("2026-06-19", "quad_witching")}


def _row(day: str, kind: str) -> dict:
    return {"date": dt.date.fromisoformat(day), "type": kind}


def _real_today() -> dt.date:
    return dt.datetime.now(ET).date()


# ---- coverage_by_type on synthetic rows

def test_a_type_that_reaches_past_the_horizon_is_covered_and_one_short_of_it_is_not():
    rows = [_row("2027-06-01", "fomc_decision"), _row("2026-12-01", "cpi"), _row("2026-11-20", "cpi")]
    cov = events.coverage_by_type(TODAY, 45, rows=rows)
    assert cov["fomc_decision"] == events.TypeCoverage(True, dt.date(2027, 6, 1))
    assert cov["cpi"] == events.TypeCoverage(False, dt.date(2026, 12, 1))     # the latest cpi row, 20 days out


def test_the_exact_boundary_day_counts_as_covered():
    horizon = TODAY + dt.timedelta(days=45)
    on = events.coverage_by_type(TODAY, 45, ["nfp"], rows=[_row(horizon.isoformat(), "nfp")])
    short = events.coverage_by_type(TODAY, 45, ["nfp"], rows=[_row((horizon - dt.timedelta(days=1)).isoformat(), "nfp")])
    assert on == {"nfp": events.TypeCoverage(True, horizon)}
    assert short["nfp"].ok is False


def test_a_type_with_no_rows_is_not_covered():
    cov = events.coverage_by_type(TODAY, 45, rows=[_row("2028-01-01", "fomc_decision")])
    assert cov["quad_witching"] == events.TypeCoverage(False, None)
    assert set(cov) == set(events.RECURRING_TYPES)


def test_the_one_off_type_is_left_out_and_does_not_cover_anything():
    rows = [_row("2030-01-01", "fomc_emergency"), _row("2026-11-12", "cpi")]
    cov = events.coverage_by_type(TODAY, 45, rows=rows)
    assert "fomc_emergency" not in cov and "fomc_emergency" not in events.RECURRING_TYPES
    assert cov["cpi"].ok is False


def test_one_type_as_a_bare_string_is_refused_rather_than_read_letter_by_letter():
    with pytest.raises(TypeError):
        events.coverage_by_type(TODAY, 45, "cpi", rows=[_row("2027-06-01", "cpi")])


def test_the_recurring_types_are_the_calendar_files_types_less_the_one_off():
    assert {e["type"] for e in events.events()} == set(events.RECURRING_TYPES) | {"fomc_emergency"}


def test_coverage_ok_still_looks_at_the_latest_row_of_any_type():
    # The runner arms on coverage_ok; per-type coverage is reporting only and must not change it.
    last_any = max(e["date"] for e in events.events())
    assert events.coverage_ok(last_any - dt.timedelta(days=30))
    assert not events.coverage_ok(last_any - dt.timedelta(days=29))


# ---- earnings_gaps on synthetic rows

def _e(sym: str, day: str) -> dict:
    return {"symbol": sym, "date": day, "when": "amc", "source": "press release", "quality": "confirmed"}


def test_earnings_gaps_names_a_stale_or_missing_name_with_its_last_date():
    rows = [_e("AVGO", "2026-12-09"), _e("TSLA", "2026-07-22"), _e("TSLA", "2026-10-21"), _e("AMD", "2026-08-27")]
    gaps = events.earnings_gaps(rows, ["AVGO", "TSLA", "AMD", "META"], TODAY)
    assert gaps == {"AMD": dt.date(2026, 8, 27), "META": None}           # AMD is 76 days old; TSLA's latest is 21
    assert list(gaps) == ["AMD", "META"]                                 # in the order of `names`


def test_earnings_gaps_boundary_and_max_age():
    rows = [_e("AMD", (TODAY - dt.timedelta(days=75)).isoformat())]
    assert events.earnings_gaps(rows, ["AMD"], TODAY) == {}
    assert events.earnings_gaps(rows, ["AMD"], TODAY, max_age_days=74) == {"AMD": TODAY - dt.timedelta(days=75)}
    assert events.EARNINGS_MAX_AGE_DAYS == 75


def test_earnings_gaps_passes_over_an_unreadable_date_and_reads_symbols_loosely():
    rows = [{"symbol": " avgo ", "date": "2026-12-09"}, {"symbol": "AMD", "date": ""}, {"symbol": "AMD", "date": "soon"}]
    assert events.earnings_gaps(rows, ["AVGO", "AMD"], TODAY) == {"AMD": None}
    with pytest.raises(TypeError):
        events.earnings_gaps(rows, "AMD", TODAY)


# ---- the macro calendar file

def _macro_rows() -> list[dict[str, str]]:
    with (CONFIG_DIR / "events" / "macro_events.csv").open(newline="") as f:
        return list(csv.DictReader(f))


def test_every_macro_row_is_well_formed():
    assert [(r, events.macro_row_problem(r)) for r in _macro_rows() if events.macro_row_problem(r)] == []


def test_a_malformed_macro_row_is_named_for_what_is_wrong():
    good = {"date": "2027-01-13", "time_et": "08:30", "type": "cpi", "severity": "high", "policy": "reduce",
            "source": "bls.gov/schedule/2027", "quality": "exact"}
    assert events.macro_row_problem(good) is None
    no_date, no_time = "date not exactly YYYY-MM-DD", "time_et not exactly HH:MM"
    for bad, why in (({"date": "13/01/2027"}, no_date), ({"date": " 2027-01-13"}, no_date),
                     ({"date": "2027-01-13 "}, no_date), ({"date": "20270113"}, no_date),
                     ({"date": "2027-02-30"}, no_date), ({"time_et": "25:00"}, no_time),
                     ({"time_et": "soon"}, no_time), ({"time_et": "8:30"}, no_time), ({"time_et": "08:30 "}, no_time),
                     ({"type": "CPI"}, "type not a bare code"), ({"type": " cpi"}, "type not a bare code"),
                     ({"severity": "huge"}, "unknown severity"),
                     ({"policy": "panic"}, "unknown policy"), ({"quality": "guess"}, "unknown quality"),
                     ({"source": " "}, "no source"), ({"type": ""}, "type not a bare code"),
                     ({"source": None}, "wrong number of fields"), ({None: ["extra"]}, "wrong number of fields")):
        assert events.macro_row_problem({**good, **bad}) == why, bad
    # a row too far ahead of the session is taken for a typo (only when the session date is given)
    today = dt.date(2027, 1, 13) - dt.timedelta(days=events.MACRO_MAX_AHEAD_DAYS)
    assert events.macro_row_problem(good, today) is None
    assert events.macro_row_problem(good, today - dt.timedelta(days=1)) == \
        f"date more than {events.MACRO_MAX_AHEAD_DAYS} days ahead"


def test_an_earnings_row_is_well_formed_only_in_the_exact_form_the_clone_matches():
    good = _e("NVDA", "2027-02-25")
    assert events.earnings_row_problem(good) is None
    no_date = "date not exactly YYYY-MM-DD"
    for bad, why in (({"date": " 2027-02-25"}, no_date), ({"date": "2027-02-25 "}, no_date),
                     ({"date": "20270225"}, no_date), ({"symbol": " NVDA"}, "symbol not exactly upper case without spaces"),
                     ({"symbol": "nvda"}, "symbol not exactly upper case without spaces"), ({"symbol": ""}, "no symbol"),
                     ({"when": "AMC"}, "unknown when")):
        assert events.earnings_row_problem({**good, **bad}) == why, bad
    today = dt.date(2027, 2, 25) - dt.timedelta(days=events.EARNINGS_MAX_AHEAD_DAYS)
    assert events.earnings_row_problem(good, today) is None
    assert events.earnings_row_problem(good, today - dt.timedelta(days=1)) == "date more than 120 days ahead"


def test_no_expiry_row_falls_on_a_day_the_market_is_shut():
    """Against the repo's own XNYS session list (market-calendar.json, a fixed range: deterministic)."""
    cal = json.loads(MARKET_CALENDAR.read_text())
    sessions, start, end = set(cal["sessions"]), cal["range"]["start"], cal["range"]["end"]
    closed = {(r["date"], r["type"]) for r in _macro_rows()
              if r["type"] in SESSION_TYPES and start <= r["date"] <= end and r["date"] not in sessions}
    assert closed == KNOWN_PAST_CLOSED
    assert all(d < TODAY.isoformat() for d, _ in KNOWN_PAST_CLOSED)


def test_the_real_calendar_reaching_45_days_ahead_is_a_warning_not_a_failure():
    today = _real_today()
    short = {t: str(c.last) for t, c in events.coverage_by_type(today, MACRO_DAYS_AHEAD).items() if not c.ok}
    if short:
        warnings.warn(f"config/events/macro_events.csv runs out within {MACRO_DAYS_AHEAD} days of {today} for "
                      f"{short} (type: last date): add the next dates once the publisher's schedule is out",
                      stacklevel=1)


# ---- the earnings file

def _earnings_rows() -> list[dict[str, str]]:
    with (CONFIG_DIR / "events" / "earnings.csv").open(newline="") as f:
        return list(csv.DictReader(line for line in f if line.strip() and not line.startswith("#")))


def _single_names() -> list[str]:
    return events.desk_single_names()


def _malformed(r: dict[str, str]) -> bool:
    return events.earnings_row_problem(r) is not None


def _missing(rows: list[dict[str, str]], names: list[str]) -> list[str]:
    have = {r["symbol"].strip().upper() for r in rows if not _malformed(r)}
    return [n for n in names if n not in have]


def test_the_single_names_are_read_from_the_desk_and_leave_out_the_index_funds():
    names = _single_names()
    assert "AVGO" in names and "AMD" in names and "SPY" not in names and "QQQ" not in names
    desk = yaml.safe_load((CONFIG_DIR / "options_desk.yaml").read_text())["names"]
    index = yaml.safe_load((CONFIG_DIR / "options_clone.yaml").read_text())["contract"]["index_names"]
    assert names == [n for n in desk if n not in index]
    assert events.single_names(["SPY", "AVGO", "qqq", "AMD"], ["SPY", "QQQ"]) == ["AVGO", "AMD"]


def test_every_earnings_row_is_well_formed():
    assert [r for r in _earnings_rows() if _malformed(r)] == []


def test_every_single_name_on_the_options_desk_has_an_earnings_row():
    assert _missing(_earnings_rows(), _single_names()) == []


def test_the_earnings_check_fails_without_avgos_row():
    rows = [r for r in _earnings_rows() if r["symbol"] != "AVGO"]
    assert _missing(rows, _single_names()) == ["AVGO"]


def test_a_malformed_row_does_not_count_as_a_row():
    good = _e("AVGO", "2026-12-09")
    assert _missing([good], ["AVGO"]) == []
    for bad in ({"date": ""}, {"when": "pm"}, {"quality": "guess"}, {"source": " "}):
        assert _missing([{**good, **bad}], ["AVGO"]) == ["AVGO"]


def test_stale_earnings_dates_on_the_real_clock_are_a_warning_not_a_failure():
    today = _real_today()
    gaps = events.earnings_gaps(_earnings_rows(), _single_names(), today)
    if gaps:
        warnings.warn(f"config/events/earnings.csv: no row within {events.EARNINGS_MAX_AGE_DAYS} days of {today} "
                      f"for {({n: str(d) for n, d in gaps.items()})} (name: last date): add each next date once "
                      "the company announces it", stacklevel=1)
