"""wt.data.edgar_events: paging, the form filter, acceptance time in ET across DST, resume, and SEC pacing.

Fixtures only; no network."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from wt.data import edgar_events as ee


def block(*filings: tuple[str, str, str, str, str]) -> dict[str, list[str]]:
    """Columnar filings block from (accession, form, filingDate, acceptanceDateTime, items)."""
    cols: dict[str, list[str]] = {"accessionNumber": [], "form": [], "filingDate": [], "acceptanceDateTime": [],
                                  "items": []}
    for acc, form, fdate, acc_at, items in filings:
        for k, v in zip(cols, (acc, form, fdate, acc_at, items), strict=True):
            cols[k].append(v)
    return cols


def submissions(name: str, recent: dict[str, list[str]], files: list[dict[str, Any]] | None = None,
                tickers: list[str] | None = None, former: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {"name": name, "tickers": tickers or [], "formerNames": former or [],
            "filings": {"recent": recent, "files": files or []}}


class FakeGet:
    """name -> (status, json); records every request and can fail after a given number of calls."""

    def __init__(self, pages: dict[str, tuple[int, Any]], throttle_after: int | None = None) -> None:
        self.pages, self.calls, self.throttle_after = pages, [], throttle_after

    def __call__(self, name: str) -> tuple[int, Any]:
        if self.throttle_after is not None and len(self.calls) >= self.throttle_after:
            raise ee.Throttled(name)
        self.calls.append(name)
        return self.pages.get(name, (404, None))


# A large filer: a recent block, one older page straddling SINCE (2018-06-01) and one wholly before it.
BIG = 19617
BIG_PAGES = {
    f"CIK{BIG:010d}.json": (200, submissions(
        "BIG BANK CORP",
        block(("0000019617-26-000001", "8-K", "2026-11-02", "2026-11-02T21:30:23.000Z", "2.02,9.01"),
              ("0000019617-26-000002", "424B2", "2026-07-30", "2026-07-30T20:30:28.000Z", ""),
              ("0000019617-26-000003", "4", "2026-07-30", "2026-07-30T20:31:00.000Z", ""),
              ("0000019617-25-000009", "SC TO-T", "2025-01-02", "2025-01-02T12:00:00.000Z", "")),
        files=[{"name": f"CIK{BIG:010d}-submissions-001.json", "filingFrom": "2018-03-01", "filingTo": "2025-01-02"},
               {"name": f"CIK{BIG:010d}-submissions-002.json", "filingFrom": "2010-01-01", "filingTo": "2018-02-28"}],
        tickers=["BIG", "BIG-PA"])),
    f"CIK{BIG:010d}-submissions-001.json": (200, block(
        ("0000019617-25-000009", "SC TO-T", "2025-01-02", "2025-01-02T12:00:00.000Z", ""),   # repeats across pages
        ("0000019617-19-000004", "425", "2019-03-10", "2019-03-10T14:05:00.000Z", ""),
        ("0000019617-18-000005", "8-K", "2018-06-01", "2018-06-01T04:00:00.000Z", "7.01"),
        ("0000019617-18-000006", "8-K", "2018-05-31", "2018-05-31T20:00:00.000Z", "2.02"))),   # before SINCE
}
SMALL = 1695357
SMALL_PAGES = {
    f"CIK{SMALL:010d}.json": (200, submissions(
        "SMALL BIO INC",
        block(("0001193125-23-000001", "SC 14D9", "2023-03-24", "2023-03-24T10:15:00.000Z", ""),
              ("0001193125-23-000002", "SC TO-C", "2023-03-13", "2023-03-13T11:00:00.000Z", ""),
              ("0001193125-23-000003", "SC14D9C", "2023-03-13", "2023-03-13T11:01:00.000Z", ""),
              ("0001193125-23-000004", "DEFA14A", "2023-03-13", "2023-03-13T11:02:00.000Z", ""),
              ("0001193125-23-000005", "8-K/A", "2023-03-13", "2023-03-13T11:03:00.000Z", "1.01"),
              ("0001193125-21-000006", "424B5", "2021-02-01", "2021-02-01T21:10:00.000Z", "should drop"),
              ("0001193125-20-000007", "PREM14A", "2020-05-01", "2020-05-01T10:00:00.000Z", ""),
              ("0001193125-20-000008", "DEFM14A", "2020-06-01", "2020-06-01T10:00:00.000Z", ""),
              ("0001193125-20-000009", "SC 13E3", "2020-06-01", "2020-06-01T10:00:00.000Z", ""),
              ("0001193125-20-000010", "424B4", "2020-06-02", "2020-06-02T10:00:00.000Z", ""),
              ("0001193125-20-000011", "10-Q", "2020-06-02", "2020-06-02T10:00:00.000Z", "")),
        tickers=["SMLB"], former=[{"name": "OLD NAME INC", "from": "2016-01-01T00:00:00.000Z",
                                   "to": "2019-01-01T00:00:00.000Z"}])),
}
GONE = 999999          # mapped, but EDGAR answers 404
PAGES = {**BIG_PAGES, **SMALL_PAGES}
MAP = pd.DataFrame({"ticker": ["BIG", "BIG-PA", "SMLB", "GONE"], "cik": [BIG, BIG, SMALL, GONE]})


def test_paged_cik_reads_pages_that_reach_since_and_drops_repeats() -> None:
    get = FakeGet(PAGES)
    res = ee.cik_events(BIG, get)
    assert res.status == "ok"
    assert get.calls == [f"CIK{BIG:010d}.json", f"CIK{BIG:010d}-submissions-001.json"]   # page 002 ends before SINCE
    assert res.rows is not None
    assert sorted(res.rows.accession) == ["0000019617-18-000005", "0000019617-19-000004", "0000019617-25-000009",
                                          "0000019617-26-000001", "0000019617-26-000002"]
    assert res.rows.accession.is_unique
    assert res.counts is not None
    counts = {(int(y), f): int(n) for _, y, f, n in res.counts.itertuples(index=False)}
    assert counts == {(2018, "8-K"): 1, (2019, "425"): 1, (2025, "SC TO-T"): 1, (2026, "424B2"): 1,
                      (2026, "4"): 1, (2026, "8-K"): 1}      # every form counts; 2018-05-31 is before SINCE


def test_form_filter_keeps_only_the_listed_forms_and_8k_items() -> None:
    res = ee.cik_events(SMALL, FakeGet(PAGES))
    assert res.rows is not None
    got = dict(zip(res.rows.form, res.rows["items"], strict=True))
    assert got == {"SC 14D9": "", "8-K/A": "1.01", "424B5": "", "PREM14A": "", "DEFM14A": "", "SC 13E3": "",
                   "424B4": ""}
    # near misses are not events, but they are counted
    assert res.counts is not None
    assert {"SC TO-C", "SC14D9C", "DEFA14A", "10-Q"} <= set(res.counts.form)
    assert not ({"SC TO-C", "SC14D9C", "DEFA14A", "10-Q", "4"} & ee.FORMS)
    assert {"SC TO-T", "SC TO-T/A", "SC 14D9", "PREM14A", "DEFM14A", "SC 13E3", "425", "424B1", "424B2", "424B3",
            "424B4", "424B5", "8-K", "8-K/A"} == ee.FORMS


def test_acceptance_time_is_utc_converted_to_et_across_dst() -> None:
    # R1: the same 16:30 ET release reads 20:30Z under EDT and 21:30Z under EST (Apple, 2026-07-30 and 2026-11-02).
    et = ee.accepted_et(["2026-07-30T20:30:28.000Z", "2026-11-02T21:30:23.000Z", "2026-11-01T05:30:00.000Z",
                         "2026-11-01T06:30:00.000Z"])
    assert [t.strftime("%Y-%m-%d %H:%M:%S %z") for t in et] == [
        "2026-07-30 16:30:28 -0400", "2026-11-02 16:30:23 -0500",
        "2026-11-01 01:30:00 -0400", "2026-11-01 01:30:00 -0500"]          # the repeated hour at the fall-back


def test_et_survives_the_chunk_files_and_assemble(tmp_path: Path) -> None:
    ev = ee.build(get=FakeGet(PAGES), ticker_map=MAP, parts=tmp_path / "parts", out=tmp_path / "events.parquet",
                  chunk=1, log=lambda _: None)
    assert ev is not None
    back = pd.read_parquet(tmp_path / "events.parquet")
    assert str(back.accepted_at_et.dt.tz) == ee.ET
    assert list(back.columns) == ee.COLUMNS
    row = back.set_index("accession").loc["0000019617-26-000001"]
    assert row.accepted_at_et.strftime("%H:%M:%S") == "16:30:23"
    assert row.ticker == "BIG,BIG-PA" and row.entity == "BIG BANK CORP" and row["items"] == "2.02,9.01"
    assert str(row.filing_date) == "2026-11-02"
    assert back.groupby("cik").size().to_dict() == {BIG: 5, SMALL: 7}
    meta = pd.read_parquet(tmp_path / "cik_meta.parquet").set_index("cik")
    assert meta.status.to_dict() == {BIG: "ok", SMALL: "ok", GONE: "missing"}
    assert json.loads(meta.loc[SMALL, "former_names"]) == [{"name": "OLD NAME INC", "from": "2016-01-01",
                                                            "to": "2019-01-01"}]
    assert meta.loc[BIG, "sec_tickers"] == "BIG,BIG-PA"
    years = pd.read_parquet(tmp_path / "cik_form_years.parquet")
    assert set(years.cik) == {BIG, SMALL}


def test_killed_build_resumes_without_refetching(tmp_path: Path) -> None:
    parts, out = tmp_path / "parts", tmp_path / "events.parquet"
    whole = ee.build(get=FakeGet(PAGES), ticker_map=MAP, parts=tmp_path / "whole", out=tmp_path / "whole.parquet",
                     chunk=1, log=lambda _: None)
    # CIKs run sorted: BIG (2 requests), SMALL (1), GONE (1). SEC refuses the 3rd request, mid-SMALL.
    first = FakeGet(PAGES, throttle_after=2)
    with pytest.raises(ee.Throttled):
        ee.build(get=first, ticker_map=MAP, parts=parts, out=out, chunk=1, log=lambda _: None)
    assert ee.done_ciks(parts) == {BIG}
    assert not out.exists()
    second = FakeGet(PAGES)
    ev = ee.build(get=second, ticker_map=MAP, parts=parts, out=out, chunk=1, log=lambda _: None)
    assert f"CIK{BIG:010d}.json" not in second.calls
    assert ev is not None and whole is not None
    pd.testing.assert_frame_equal(ev, whole)
    assert ee.done_ciks(parts) == {BIG, SMALL, GONE}


def test_failed_older_page_is_retried_not_stuck(tmp_path: Path) -> None:
    parts, out = tmp_path / "parts", tmp_path / "events.parquet"
    broken = {k: v for k, v in PAGES.items() if not k.endswith("-001.json")}   # BIG's older page answers 404
    ev = ee.build(get=FakeGet(broken), ticker_map=MAP, parts=parts, out=out, chunk=1, log=lambda _: None)
    assert ev is not None and BIG not in set(ev.cik)
    assert ee.done_ciks(parts) == {SMALL, GONE}
    retry = FakeGet(PAGES)
    ev = ee.build(get=retry, ticker_map=MAP, parts=parts, out=out, chunk=1, log=lambda _: None)
    assert retry.calls == [f"CIK{BIG:010d}.json", f"CIK{BIG:010d}-submissions-001.json"]
    assert ev is not None and int((ev.cik == BIG).sum()) == 5
    assert pd.read_parquet(tmp_path / "cik_meta.parquet").set_index("cik").status[BIG] == "ok"


def test_every_cik_missing_gives_an_empty_typed_table(tmp_path: Path) -> None:
    ev = ee.build(get=FakeGet({}), ticker_map=MAP, parts=tmp_path / "p", out=tmp_path / "e.parquet", chunk=2,
                  log=lambda _: None)
    assert ev is not None and ev.empty and list(ev.columns) == ee.COLUMNS
    assert pd.read_parquet(tmp_path / "e.parquet").empty


def test_limit_fetches_a_trial_batch_without_assembling(tmp_path: Path) -> None:
    get = FakeGet(PAGES)
    assert ee.build(get=get, ticker_map=MAP, parts=tmp_path / "p", out=tmp_path / "e.parquet", limit=1,
                    log=lambda _: None) is None
    assert ee.done_ciks(tmp_path / "p") == {BIG} and not (tmp_path / "e.parquet").exists()


class Resp:
    def __init__(self, status: int, body: Any = None) -> None:
        self.status_code, self.body = status, body

    def json(self) -> Any:
        return self.body


class Session:
    def __init__(self, answers: list[Resp]) -> None:
        self.answers, self.headers, self.urls = answers, {}, []   # type: ignore[var-annotated]

    def get(self, url: str, timeout: int) -> Resp:
        self.urls.append(url)
        return self.answers.pop(0)


class Clock:
    def __init__(self) -> None:
        self.t, self.sleeps = 0.0, []   # type: ignore[var-annotated]

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += s

    def now(self) -> float:
        return self.t


def test_fetcher_paces_backs_off_and_names_no_person() -> None:
    clock = Clock()
    s = Session([Resp(200, {"a": 1}), Resp(429), Resp(403), Resp(200, {"b": 2}), Resp(404)])
    f = ee.Fetcher(session=s, sleep=clock.sleep, clock=clock.now)   # type: ignore[arg-type]
    assert f("CIK0000000001.json") == (200, {"a": 1})
    assert f("CIK0000000002.json") == (200, {"b": 2})
    assert f("CIK0000000003.json") == (404, None)
    assert s.urls[0] == "https://data.sec.gov/submissions/CIK0000000001.json"
    assert clock.sleeps[:2] == [pytest.approx(ee.MIN_INTERVAL), ee.BACKOFF[0]]     # pace, then back off on the 429
    assert ee.BACKOFF[1] in clock.sleeps                                          # and again on the 403
    ua = s.headers["User-Agent"]
    assert "@" not in ua and ua == ee.UA["User-Agent"]


def test_fetcher_gives_up_with_throttled() -> None:
    clock = Clock()
    s = Session([Resp(429) for _ in range(len(ee.BACKOFF) + 1)])
    f = ee.Fetcher(session=s, sleep=clock.sleep, clock=clock.now)   # type: ignore[arg-type]
    with pytest.raises(ee.Throttled):
        f("CIK0000000001.json")
    assert len(s.urls) == len(ee.BACKOFF) + 1
