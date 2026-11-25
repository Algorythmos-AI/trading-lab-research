"""The after-close pull (DEC-0060 section 2.4): prints and open interest into the session folder. Synthetic answers."""
from __future__ import annotations

import datetime as dt
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from wt.data.feeds import require_feed
from wt.lab import afterclose
from wt.lab.probe import Answer
from wt.lab.tape import PartWriter

START = dt.datetime(2026, 11, 19, 14, 30, tzinfo=dt.UTC)
END = dt.datetime(2026, 11, 19, 21, 0, tzinfo=dt.UTC)


class Api:
    def __init__(self, fail: bool = False, fail_first: int = 0) -> None:
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.fail, self.fail_first = fail, fail_first

    def __call__(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
        require_feed(url, params)                       # neither endpoint takes a feed: the guard lets them pass
        self.calls.append((url, dict(params)))
        if self.fail or len(self.calls) <= self.fail_first:
            return Answer(500, {}, None, 0.0)
        if url.endswith("/v1beta1/options/trades"):
            syms = params["symbols"].split(",")
            if "page_token" not in params:
                return Answer(200, {}, {"trades": {s: [{"t": "2026-11-19T15:00:00Z", "p": 1.05, "s": 2, "x": "C",
                                                        "c": ["I"]}] for s in syms}, "next_page_token": "n"}, 0.0)
            return Answer(200, {}, {"trades": {syms[0]: [{"t": "2026-11-19T15:01:00Z", "p": 1.1, "s": 1, "x": "Q",
                                                          "c": "a"}]}}, 0.0)
        if url.endswith("/v2/options/contracts"):
            root = params["underlying_symbols"]
            return Answer(200, {}, {"option_contracts": [
                {"symbol": f"{root}261119C00100000", "open_interest": "1520", "open_interest_date": "2026-11-18",
                 "close_price": "1.02"},
                {"symbol": f"{root}261119C00200000", "open_interest": "9"}]}, 0.0)
        return Answer(404, {}, None, 0.0)


def rows(folder: Path, stream: str) -> list[dict[str, Any]]:
    return [r for p in sorted(folder.glob(f"{stream}-*.parquet")) for r in pq.read_table(p).to_pylist()]


def test_prints_are_paged_batched_and_written_raw(tmp_path: Path) -> None:
    api = Api()
    syms = [f"AAA261119C{k:08d}" for k in range(150)]
    pw, gw = PartWriter(tmp_path, "print"), PartWriter(tmp_path, "gap")
    c = afterclose.prints(api, {}, syms, START, END, pw, gw, time.monotonic() + 60)
    pw.flush()
    assert c == {"prints": 152, "requests": 4, "failed": 0, "not_reached": 0, "batches": 2}   # 2 batches x 2 pages
    first = api.calls[0][1]
    assert first["start"] == "2026-11-19T14:30:00Z" and first["end"] == "2026-11-19T21:00:00Z" and "feed" not in first
    r = rows(tmp_path, "print")
    assert {x["conditions"] for x in r} == {"I", "a"} and r[0]["price"] == 1.05 and r[0]["size"] == 2


def test_open_interest_keeps_only_recorded_contracts_and_reads_string_numbers(tmp_path: Path) -> None:
    ow, gw = PartWriter(tmp_path, "open_interest"), PartWriter(tmp_path, "gap")
    keep = {"AAA261119C00100000", "BBB261119C00100000"}
    c = afterclose.open_interest(Api(), {}, ["AAA", "BBB"], dt.date(2026, 11, 19), dt.date(2026, 11, 27), keep, ow, gw,
                                 time.monotonic() + 60, session=dt.date(2026, 11, 19))
    ow.flush()
    assert c == {"contracts": 2, "requests": 2, "failed": 0, "null_open_interest": 0, "missing": 0,
                 "dates": {"2026-11-18": 2}, "dated_session_or_later": 0}
    assert {(x["symbol"], x["open_interest"], x["close_price"]) for x in rows(tmp_path, "open_interest")} == {
        ("AAA261119C00100000", 1520, 1.02), ("BBB261119C00100000", 1520, 1.02)}


def test_failures_and_the_deadline_are_gaps_not_errors(tmp_path: Path) -> None:
    pw, ow, gw = PartWriter(tmp_path, "print"), PartWriter(tmp_path, "open_interest"), PartWriter(tmp_path, "gap")
    nap = lambda s: None                                                                  # noqa: E731
    sym = "AAA261119C00100000"
    failing = Api(fail=True)
    assert afterclose.prints(failing, {}, [sym], START, END, pw, gw, time.monotonic() + 60, pause=nap)["failed"] == 1
    assert len(failing.calls) == afterclose.TRIES                       # asked again before the batch is given up
    two = [f"AAA261119C{k:08d}" for k in range(150)]
    assert afterclose.prints(Api(), {}, two, START, END, pw, gw, time.monotonic() - 1, pause=nap)["not_reached"] == 2
    assert afterclose.open_interest(Api(fail=True), {}, ["AAA"], dt.date(2026, 11, 19), dt.date(2026, 11, 19), set(),
                                    ow, gw, time.monotonic() + 60, pause=nap)["failed"] == 1
    gw.flush()
    assert [g["reason"] for g in rows(tmp_path, "gap")] == [
        f"status 500: batch 0 {sym}..{sym} page 0 onward not pulled",
        f"deadline: 2 batches not pulled from batch 0 {two[0]}..{two[99]} page 0", "status 500 AAA page 0"]


def test_a_failed_page_is_asked_again_and_nothing_is_lost(tmp_path: Path) -> None:
    pw, gw = PartWriter(tmp_path, "print"), PartWriter(tmp_path, "gap")
    c = afterclose.prints(Api(fail_first=2), {}, ["AAA261119C00100000"], START, END, pw, gw, time.monotonic() + 60,
                          pause=lambda s: None)
    assert c["failed"] == 0 and c["prints"] == 2 and gw.rows == []


def test_recorded_contracts_missing_from_the_listing_are_counted(tmp_path: Path) -> None:
    ow, gw = PartWriter(tmp_path, "open_interest"), PartWriter(tmp_path, "gap")
    keep = {"AAA261119C00100000", "AAA261119C00300000", "AAA261119C00400000"}
    c = afterclose.open_interest(Api(), {}, ["AAA"], dt.date(2026, 11, 19), dt.date(2026, 11, 27), keep, ow, gw,
                                 time.monotonic() + 60, session=dt.date(2026, 11, 19))
    assert c["contracts"] == 1 and c["missing"] == 2 and c["dated_session_or_later"] == 0
    assert gw.rows[-1]["reason"] == "2 recorded contracts not in the listing"


def test_a_listed_contract_without_open_interest_is_counted_as_null(tmp_path: Path) -> None:
    def api(url: str, params: Any, headers: Any, timeout: float) -> Answer:
        return Answer(200, {}, {"option_contracts": [{"symbol": "AAA261127C00100000", "open_interest": None}]}, 0.0)
    ow, gw = PartWriter(tmp_path, "open_interest"), PartWriter(tmp_path, "gap")
    c = afterclose.open_interest(api, {}, ["AAA"], dt.date(2026, 11, 19), dt.date(2026, 11, 27),
                                 {"AAA261127C00100000"}, ow, gw, time.monotonic() + 60)
    assert c["contracts"] == 1 and c["null_open_interest"] == 1 and c["missing"] == 0 and c["dates"] == {"none": 1}


def test_open_interest_counts_tier1_contracts_and_their_nulls_apart(tmp_path: Path) -> None:
    class NoValue(Api):
        def __call__(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
            a = super().__call__(url, params, headers, timeout)
            if url.endswith("/v2/options/contracts") and isinstance(a.body, dict):
                a.body["option_contracts"][1].pop("open_interest")                # Alpaca sends no value
            return a

    ow, gw = PartWriter(tmp_path, "open_interest"), PartWriter(tmp_path, "gap")
    keep = {"AAA261119C00100000", "AAA261119C00200000", "BBB261119C00100000"}
    c = afterclose.open_interest(NoValue(), {}, ["AAA", "BBB"], dt.date(2026, 11, 19), dt.date(2026, 11, 27), keep, ow, gw,
                                 time.monotonic() + 60, session=dt.date(2026, 11, 19),
                                 tier1={"AAA261119C00200000", "BBB261119C00100000"})
    assert c["contracts"] == 3 and c["null_open_interest"] == 1
    assert c["contracts_tier1"] == 2 and c["null_open_interest_tier1"] == 1        # the null one is tier 1
