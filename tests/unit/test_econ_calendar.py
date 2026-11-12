"""The economic calendar job (wt.ops.econ_calendar), on recorded sources: no network.

tests/fixtures/econ_calendar/ holds the Fed's FOMC calendar page, the BLS .ics schedule and the BEA schedule page,
trimmed from what they served on 2026-11-05, and a FRED fixture in the shape FRED documents (recording a real one
needs the owner's key).
"""
import datetime as dt
import hashlib
import json
from pathlib import Path

import pytest

from wt.ops import econ_calendar as ec

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures" / "econ_calendar"
FED = (FIX / "fomc_calendars.html").read_text()
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


def test_fed_skips_unscheduled_and_reads_a_meeting_across_two_months():
    rows = [("January", "28-29"), ("March", "18-19"), ("April/May", "30-1"), ("June", "17-18"), ("July", "29-30"),
            ("August (unscheduled)", "12"), ("September", "16-17"), ("October", "28-29"), ("December", "9-10"),
            ("December", "20 (notation vote)")]
    got = sorted(d for _, d in ec.parse_fed(_panel(rows), [2030]))
    assert "2030-05-01" in got and "2030-08-12" not in got and "2030-12-20" not in got and len(got) == 8


def test_fed_reads_a_later_year_only_when_published_and_needs_the_years_begun():
    page = _panel([("January", "28-29"), ("March", "18-19"), ("April/May", "30-1"), ("June", "17-18"),
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


def test_with_no_previous_read_a_next_year_panel_not_there_passes_and_says_so(tmp_path):
    code, doc = run(tmp_path, fake_get(fed=drop_panel(FED, 2027)))
    assert code == 0
    fed = fed_status(doc)
    assert fed["ok"] is True and fed["rows"] == 8
    assert fed["note"] == "no panel yet for 2027, 2028, 2029: those months are not yet announced, not missing"
    assert [n["month"] for n in doc["not_announced"] if n["code"] == "fomc_decision"][:2] == ["2027-01", "2027-02"]
    assert ec.validate(doc) == []


def test_a_renamed_next_year_panel_is_not_read_into_this_year(tmp_path):
    renamed = FED.replace(">2027 FOMC Meetings<", ">2027 FOMC Meetings (tentative)<")
    code, doc = run(tmp_path, fake_get(fed=renamed))
    assert code == 0
    assert sorted(e["date"] for e in doc["events"] if e["code"] == "fomc_decision")[-1] == "2026-12-09"
    assert "2027" in fed_status(doc)["note"]


def test_a_next_year_panel_once_read_cannot_drop_out(tmp_path):
    assert run(tmp_path, fake_get())[0] == 0                          # 2026 and 2027 read: 16 rows kept as last good
    later = NOW + dt.timedelta(days=7)
    for page in (drop_panel(FED, 2027), FED.replace(">2027 FOMC Meetings<", ">2027 FOMC Calendar<")):
        code, doc = run(tmp_path, fake_get(fed=page), clock=later)
        assert code == 1
        fed = fed_status(doc)
        assert fed["ok"] is False and fed["rows"] == 16 and fed["fetched_at"] == NOW.isoformat() and "note" not in fed
        assert len([e for e in doc["events"] if e["code"] == "fomc_decision"]) == 16


def test_the_current_new_york_years_panel_is_required(tmp_path):
    # 00:30 on 1 January 2027 in New York: 2027 has begun, and its panel is gone.
    code, doc = run(tmp_path, fake_get(fed=drop_panel(FED, 2027)), clock=dt.datetime(2027, 1, 1, 5, 30, tzinfo=dt.UTC))
    assert code == 1 and fed_status(doc)["ok"] is False


def test_the_year_turns_in_new_york_not_in_utc(tmp_path):
    # 04:30 UTC on 1 January 2027 is 23:30 on 31 December 2026 in New York: 2027 has not begun there yet.
    code, doc = run(tmp_path, fake_get(fed=drop_panel(FED, 2027)), clock=dt.datetime(2027, 1, 1, 4, 30, tzinfo=dt.UTC))
    assert code == 0 and fed_status(doc)["ok"] is True and "2027" in fed_status(doc)["note"]


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
