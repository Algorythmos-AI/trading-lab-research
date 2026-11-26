"""wt.data.news_archive: paging, filing by New York date, merge by id, atomic writes and done markers (fixtures)."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from wt.data import news_archive as na

NOW = dt.datetime(2026, 11, 26, 12, 0, tzinfo=dt.timezone.utc)
DAY = dt.date(2026, 11, 20)


def item(i: int, created: str, updated: str | None = None, headline: str = "h", syms: Any = None) -> dict[str, Any]:
    return {"id": i, "created_at": created, "updated_at": updated or created, "headline": headline,
            "symbols": ["AAA"] if syms is None else syms, "source": "fiscal.ai", "url": "u", "summary": "s"}


class Pages:
    """A fake API: answers the given pages in order and records each request's params."""

    def __init__(self, pages: list[Any]) -> None:
        self.pages = pages
        self.calls: list[dict[str, Any]] = []

    def __call__(self, url: str, params: dict[str, Any]) -> Any:
        assert url == na.NEWS_URL
        self.calls.append(params)
        return self.pages[len(self.calls) - 1]


def test_day_window_is_new_york_midnight_to_midnight_across_dst() -> None:
    assert na.day_window(dt.date(2026, 11, 20)) == ("2026-11-20T05:00:00Z", "2026-11-21T05:00:00Z")
    assert na.day_window(dt.date(2026, 11, 1)) == ("2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z")   # 25 hours
    assert na.day_window(dt.date(2026, 3, 8)) == ("2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z")    # 23 hours


def test_fetch_follows_every_page_and_sends_no_feed_or_symbols() -> None:
    api = Pages([{"news": [item(1, "2026-11-20T14:00:00Z")], "next_page_token": "t1"},
                 {"news": [item(2, "2026-11-20T15:00:00Z")], "next_page_token": None}])
    rows, pages = na.fetch_day(api, DAY)
    assert [r["id"] for r in rows] == [1, 2] and pages == 2
    assert "page_token" not in api.calls[0] and api.calls[1]["page_token"] == "t1"
    assert all("symbols" not in c and "feed" not in c and c["include_content"] == "false" for c in api.calls)
    assert "summary" not in rows[0]


@pytest.mark.parametrize("bad", [{"nope": []}, {"news": "x"}, [], {"news": [{"id": None, "created_at": "x"}]},
                                 {"news": [item(1, "2026-11-20T14:00:00Z", syms="AAA")]}])
def test_a_malformed_answer_raises(bad: Any) -> None:
    with pytest.raises(na.ArchiveError):
        na.fetch_day(Pages([bad]), DAY)


def test_a_repeated_page_token_raises() -> None:
    page = {"news": [], "next_page_token": "same"}
    with pytest.raises(na.ArchiveError):
        na.fetch_day(Pages([page, page]), DAY)


def test_items_are_filed_by_their_own_new_york_date(tmp_path: Path) -> None:
    rows = [na._row(item(1, "2026-11-21T04:59:00Z")),      # 23:59 ET on the 20th
            na._row(item(2, "2026-11-21T05:00:00Z"))]      # 00:00 ET on the 21st
    counts = na.store(tmp_path, rows)
    assert counts == {dt.date(2026, 11, 20): 1, dt.date(2026, 11, 21): 1}
    assert na.read_day(tmp_path, dt.date(2026, 11, 20))["id"].tolist() == [1]


def test_merge_keeps_one_row_per_id_with_the_latest_edit(tmp_path: Path) -> None:
    na.store(tmp_path, [na._row(item(1, "2026-11-20T14:00:00Z", "2026-11-20T14:00:00Z", "old"))])
    na.store(tmp_path, [na._row(item(1, "2026-11-20T14:00:00Z", "2026-11-20T16:00:00Z", "new")),
                        na._row(item(2, "2026-11-20T13:00:00Z"))])
    na.store(tmp_path, [na._row(item(1, "2026-11-20T14:00:00Z", "2026-11-20T15:00:00Z", "middle"))])
    df = na.read_day(tmp_path, DAY)
    assert df["id"].tolist() == [2, 1]                       # by created_at
    assert df.set_index("id").loc[1, "headline"] == "new"


def test_a_finished_day_is_marked_and_a_rerun_adds_no_duplicates(tmp_path: Path) -> None:
    page = {"news": [item(1, "2026-11-20T14:00:00Z"), item(2, "2026-11-20T15:00:00Z")]}
    info = na.archive_day(Pages([page]), tmp_path, DAY, NOW)
    assert info["complete"] and info["items_on_day"] == 2 and na.is_done(tmp_path, DAY)
    assert json.loads(na.marker_path(tmp_path, DAY).read_text())["items_fetched"] == 2
    na.archive_day(Pages([page]), tmp_path, DAY, NOW)
    assert len(na.read_day(tmp_path, DAY)) == 2


def test_today_is_stored_but_not_marked(tmp_path: Path) -> None:
    today = NOW.date()
    info = na.archive_day(Pages([{"news": [item(1, "2026-11-26T14:00:00Z")]}]), tmp_path, today, NOW)
    assert not info["complete"] and not na.is_done(tmp_path, today)
    assert len(na.read_day(tmp_path, today)) == 1


def test_a_failure_between_pages_writes_nothing_and_marks_nothing(tmp_path: Path) -> None:
    class Boom(Pages):
        def __call__(self, url: str, params: dict[str, Any]) -> Any:
            if params.get("page_token"):
                raise RuntimeError("network")
            return super().__call__(url, params)

    with pytest.raises(RuntimeError):
        na.archive_day(Boom([{"news": [item(1, "2026-11-20T14:00:00Z")], "next_page_token": "t"}]),
                       tmp_path, DAY, NOW)
    assert not na.day_path(tmp_path, DAY).exists() and not na.is_done(tmp_path, DAY)
    assert na.missing(tmp_path, DAY, DAY) == [DAY]


def test_an_empty_finished_day_is_marked_with_no_file(tmp_path: Path) -> None:
    info = na.archive_day(Pages([{"news": [], "next_page_token": None}]), tmp_path, DAY, NOW)
    assert info["items_on_day"] == 0 and na.is_done(tmp_path, DAY) and not na.day_path(tmp_path, DAY).exists()


def test_no_temporary_file_is_left_behind(tmp_path: Path) -> None:
    na.archive_day(Pages([{"news": [item(1, "2026-11-20T14:00:00Z")]}]), tmp_path, DAY, NOW)
    assert not [p for p in tmp_path.rglob("*") if ".tmp" in p.name]


def test_catch_up_range_ends_yesterday_in_new_york_and_never_before_the_first_day() -> None:
    late = dt.datetime(2026, 11, 26, 3, 0, tzinfo=dt.timezone.utc)       # 22:00 ET on the 25th
    assert na.catch_up_range(late, 3) == (dt.date(2026, 11, 22), dt.date(2026, 11, 24))
    assert na.catch_up_range(dt.datetime(2026, 5, 2, 12, tzinfo=dt.timezone.utc), 30)[0] == na.FIRST_DAY
    with pytest.raises(ValueError):
        na.days(DAY, DAY - dt.timedelta(days=1))


def test_the_script_never_prints_a_headline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                            capsys: pytest.CaptureFixture[str]) -> None:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "news_archive_script", Path(__file__).resolve().parents[2] / "scripts" / "news_archive.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    class FakeClient:
        def __init__(self, **_: Any) -> None:
            pass

        def get(self, url: str, params: dict[str, Any]) -> Any:
            return {"news": [item(1, "2026-11-20T14:00:00Z", headline="SECRET HEADLINE")]}

    import wt.data.alpaca as alp
    monkeypatch.setattr(alp, "AlpacaREST", FakeClient)
    assert mod.main(["--day", "2026-11-20", "--root", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "SECRET" not in out and "items=1" in out
