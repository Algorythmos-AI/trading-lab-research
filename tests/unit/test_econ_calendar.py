"""The economic calendar job (wt.ops.econ_calendar), on recorded sources: no network.

tests/fixtures/econ_calendar/ holds the Fed's FOMC calendar page, the BLS .ics schedule and the BEA schedule page,
trimmed from what they served on 2026-11-05, and a FRED fixture in the shape FRED documents (recording a real one
needs the owner's key).
"""
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

import pytest

from wt.ops import econ_calendar as ec

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures" / "econ_calendar"
FED = (FIX / "fomc_calendars.html").read_text()
# The Fed's page as served on 2026-11-12, every year panel it had (2021 to 2027): the real wording of two-month
# meetings ("Jan/Feb", "Apr/May", "Oct/Nov") and of a notation vote.
FED_REAL = (FIX / "fomc_calendars_2026-11-12.html").read_text()
BLS = (FIX / "bls.ics").open(newline="").read()
BEA = (FIX / "bea_schedule.html").read_text()
FRED = json.loads((FIX / "fred.json").read_text())["releases"]
NOW = dt.datetime(2026, 11, 7, 15, 0, tzinfo=dt.UTC)      # Saturday 10:00 New York
ENV = {"FRED_API_KEY": "k", "WT_CONTACT_EMAIL": "owner@example.com"}


def fake_get(fred=FRED, fed=FED, bls=BLS, bea=BEA, down=()):
    def get(url, params):
        for name in down:
            if name in url:
                raise ec.SourceError("HTTP 503")
        if url.startswith(ec.FRED_URL):
            rel = fred[params["release_id"]]
            return json.dumps(rel["dates"] if url.endswith("/dates") else rel["release"])
        return {ec.FED_URL: fed, ec.BLS_URL: bls, ec.BEA_URL: bea}[url]
    return get


def drop_panel(page: str, year: int) -> str:
    """The Fed page without one year's panel (heading and meetings), as when it is taken down."""
    i = page.index(f">{year} FOMC Meetings<")
    j = min((page.index(f">{y} FOMC Meetings<") for y in range(2000, 2100)
             if f">{y} FOMC Meetings<" in page and page.index(f">{y} FOMC Meetings<") > i), default=len(page))
    return page[:i] + page[j:]


def run(tmp_path, get, env=ENV, clock=NOW, dry=True):
    code = ec.run(dry, get=get, env=dict(env), out=tmp_path, clock=clock)
    return code, json.loads((tmp_path / "outbox" / "document.json").read_text())


# ---- parsers -----------------------------------------------------------------------------------------------------

def test_fed_page_gives_every_decision_day():
    got = sorted(d for _, d in ec.parse_fed(FED, [2026, 2027]))
    assert got == ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28",
                   "2026-12-09", "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15",
                   "2027-10-27", "2027-12-08"]


def test_fed_dates_match_the_trading_calendar():
    csv = {line.split(",")[0] for line in (ROOT / "config/events/macro_events.csv").read_text().splitlines()
           if ",fomc_decision," in line and line[:4] in ("2026", "2027")}
    assert {d for _, d in ec.parse_fed(FED, [2026, 2027])} == csv


def _panel(rows):
    meetings = "".join(f'<div class="fomc-meeting__month"><strong>{m}</strong></div><div class="fomc-meeting__date">{d}</div>' for m, d in rows)
    return f"<h4><a>2030 FOMC Meetings</a></h4>{meetings}<h4><a>2029 FOMC Meetings</a></h4>"


# Every scheduled decision on the Fed's page of 2026-11-12, read by hand from it. Each past one equals the date of the
# statement the page links for it (monetaryYYYYMMDDa.htm); 2023's "Jan/Feb 31-1" meeting was decided on 1 February.
REAL_DECISIONS = {
    2021: ["2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15"],
    2022: ["2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14"],
    2023: ["2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13"],
    2024: ["2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18"],
    2025: ["2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10"],
    2026: ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"],
    2027: ["2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08"],
}


@pytest.mark.parametrize("year", sorted(REAL_DECISIONS))
def test_every_year_on_the_real_page_reads_eight_meetings(year):
    got = sorted(d for _, d in ec.parse_fed(FED_REAL, [year]))
    assert got == REAL_DECISIONS[year]
    panel = ec.fed_panels(FED_REAL)[year]
    statements = {f"{d[:4]}-{d[4:6]}-{d[6:]}" for d in re.findall(r"/pressreleases/monetary(\d{8})a\.htm", panel)}
    # Every statement the page links is a decision read, but the notation vote of 22 August 2025.
    assert statements - set(got) == ({"2025-08-22"} if year == 2025 else set())
    assert statements <= set(got) | {"2025-08-22"}


def test_the_real_page_lists_these_years_and_its_two_month_meetings_read():
    assert sorted(ec.fed_panels(FED_REAL)) == sorted(REAL_DECISIONS)
    assert "Jan/Feb" in FED_REAL and "Apr/May" in FED_REAL and "Oct/Nov" in FED_REAL and "notation vote" in FED_REAL
    assert {"2023-02-01", "2023-11-01", "2024-05-01"} <= {d for _, d in ec.parse_fed(FED_REAL, [2023, 2024])}
    assert "2025-08-22" not in {d for _, d in ec.parse_fed(FED_REAL, [2025])}


@pytest.mark.parametrize(("month", "day", "want"), [
    ("Jan/Feb", "31-1", "2030-02-01"), ("JAN/FEB", "31-1", "2030-02-01"), ("January/February", "31-1", "2030-02-01"),
    ("Jan/February", "31-1", "2030-02-01"), ("Apr/May", "30-1", "2030-05-01"), ("Oct/Nov", "31-1", "2030-11-01"),
    ("Sept", "16-17", "2030-09-17"), ("Dec", "9-10*", "2030-12-10"),
])
def test_a_month_reads_in_full_or_abbreviated_in_either_part(month, day, want):
    rows = [(month, day)] + [("July", f"{d}-{d + 1}") for d in range(1, 15, 2)]
    assert want in {d for _, d in ec.parse_fed(_panel(rows), [2030])}


def test_fed_skips_unscheduled_and_reads_a_meeting_across_two_months():
    rows = [("January", "28-29"), ("March", "18-19"), ("Apr/May", "30-1"), ("June", "17-18"), ("July", "29-30"),
            ("August (unscheduled)", "12"), ("September", "16-17"), ("October", "28-29"), ("December", "9-10"),
            ("December", "20 (notation vote)")]
    got = sorted(d for _, d in ec.parse_fed(_panel(rows), [2030]))
    assert "2030-05-01" in got and "2030-08-12" not in got and "2030-12-20" not in got and len(got) == 8


def test_fed_reads_a_later_year_only_when_published_and_needs_the_years_begun():
    page = _panel([("January", "28-29"), ("March", "18-19"), ("Apr/May", "30-1"), ("June", "17-18"),
                   ("July", "29-30"), ("September", "16-17"), ("October", "28-29"), ("December", "9-10")])
    assert len(ec.parse_fed(page, [2030, 2031], required=[2030])) == 8      # 2031 has no panel yet: no rows
    with pytest.raises(ec.SourceError, match="no 2031 panel"):
        ec.parse_fed(page, [2030, 2031])                                    # unless it is required
    with pytest.raises(ec.SourceError, match="no 2032 panel"):
        ec.parse_fed(page, [2030, 2032], required=[2030, 2032])


def test_the_whole_market_range_fits_the_schema_even_with_nothing_announced():
    """The worst case for the range to 2029: every code's last date in the first month, the rest not announced."""
    start, end = ec.market_range()
    one = {(c, start) for c in [*ec.FRED_RELEASES, "fomc_decision"]}
    rows = {"fred": one, "fed": {r for r in one if r[0] == "fomc_decision"}, "bls": set(), "bea": set()}
    doc = ec.build(rows, [], start, end, "r", "2026-11-12T00:00:00Z")
    assert len(doc["not_announced"]) == (len(ec.FRED_RELEASES) + 1) * (len(ec._months(start, end)) - 1)
    assert ec.validate({**doc, "sources": []}) == []


def test_fed_fails_on_a_page_it_cannot_read():
    with pytest.raises(ec.SourceError):
        ec.parse_fed(_panel([("January", "28-29")]), [2030])
    with pytest.raises(ec.SourceError, match="unreadable meeting"):
        ec.parse_fed(_panel([("Janvier", "28-29")] + [("July", f"{d}-{d + 1}") for d in range(1, 15, 2)]), [2030])
    with pytest.raises(ec.SourceError):
        ec.parse_fed("<html>maintenance</html>", [2026])


def test_bls_schedule():
    got = ec.parse_bls(BLS)
    assert sorted(d for c, d in got if c == "cpi") == ["2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10"]
    assert sorted(d for c, d in got if c == "nfp") == ["2026-09-04", "2026-10-02", "2026-11-06", "2026-12-04"]
    assert {c for c, _ in got} == {"cpi", "ppi", "nfp", "jolts"}
    with pytest.raises(ec.SourceError):
        ec.parse_bls("<html>Access Denied</html>")


def test_bea_schedule_keeps_gdp_estimates_and_pce_only():
    got = ec.parse_bea(BEA)
    assert sorted(got) == [("gdp", "2026-11-25"), ("gdp", "2026-12-23"), ("pce", "2026-11-25"), ("pce", "2026-12-23")]


def test_fred_name_check():
    ec.parse_fred_name(json.dumps(FRED["10"]["release"]), "cpi")
    with pytest.raises(ec.SourceError):
        ec.parse_fred_name(json.dumps(FRED["46"]["release"]), "cpi")


# ---- the document ------------------------------------------------------------------------------------------------

def test_every_source_read_gives_a_valid_checked_document(tmp_path):
    code, doc = run(tmp_path, fake_get())
    assert code == 0
    assert ec.validate(doc) == []
    cpi = [e for e in doc["events"] if e["code"] == "cpi"]
    assert [e["date"] for e in cpi] == ["2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10"]
    assert all(e["source"] == "fred" and e["checked_by"] == ["bls"] and e["time_et"] == "08:30" for e in cpi)
    fomc = [e for e in doc["events"] if e["code"] == "fomc_decision"]
    assert len(fomc) == 16 and all(e["source"] == "fed" and e["time_et"] == "14:00" for e in fomc)
    assert doc["disagreements"] == []
    assert {s["id"]: (s["configured"], s["ok"]) for s in doc["sources"]} == {k: (True, True) for k in ec.SOURCES}


def test_months_past_the_last_published_date_are_not_yet_announced(tmp_path):
    _, doc = run(tmp_path, fake_get())
    cpi = [n["month"] for n in doc["not_announced"] if n["code"] == "cpi"]
    assert cpi == [f"{y}-{m:02d}" for y in (2027, 2028, 2029) for m in range(1, 13)]
    # The Fed has published all of 2027 and nothing later: the market calendar reaches 2029, so 2028 and 2029 are
    # not yet announced, and the source is not failed for it.
    fomc = [n["month"] for n in doc["not_announced"] if n["code"] == "fomc_decision"]
    assert fomc == [f"{y}-{m:02d}" for y in (2028, 2029) for m in range(1, 13)]
    assert next(s for s in doc["sources"] if s["id"] == "fed")["ok"]
    assert ec.validate(doc) == []


def test_without_a_fred_key_the_agencies_stand_in(tmp_path):
    code, doc = run(tmp_path, fake_get(), env={"WT_CONTACT_EMAIL": "owner@example.com"})
    assert code == 0
    fred = next(s for s in doc["sources"] if s["id"] == "fred")
    assert fred == {"id": "fred", "configured": False, "ok": False, "fetched_at": None, "stale_since": None, "rows": 0}
    assert {e["source"] for e in doc["events"] if e["code"] == "cpi"} == {"bls"}
    assert {e["source"] for e in doc["events"] if e["code"] == "gdp"} == {"bea"}
    assert not [e for e in doc["events"] if e["code"] == "retail_sales"]


def test_without_a_contact_bls_is_not_asked(tmp_path):
    asked = []

    def get(url, params):
        asked.append(url)
        return fake_get()(url, params)
    _, doc = run(tmp_path, get, env={"FRED_API_KEY": "k"})
    assert ec.BLS_URL not in asked
    assert next(s for s in doc["sources"] if s["id"] == "bls")["configured"] is False


def test_a_wrong_fred_id_fails_the_source_and_the_agency_stands_in(tmp_path):
    fred = json.loads(json.dumps(FRED))
    fred["10"]["release"]["releases"][0]["name"] = "Something Else"
    code, doc = run(tmp_path, fake_get(fred=fred))
    assert code == 1
    assert next(s for s in doc["sources"] if s["id"] == "fred")["ok"] is False
    assert {e["source"] for e in doc["events"] if e["code"] == "cpi"} == {"bls"}


def test_a_disagreement_is_shown_with_both_dates(tmp_path):
    fred = json.loads(json.dumps(FRED))
    for r in fred["10"]["dates"]["release_dates"]:
        if r["date"] == "2026-11-10":
            r["date"] = "2026-11-12"
    _, doc = run(tmp_path, fake_get(fred=fred))
    assert doc["disagreements"] == [{"code": "cpi", "month": "2026-11", "source": "fred", "dates": ["2026-11-12"],
                                     "other_source": "bls", "other_dates": ["2026-11-10"]}]


# ---- last good ---------------------------------------------------------------------------------------------------

def test_a_source_that_goes_down_keeps_its_last_good_rows(tmp_path):
    assert run(tmp_path, fake_get())[0] == 0
    later = NOW + dt.timedelta(days=7)
    code, doc = run(tmp_path, fake_get(down=("federalreserve",)), clock=later)
    assert code == 1
    fed = next(s for s in doc["sources"] if s["id"] == "fed")
    assert fed["ok"] is False and fed["rows"] == 16 and fed["fetched_at"] == NOW.isoformat()
    assert fed["stale_since"] == later.isoformat()
    assert len([e for e in doc["events"] if e["code"] == "fomc_decision"]) == 16
    # Still down a week on: it has been stale since the first failed run, not the latest.
    _, doc = run(tmp_path, fake_get(down=("federalreserve",)), clock=later + dt.timedelta(days=7))
    assert next(s for s in doc["sources"] if s["id"] == "fed")["stale_since"] == later.isoformat()
    # Back: fresh again.
    code, doc = run(tmp_path, fake_get(), clock=later + dt.timedelta(days=14))
    assert code == 0 and next(s for s in doc["sources"] if s["id"] == "fed")["stale_since"] is None


def fed_status(doc):
    return next(s for s in doc["sources"] if s["id"] == "fed")


def test_with_no_previous_read_a_next_year_panel_not_there_passes_and_says_so(tmp_path, capsys):
    code, doc = run(tmp_path, fake_get(fed=drop_panel(FED, 2027)))
    assert code == 0
    fed = fed_status(doc)
    assert fed["ok"] is True and fed["rows"] == 8 and "note" not in fed
    # Said in the job's log, not in the document (the dashboard's schema has no place for it).
    assert "fed: no panel yet for 2027, 2028, 2029: not yet announced, not missing" in capsys.readouterr().out.splitlines()
    assert [n["month"] for n in doc["not_announced"] if n["code"] == "fomc_decision"][:2] == ["2027-01", "2027-02"]
    assert ec.validate(doc) == []


def test_a_heading_with_words_after_it_is_still_that_years_panel(tmp_path, capsys):
    suffixed = FED.replace(">2027 FOMC Meetings<", ">2027 FOMC Meetings (tentative)<")
    assert sorted(ec.fed_panels(suffixed)) == sorted(ec.fed_panels(FED))
    code, doc = run(tmp_path, fake_get(fed=suffixed))
    assert code == 0 and fed_status(doc)["rows"] == 16
    assert "no panel yet for 2027" not in capsys.readouterr().out


def test_a_reworded_heading_fails_safe_and_is_never_read_into_another_year(tmp_path):
    # "2027 FOMC Calendar" is no heading: its meetings fall into 2026's panel, which then has sixteen and fails.
    reworded = FED.replace(">2027 FOMC Meetings<", ">2027 FOMC Calendar<")
    assert 2027 not in ec.fed_panels(reworded)
    with pytest.raises(ec.SourceError, match="16 scheduled meetings in 2026"):
        ec.parse_fed(reworded, [2026, 2027], required=[2026])
    code, doc = run(tmp_path, fake_get(fed=reworded))
    assert code == 1 and fed_status(doc)["ok"] is False
    assert not [e for e in doc["events"] if e["code"] == "fomc_decision"]


def test_a_next_year_panel_once_read_cannot_drop_out(tmp_path):
    assert run(tmp_path, fake_get())[0] == 0                          # 2026 and 2027 read: 16 rows kept as last good
    later = NOW + dt.timedelta(days=7)
    for page in (drop_panel(FED, 2027), FED.replace(">2027 FOMC Meetings<", ">2027 FOMC Calendar<")):
        code, doc = run(tmp_path, fake_get(fed=page), clock=later)
        assert code == 1
        fed = fed_status(doc)
        assert fed["ok"] is False and fed["rows"] == 16 and fed["fetched_at"] == NOW.isoformat()
        assert len([e for e in doc["events"] if e["code"] == "fomc_decision"]) == 16


def test_nine_scheduled_meetings_in_a_year_fail_and_keep_the_last_good_rows(tmp_path):
    assert run(tmp_path, fake_get())[0] == 0
    extra = '<div class="fomc-meeting__month"><strong>August</strong></div><div class="fomc-meeting__date">18-19</div>'
    i = FED.index(">2026 FOMC Meetings<") + len(">2026 FOMC Meetings<")
    nine = FED[:i] + extra + FED[i:]
    with pytest.raises(ec.SourceError, match="9 scheduled meetings in 2026"):
        ec.parse_fed(nine, [2026])
    code, doc = run(tmp_path, fake_get(fed=nine), clock=NOW + dt.timedelta(days=7))
    assert code == 1
    fed = fed_status(doc)
    assert fed["ok"] is False and fed["rows"] == 16 and fed["fetched_at"] == NOW.isoformat()


def _with_row(page: str, year: int, month: str, date: str) -> str:
    """The page with one more meeting row at the top of `year`'s panel."""
    row = f'<div class="fomc-meeting__month"><strong>{month}</strong></div><div class="fomc-meeting__date">{date}</div>'
    i = page.index(f">{year} FOMC Meetings<") + len(f">{year} FOMC Meetings<")
    return page[:i] + row + page[i:]


@pytest.mark.parametrize(("month", "date", "shape"), [
    ("August", "3*", "one-day"),
    ("November", "17-18 (cancelled)", "a day with a note in brackets"),
    ("October", "15 (conference call)", "a day with a note in brackets"),
])
def test_a_row_the_reader_does_not_know_fails_safe_and_says_what_it_is(tmp_path, capsys, month, date, shape):
    assert run(tmp_path, fake_get())[0] == 0                          # 16 rows kept as last good
    capsys.readouterr()
    code, doc = run(tmp_path, fake_get(fed=_with_row(FED, 2026, month, date)), clock=NOW + dt.timedelta(days=7))
    assert code == 1
    fed = fed_status(doc)
    assert fed["ok"] is False and fed["rows"] == 16 and fed["fetched_at"] == NOW.isoformat()
    assert len([e for e in doc["events"] if e["code"] == "fomc_decision"]) == 16
    line = next(x for x in capsys.readouterr().err.splitlines() if x.startswith("fed:"))
    assert line.startswith("fed: fed: 9 scheduled meetings in 2026, 8 expected; rows of a shape it does not expect: ")
    excerpt = f"{month.lower()} {date}"
    assert f'{shape} "{excerpt}"' in line and len(excerpt) <= 40


def test_a_problem_line_quotes_at_most_forty_plain_characters():
    long = "<b>Septembre</b> & " + "x" * 80
    with pytest.raises(ec.SourceError) as e:
        ec.parse_fed(_panel([(long, "16-17")] + [("July", f"{d}-{d + 1}") for d in range(1, 15, 2)]), [2030])
    quoted = re.search(r'"(.*)"', str(e.value))
    assert quoted and len(quoted.group(1)) <= 40 and re.fullmatch(r"[A-Za-z0-9 .,:;()/*'-]*", quoted.group(1))
    assert "a month cell with a word that is not a month" in str(e.value)


def test_rows_before_the_range_never_pile_up_in_the_last_good_state(tmp_path):
    # The state holds 2024 and 2025 rows (before the range's start, 2026) and the page has dropped its 2025 panel.
    old = [("fomc_decision", d) for d in REAL_DECISIONS[2025]]
    state = {"fed": {"fetched_at": NOW.isoformat(), "stale_since": None,
                     "rows": old + [("fomc_decision", "2024-12-18")] + sorted(ec.parse_fed(FED, [2026, 2027]))}}
    (tmp_path / "last_good.json").write_text(json.dumps(state))
    page = drop_panel(FED, 2025)
    sizes = []
    for k in range(3):
        code, doc = run(tmp_path, fake_get(fed=page), clock=NOW + dt.timedelta(days=7 * (k + 1)))
        assert code == 0 and fed_status(doc)["ok"] is True
        rows = json.loads((tmp_path / "last_good.json").read_text())["fed"]["rows"]
        assert all(d >= "2026-01-01" for _, d in rows)
        sizes.append(len(rows))
    assert sizes == [16, 16, 16]


def test_the_current_new_york_years_panel_is_required(tmp_path):
    # 00:30 on 1 January 2027 in New York: 2027 has begun, and its panel is gone.
    code, doc = run(tmp_path, fake_get(fed=drop_panel(FED, 2027)), clock=dt.datetime(2027, 1, 1, 5, 30, tzinfo=dt.UTC))
    assert code == 1 and fed_status(doc)["ok"] is False


def test_the_year_turns_in_new_york_not_in_utc(tmp_path, capsys):
    # 04:30 UTC on 1 January 2027 is 23:30 on 31 December 2026 in New York: 2027 has not begun there yet.
    code, doc = run(tmp_path, fake_get(fed=drop_panel(FED, 2027)), clock=dt.datetime(2027, 1, 1, 4, 30, tzinfo=dt.UTC))
    assert code == 0 and fed_status(doc)["ok"] is True
    assert "fed: no panel yet for 2027, 2028, 2029: not yet announced, not missing" in capsys.readouterr().out


def _years_page(years):
    """A Fed page with eight meetings in each of `years`, on the same days every year."""
    days = [("January", "27-28"), ("March", "17-18"), ("April", "28-29"), ("June", "16-17"), ("July", "28-29"),
            ("September", "15-16"), ("October", "27-28"), ("December", "8-9")]
    meetings = "".join(f'<div class="fomc-meeting__month"><strong>{m}</strong></div><div class="fomc-meeting__date">{d}</div>'
                       for m, d in days)
    return "".join(f"<h4><a>{y} FOMC Meetings</a></h4>{meetings}" for y in years)


def test_a_past_year_that_ages_off_the_page_never_fails_and_keeps_its_rows(tmp_path):
    page = _years_page(range(2028, 2034))
    state_rows = sorted(r for y in (2026, 2027) for r in ec.parse_fed(FED_REAL, [y])) + sorted(
        ec.parse_fed(page, [2028, 2029]))
    old = "2029-12-20T00:00:00+00:00"
    (tmp_path / "last_good.json").write_text(json.dumps({"fed": {"fetched_at": old, "rows": state_rows, "stale_since": None}}))
    code, doc = run(tmp_path, fake_get(fed=page), clock=dt.datetime(2033, 2, 1, 15, tzinfo=dt.UTC))
    fed = fed_status(doc)
    assert fed["ok"] is True and fed["stale_since"] is None and fed["rows"] == 32
    assert sorted(e["date"] for e in doc["events"] if e["code"] == "fomc_decision") == sorted(d for _, d in state_rows)


def test_a_source_whose_future_dates_halve_is_refused(tmp_path):
    run(tmp_path, fake_get())
    fred = json.loads(json.dumps(FRED))
    for rel in fred.values():
        rel["dates"]["release_dates"] = rel["dates"]["release_dates"][:1]
    code, doc = run(tmp_path, fake_get(fred=fred), clock=NOW + dt.timedelta(days=1))
    assert code == 1
    assert next(s for s in doc["sources"] if s["id"] == "fred")["ok"] is False
    assert len([e for e in doc["events"] if e["code"] == "cpi"]) == 4


def test_a_source_down_on_the_first_run_shows_nothing_rather_than_guessing(tmp_path):
    code, doc = run(tmp_path, fake_get(down=("bea.gov",)))
    assert code == 1
    bea = next(s for s in doc["sources"] if s["id"] == "bea")
    assert bea == {"id": "bea", "configured": True, "ok": False, "fetched_at": None, "stale_since": None, "rows": 0}
    assert ec.validate(doc) == []


# ---- sending -----------------------------------------------------------------------------------------------------

def test_it_sends_through_the_signed_ingest(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(ec.publish, "send", lambda body, url, secret, bypass, **kw: (sent.append(json.loads(body)), (True, "HTTP 200"))[1])
    env = {**ENV, "DASHBOARD_INGEST_URL": "https://lab.example/api/ingest", "DASHBOARD_INGEST_SECRET": "s"}
    assert ec.run(False, get=fake_get(), env=env, out=tmp_path, clock=NOW) == 0
    assert sent and sent[0]["schema"] == "stocksdelta/calendar"


def test_a_shadow_host_without_its_own_key_does_not_send(tmp_path, monkeypatch):
    monkeypatch.setattr(ec.publish, "send", lambda *a, **kw: pytest.fail("sent"))
    env = {**ENV, "WT_ROLE": "shadow", "DASHBOARD_INGEST_URL": "u", "DASHBOARD_INGEST_SECRET": "s"}
    assert ec.run(False, get=fake_get(), env=env, out=tmp_path, clock=NOW) == 2


def test_it_runs_while_the_job_runner_holds_its_lock(tmp_path, monkeypatch):
    from wt.ops import locks
    monkeypatch.setattr(locks, "LOCK_DIR", tmp_path)
    ran = []
    monkeypatch.setattr(ec, "run", lambda dry_run: ran.append(dry_run) or 0)
    with locks.job_lock("econ-calendar") as got:      # what wt.ops.jobs holds around the child process
        assert got
        assert ec.main(["--dry-run"]) == 0
    assert ran == [True]


def test_the_trading_calendar_is_never_written(tmp_path):
    path = ROOT / "config" / "events" / "macro_events.csv"
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    run(tmp_path, fake_get())
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    assert "macro_events" not in (ROOT / "src/wt/ops/econ_calendar.py").read_text().split('"""')[2]


def test_the_range_is_the_market_calendars():
    assert ec.market_range() == ("2026-01-01", "2029-12-31")
