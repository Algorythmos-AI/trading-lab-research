"""Coverage of the hand-kept calendars: the macro calendar per event type, and the earnings dates per desk name.

The repository-data tests read the real files against the real New York date (the clock every session rule uses,
wt.core.clock.ET), like the other tests here that need today's date. That is the point of them: they pass while
the calendars reach far enough ahead and fail in CI once one is about to run out, before the dashboard goes dark.
A fixed "today" would pass forever. The function itself is tested on synthetic rows with fixed dates.
"""
import csv
import datetime as dt

import yaml

from wt.core.clock import ET
from wt.core.config import CONFIG_DIR
from wt.risk import events

TODAY = dt.date(2026, 11, 11)
MACRO_DAYS_AHEAD = 45
# A name's latest earnings row may be at most this old: a quarter (91 days) and a little slack. Past that, the
# next report is due and its date was never added.
EARNINGS_MAX_AGE_DAYS = 100


def _row(day: str, kind: str) -> dict:
    return {"date": dt.date.fromisoformat(day), "type": kind}


def _real_today() -> dt.date:
    return dt.datetime.now(ET).date()


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


def test_the_recurring_types_are_the_calendar_files_types_less_the_one_off():
    assert {e["type"] for e in events.events()} == set(events.RECURRING_TYPES) | {"fomc_emergency"}


def test_coverage_ok_still_looks_at_the_latest_row_of_any_type():
    # The runner arms on coverage_ok; per-type coverage is reporting only and must not change it.
    last_any = max(e["date"] for e in events.events())
    assert events.coverage_ok(last_any - dt.timedelta(days=30))
    assert not events.coverage_ok(last_any - dt.timedelta(days=29))


def test_every_recurring_type_in_the_real_calendar_reaches_45_days_ahead():
    today = _real_today()
    cov = events.coverage_by_type(today, MACRO_DAYS_AHEAD)
    short = {t: str(c.last) for t, c in cov.items() if not c.ok}
    assert not short, (f"config/events/macro_events.csv runs out within {MACRO_DAYS_AHEAD} days of {today} "
                       f"for {short}: add the next dates from the publisher's schedule")


def _earnings_rows() -> list[dict[str, str]]:
    with (CONFIG_DIR / "events" / "earnings.csv").open(newline="") as f:
        return list(csv.DictReader(line for line in f if line.strip() and not line.startswith("#")))


def _single_names() -> list[str]:
    names = yaml.safe_load((CONFIG_DIR / "options_desk.yaml").read_text())["names"]
    index = yaml.safe_load((CONFIG_DIR / "options_clone.yaml").read_text())["contract"]["index_names"]
    return [str(n) for n in names if n not in index]


def _covered(rows: list[dict[str, str]], names: list[str], today: dt.date) -> dict[str, str]:
    """Each name that is not covered, and why. Covered: the name has a well-formed row (a readable date, bmo, amc
    or during, confirmed or expected, a named source) and its latest such row is at most EARNINGS_MAX_AGE_DAYS
    before today. It does not demand a future date: most companies announce only weeks ahead."""
    latest: dict[str, dt.date] = {}
    for r in rows:
        try:
            d = dt.date.fromisoformat(r["date"].strip())
        except ValueError:
            continue
        if (r["when"] in ("bmo", "amc", "during") and r["quality"] in ("confirmed", "expected")
                and r["source"].strip()):
            sym = r["symbol"].strip().upper()
            latest[sym] = max(d, latest.get(sym, d))
    oldest = today - dt.timedelta(days=EARNINGS_MAX_AGE_DAYS)
    return {n: ("no row" if n not in latest else f"latest row {latest[n]}") for n in names
            if n not in latest or latest[n] < oldest}


def test_the_single_names_are_read_from_the_desk_and_leave_out_the_index_funds():
    names = _single_names()
    assert "AVGO" in names and "AMD" in names and "SPY" not in names and "QQQ" not in names


def test_every_single_name_on_the_options_desk_has_a_recent_earnings_row():
    today = _real_today()
    missing = _covered(_earnings_rows(), _single_names(), today)
    assert not missing, f"config/events/earnings.csv does not cover {missing} as of {today}"


def test_the_earnings_check_fails_without_avgos_row():
    rows = [r for r in _earnings_rows() if r["symbol"] != "AVGO"]
    assert _covered(rows, _single_names(), TODAY) == {"AVGO": "no row"}


def test_the_earnings_check_fails_on_a_stale_or_malformed_row():
    names = ["AVGO"]
    good = {"symbol": "AVGO", "date": "2026-12-09", "when": "amc", "source": "press release", "quality": "confirmed"}
    assert _covered([good], names, TODAY) == {}
    assert _covered([good], names, dt.date(2027, 3, 20)) == {"AVGO": "latest row 2026-12-09"}
    for bad in ({"date": ""}, {"when": "pm"}, {"quality": "guess"}, {"source": " "}):
        assert _covered([{**good, **bad}], names, TODAY) == {"AVGO": "no row"}
