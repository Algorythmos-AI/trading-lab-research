"""The economic calendar the dashboard's Calendar page shows: release dates read once a week from the agencies.

    python -m wt.ops.econ_calendar             read the sources, build, validate, sign and send
    python -m wt.ops.econ_calendar --dry-run   read, build and validate only (writes var/econ_calendar/outbox)

Sources, all public and official:
  * FRED (St. Louis Fed) release calendar, the primary for CPI, PPI, the jobs report, JOLTS, retail sales, GDP and
    PCE. Needs FRED_API_KEY; without it FRED is "not set up" and BLS and BEA stand in where they can.
  * The Federal Reserve's FOMC calendar page: the decision day (the second day) of each scheduled meeting.
  * The BLS release schedule (its .ics file) and the BEA release schedule page: cross-checks. A month where one
    disagrees with the primary is published with both sets of dates; neither is picked.

Display only. Nothing here writes config/events/macro_events.csv, which the paper runners trade around: a change to
that file is a strategy change and is made by hand, under its own record.

Robustness: each source's rows are kept in var/econ_calendar/last_good.json. A source that cannot be read, or whose
future dates suddenly halve, keeps its last good rows (marked stale since that run) and the job exits 1 so the unit
alerts; a broken page can never empty the calendar. What leaves the host is dates, codes and source ids.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from wt.core.config import ROOT, STATE_DIR
from wt.ops import publish, safeio

SCHEMA_ID = "stocksdelta/calendar"
SCHEMA_VERSION = 1
SCHEMA_PATH = ROOT / "dashboard" / "src" / "lib" / "calendar.schema.json"
MARKET_CALENDAR = ROOT / "dashboard" / "src" / "lib" / "market-calendar.json"
OUT = STATE_DIR / "econ_calendar"
NEW_YORK = "America/New_York"

FRED_URL = "https://api.stlouisfed.org/fred"
FED_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
BLS_URL = "https://www.bls.gov/schedule/news_release/bls.ics"
BEA_URL = "https://www.bea.gov/news/schedule"
TIMEOUT_S = 30
SEND_TRIES = 3

# FRED release id, and the words its name must contain: checked against FRED itself on every run, so an id that
# ever pointed elsewhere fails the source instead of labelling one release as another.
FRED_RELEASES: dict[str, tuple[int, str]] = {
    "cpi": (10, "consumer price index"),
    "ppi": (46, "producer price index"),
    "nfp": (50, "employment situation"),
    "jolts": (192, "job openings"),
    "retail_sales": (9, "retail"),
    "gdp": (53, "gross domestic product"),
    "pce": (54, "personal income and outlays"),
}
# The New York release time of each, from the agencies' schedules.
TIME_ET = {"cpi": "08:30", "ppi": "08:30", "nfp": "08:30", "jolts": "10:00", "retail_sales": "08:30",
           "gdp": "08:30", "pce": "08:30", "fomc_decision": "14:00"}
# The BLS schedule's release names, exactly as its calendar writes them.
BLS_SUMMARIES = {"Consumer Price Index": "cpi", "Producer Price Index": "ppi", "Employment Situation": "nfp",
                 "Job Openings and Labor Turnover Survey": "jolts"}
# Which source stands in for FRED for a code when FRED is not set up or has no rows for it.
FALLBACK = {"cpi": "bls", "ppi": "bls", "nfp": "bls", "jolts": "bls", "gdp": "bea", "pce": "bea"}
SOURCES = ("fred", "fed", "bls", "bea")
# A source whose future dates fall below this share of last time's (those still ahead) is refused as broken.
SHRINK_FLOOR = 0.5

Rows = set[tuple[str, str]]          # (code, YYYY-MM-DD)
Get = Callable[[str, dict[str, str]], str]


class SourceError(Exception):
    """A source could not be read or did not look like itself."""


# ---- parsers (pure) ----------------------------------------------------------------------------------------------

_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
     "december"], 1)}


def parse_fed(page: str, years: Iterable[int]) -> Rows:
    """FOMC decision days from the Fed's calendar page, for `years`. A scheduled meeting's decision is on its last
    day; an unscheduled meeting or a notation vote is skipped. Fails when a year has fewer than eight meetings."""
    out: Rows = set()
    for year in years:
        m = re.search(rf">\s*{year} FOMC Meetings\s*<", page)
        if not m:
            raise SourceError(f"fed: no {year} panel")
        end = re.search(r">\s*\d{4} FOMC Meetings\s*<", page[m.end():])
        panel = page[m.end(): m.end() + end.start()] if end else page[m.end():]
        n = 0
        for month_html, date_html in re.findall(
                r'fomc-meeting__month[^>]*>(.*?)</div>\s*<div[^>]*fomc-meeting__date[^>]*>(.*?)</div>', panel, re.S):
            month_txt = html.unescape(re.sub(r"<[^>]+>", " ", month_html)).strip().lower()
            date_txt = html.unescape(re.sub(r"<[^>]+>", " ", date_html)).strip().lower()
            if "unscheduled" in month_txt + date_txt or "notation" in month_txt + date_txt:
                continue
            months = [_MONTHS[w] for w in re.findall(r"[a-z]+", month_txt) if w in _MONTHS]
            days = [int(d) for d in re.findall(r"\d{1,2}", date_txt)]
            if not months or not days:
                raise SourceError(f"fed: unreadable meeting {month_txt!r} {date_txt!r}")
            # "April/May" with "30-1": the decision falls in the last month named.
            out.add(("fomc_decision", dt.date(year, months[-1], days[-1]).isoformat()))
            n += 1
        if n < 8:
            raise SourceError(f"fed: {n} scheduled meetings in {year}")
    return out


def parse_bls(ics: str) -> Rows:
    """The four BLS releases from its .ics schedule."""
    if "BEGIN:VCALENDAR" not in ics:
        raise SourceError("bls: not a calendar")
    out: Rows = set()
    for block in ics.split("BEGIN:VEVENT")[1:]:
        start = re.search(r"^DTSTART[^:\r\n]*:(\d{8})", block, re.M)
        summary = re.search(r"^SUMMARY:(.*?)\r?$", block, re.M)
        if not start or not summary:
            continue
        code = BLS_SUMMARIES.get(summary.group(1).strip())
        if code:
            d = start.group(1)
            out.add((code, f"{d[:4]}-{d[4:6]}-{d[6:]}"))
    if not out:
        raise SourceError("bls: none of the releases found")
    return out


def parse_bea(page: str) -> Rows:
    """GDP's estimates and Personal Income and Outlays (PCE) from BEA's release schedule page."""
    out: Rows = set()
    tables = re.findall(r"<table.*?</table>", page, re.S)
    for table in tables:
        year = re.search(r"Year (\d{4})", table)
        if not year:
            continue
        for day, title in re.findall(r'release-date">\s*([A-Za-z]+ \d{1,2})\s*</div>.*?release-title[^>]*>(.*?)</td>', table, re.S):
            t = html.unescape(re.sub(r"<[^>]+>", " ", title)).strip()
            code = "gdp" if re.match(r"GDP \((Advance|Second|Third)", t) else "pce" if t.startswith("Personal Income and Outlays,") else None
            if code:
                name, num = day.split()
                if name.lower() not in _MONTHS:
                    raise SourceError(f"bea: unreadable date {day!r}")
                out.add((code, dt.date(int(year.group(1)), _MONTHS[name.lower()], int(num)).isoformat()))
    if not tables:
        raise SourceError("bea: no schedule table")
    return out


def parse_fred_name(body: str, code: str) -> None:
    rid, words = FRED_RELEASES[code]
    try:
        rel = json.loads(body)["releases"][0]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise SourceError(f"fred: release {rid} unreadable") from e
    if rel.get("id") != rid or words not in str(rel.get("name", "")).lower():
        raise SourceError(f"fred: release {rid} is not {code}")


def parse_fred_dates(body: str, code: str) -> Rows:
    try:
        rows = json.loads(body)["release_dates"]
        return {(code, str(r["date"])) for r in rows if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(r["date"]))}
    except (ValueError, KeyError, TypeError) as e:
        raise SourceError(f"fred: dates for {code} unreadable") from e


# ---- reading -----------------------------------------------------------------------------------------------------

def http_get(contact: str | None) -> Get:
    import requests

    agent = f"trading-lab-calendar/1.0 ({contact})" if contact else "trading-lab-calendar/1.0"

    def get(url: str, params: dict[str, str]) -> str:
        try:
            r = requests.get(url, params=params, headers={"user-agent": agent}, timeout=TIMEOUT_S)
        except requests.RequestException as e:
            raise SourceError(f"{e.__class__.__name__}") from e
        if r.status_code != 200:
            raise SourceError(f"HTTP {r.status_code}")
        return r.text
    return get


def read_fred(get: Get, key: str, start: str, end: str) -> Rows:
    out: Rows = set()
    for code, (rid, _) in FRED_RELEASES.items():
        base = {"api_key": key, "file_type": "json", "release_id": str(rid)}
        parse_fred_name(get(f"{FRED_URL}/release", base), code)
        body = get(f"{FRED_URL}/release/dates", {**base, "realtime_start": start, "realtime_end": "9999-12-31",
                                                  "include_release_dates_with_no_data": "true", "limit": "10000"})
        out |= {r for r in parse_fred_dates(body, code) if start <= r[1] <= end}
    return out


def market_range(path: Path = MARKET_CALENDAR) -> tuple[str, str]:
    """The range the Calendar page covers: the generated market calendar's own."""
    r = json.loads(path.read_text())["range"]
    return str(r["start"]), str(r["end"])


# ---- last good, and the shrink guard -----------------------------------------------------------------------------

def load_state(path: Path) -> dict[str, Any]:
    try:
        st = json.loads(path.read_text())
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def accept(src: str, fresh: Rows | None, why: str | None, state: dict[str, Any], today: str, now: str) -> tuple[Rows, dict[str, Any], str | None]:
    """The rows to use for a source this run, its status row, and the problem to report (None when all is well).
    `fresh` is None when the source could not be read (`why` says why)."""
    prev = state.get(src) or {}
    prev_rows: Rows = {(str(c), str(d)) for c, d in prev.get("rows", [])}
    if fresh is not None:
        ahead_before = sum(1 for _, d in prev_rows if d >= today)
        ahead_now = sum(1 for _, d in fresh if d >= today)
        if ahead_before >= 4 and ahead_now < ahead_before * SHRINK_FLOOR:
            fresh, why = None, f"{src}: future dates fell from {ahead_before} to {ahead_now}; kept the last good ones"
    if fresh is not None:
        state[src] = {"fetched_at": now, "rows": sorted(fresh), "stale_since": None}
        return fresh, {"id": src, "configured": True, "ok": True, "fetched_at": now, "stale_since": None, "rows": len(fresh)}, None
    stale = prev.get("stale_since") or now
    if prev_rows:
        state[src] = {**prev, "stale_since": stale}
    return prev_rows, {"id": src, "configured": True, "ok": False, "fetched_at": prev.get("fetched_at"),
                       "stale_since": stale if prev_rows else None, "rows": len(prev_rows)}, why


# ---- the document (pure) -----------------------------------------------------------------------------------------

def _months(start: str, end: str) -> list[str]:
    y, m = int(start[:4]), int(start[5:7])
    out = []
    while f"{y:04d}-{m:02d}" <= end[:7]:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def build(rows: dict[str, Rows], status: list[dict[str, Any]], start: str, end: str, run_id: str, now: str) -> dict[str, Any]:
    """The calendar document from each source's rows. Per code the primary is FRED (the Fed for FOMC), or, where
    FRED has nothing for it, the agency's own schedule; the other sources only check it."""
    codes = [*FRED_RELEASES, "fomc_decision"]
    events: list[dict[str, Any]] = []
    not_announced: list[dict[str, str]] = []
    disagreements: list[dict[str, Any]] = []
    for code in codes:
        by_src = {s: sorted(d for c, d in rows.get(s, set()) if c == code and start <= d <= end) for s in SOURCES}
        if code == "fomc_decision":
            primary = "fed"
        else:
            primary = "fred" if by_src["fred"] else FALLBACK.get(code, "fred")
        dates = by_src[primary]
        others = [s for s in SOURCES if s != primary and by_src[s]]
        for d in dates:
            events.append({"date": d, "code": code, "time_et": TIME_ET[code], "source": primary,
                           "checked_by": [s for s in others if d in by_src[s]]})
        if dates:
            last = dates[-1][:7]
            not_announced += [{"code": code, "month": m} for m in _months(start, end) if m > last]
        for s in others:
            lo = max(dates[0][:7], by_src[s][0][:7]) if dates else None
            hi = min(dates[-1][:7], by_src[s][-1][:7]) if dates else None
            if lo is None or hi is None:
                continue
            for m in _months(f"{lo}-01", f"{hi}-01"):
                mine = [d for d in dates if d.startswith(m)]
                theirs = [d for d in by_src[s] if d.startswith(m)]
                if mine != theirs:
                    disagreements.append({"code": code, "month": m, "source": primary, "dates": mine[:5],
                                          "other_source": s, "other_dates": theirs[:5]})
    events.sort(key=lambda e: (e["date"], e["time_et"], e["code"]))
    return {"schema": SCHEMA_ID, "schema_version": SCHEMA_VERSION, "run_id": run_id, "as_of": now,
            "range": {"start": start, "end": end}, "events": events, "not_announced": not_announced,
            "disagreements": disagreements[:100], "sources": status}


def validate(doc: dict[str, Any], schema_path: Path = SCHEMA_PATH) -> list[str]:
    """The site's own contract, read from the checkout: what fails here would be refused there."""
    import jsonschema
    v = jsonschema.Draft7Validator(json.loads(schema_path.read_text()))
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.validator}" for e in v.iter_errors(doc)][:20]


# ---- main --------------------------------------------------------------------------------------------------------

def collect(get: Get, env: dict[str, str], state: dict[str, Any], start: str, end: str, today: str,
            now: str) -> tuple[dict[str, Rows], list[dict[str, Any]], list[str]]:
    """Read every source, through the last-good guard. Returns rows by source, the status rows and the problems."""
    rows: dict[str, Rows] = {}
    status: list[dict[str, Any]] = []
    problems: list[str] = []
    years = range(int(start[:4]), int(end[:4]) + 1)
    readers: dict[str, Callable[[], Rows] | None] = {
        "fred": (lambda: read_fred(get, env["FRED_API_KEY"], start, end)) if env.get("FRED_API_KEY") else None,
        "fed": lambda: parse_fed(get(FED_URL, {}), years),
        # BLS answers only a caller that leaves a contact address (its published policy).
        "bls": (lambda: parse_bls(get(BLS_URL, {}))) if env.get("WT_CONTACT_EMAIL") else None,
        "bea": lambda: parse_bea(get(BEA_URL, {})),
    }
    for src in SOURCES:
        reader = readers[src]
        if reader is None:
            rows[src] = set()
            status.append({"id": src, "configured": False, "ok": False, "fetched_at": None, "stale_since": None, "rows": 0})
            continue
        fresh: Rows | None
        why: str | None = None
        try:
            fresh = {r for r in reader() if start <= r[1] <= end}
        except SourceError as e:
            fresh, why = None, f"{src}: {e}"
        except Exception as e:  # noqa: BLE001 — one source's fault must not stop the others
            fresh, why = None, f"{src}: {e.__class__.__name__}"
        rows[src], st, problem = accept(src, fresh, why, state, today, now)
        status.append(st)
        if problem:
            problems.append(problem)
    return rows, status, problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.econ_calendar")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    # No lock of its own: the job runner (wt.ops.jobs) holds the "econ-calendar" lock for the whole run, and taking
    # it again here found it held by that runner and skipped every scheduled run.
    return run(a.dry_run)


def run(dry_run: bool, get: Get | None = None, env: dict[str, str] | None = None, out: Path = OUT,
        clock: dt.datetime | None = None) -> int:
    from zoneinfo import ZoneInfo

    e = dict(os.environ) if env is None else env
    now_dt = (clock or dt.datetime.now(dt.UTC)).replace(microsecond=0)
    now = now_dt.isoformat()
    today = now_dt.astimezone(ZoneInfo(NEW_YORK)).date().isoformat()
    start, end = market_range()
    state_path = out / "last_good.json"
    state = load_state(state_path)
    rows, status, problems = collect(get or http_get(e.get("WT_CONTACT_EMAIL")), e, state, start, end, today, now)
    run_id = now_dt.strftime("%Y%m%dT%H%M%SZ") + "-" + hashlib.sha1(os.urandom(8)).hexdigest()[:6]
    doc = build(rows, status, start, end, run_id, now)
    if bad := validate(doc):
        print("calendar document failed schema validation:\n  " + "\n  ".join(bad), file=sys.stderr)
        return 2
    safeio.atomic_write(state_path, json.dumps(state, indent=1, sort_keys=True), out)
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    safeio.atomic_write(out / "outbox" / "document.json", body.decode(), out)
    for p in problems:
        print(p, file=sys.stderr)
    unset = [s["id"] for s in status if not s["configured"]]
    print(f"calendar {run_id}: {len(doc['events'])} events, {len(doc['not_announced'])} months not yet announced, "
          f"{len(doc['disagreements'])} disagreements{f', not set up: {unset}' if unset else ''}, {len(body)} bytes")
    if dry_run:
        return 1 if problems else 0
    if (why := publish.shadow_key_problem(e)) is not None:
        print(why, file=sys.stderr)
        return 2
    url, secret = e.get("DASHBOARD_INGEST_URL"), e.get("DASHBOARD_INGEST_SECRET")
    if not url or not secret:
        print("DASHBOARD_INGEST_URL / DASHBOARD_INGEST_SECRET not set: not sending")
        return 1 if problems else 0
    ok, detail = publish.send(body, url, secret, e.get("VERCEL_AUTOMATION_BYPASS_SECRET"), tries=SEND_TRIES,
                              deadline=time.monotonic() + 120)
    print(f"sent: {ok} ({detail if ok else publish.error_code(detail)})")
    return 0 if ok and not problems else 1


if __name__ == "__main__":
    sys.exit(main())
