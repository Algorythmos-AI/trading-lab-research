"""Gap Hunter's own document every minute in session (DEC-0078, wt.ops.gap_live): the same block as the snapshot's,
cleaned by the same allow-list, sent on the minute only from 08:30 to close + 15, and never a page for one blip."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from wt.core.clock import ET
from wt.ops import gap_live, publish
from wt.ops.schedule import JOBS

ENV = {"DASHBOARD_INGEST_URL": "https://example.test/api/ingest", "DASHBOARD_INGEST_SECRET": "s"}


def ny(h: int, m: int, day: dt.date = dt.date(2026, 11, 25)) -> dt.datetime:
    return dt.datetime(day.year, day.month, day.day, h, m, tzinfo=ET)


FULL = (ny(9, 30), ny(16, 0))
HALF = (ny(9, 30, dt.date(2026, 11, 27)), ny(13, 0, dt.date(2026, 11, 27)))


def view() -> dict[str, Any]:
    return {
        "enabled": True, "kill": False, "latched": False, "sessions": 3, "last_session": "2026-11-25", "trades": 1,
        "total_r": -1.0, "mean_r": -1.0, "open": 1, "as_of": "2026-11-25T14:41:00+00:00",
        "funnel": {"session": "2026-11-25", "kept": 40, "passed": 9, "tier1": 2, "tier2": 3, "primary": True},
        "heartbeat": {"session": "2026-11-25", "armed_at": "2026-11-25T14:25:00+00:00",
                      "last_row": "2026-11-25T14:40:30+00:00", "rows_today": 12, "ended": False},
        "pick": {"symbol": "ABC", "rank": 1, "why": None, "tier2": ["DEF", "GHI"]},
        "rules": [{"rule": "e1", "why": "waiting", "trigger": 10.5, "stop": 9.9}],
        "timeline": [{"t": "2026-11-25T14:25:00+00:00", "event": "armed", "code": None, "why": None, "symbol": None,
                      "r": None, "detail": "free text never leaves the host"}],
        "position": {"symbol": "ABC", "code": "e1", "state": "in_position", "origin": "entry", "shares": 100,
                     "sold_at_target": 0, "entry": 10.5, "trigger": 10.5, "stop": 9.9, "stop0": 9.9, "target": 11.7},
        "closed": [], "safety": {"x_latched": [], "stop_rule": None}, "rotation": None,
        "setup": "a setup name is never published",
    }


def san() -> publish.Sanitizer:
    return publish.Sanitizer(lambda x: x, None, strict=False)


def test_the_published_schema_is_the_generated_one_and_its_block_is_the_snapshots() -> None:
    assert json.loads(gap_live.SCHEMA_PATH.read_text()) == gap_live.to_schema()
    mine = gap_live.to_schema()["properties"]["gap_hunter"]
    theirs = json.loads(publish.SCHEMA_PATH.read_text())["properties"]["gap_hunter"]
    assert {**mine, "type": theirs["type"]} == theirs


def test_the_document_carries_the_block_and_nothing_outside_the_allow_list() -> None:
    doc = gap_live.build(ny(9, 41), "r1", san(), view())
    assert gap_live.validate(doc) == []
    assert doc["schema"] == "stocksdelta/gap-hunter-live" and doc["paper"] is True and doc["schema_version"] == 1
    assert doc["gap_hunter"]["position"]["symbol"] == "ABC"
    text = json.dumps(doc)
    assert "free text" not in text and "setup" not in text and "detail" not in text


def test_a_document_that_is_not_paper_or_names_another_schema_is_refused() -> None:
    doc = gap_live.build(ny(9, 41), "r1", san(), view())
    assert gap_live.validate({**doc, "paper": False})
    assert gap_live.validate({**doc, "schema": "trading-lab/snapshot"})


@pytest.mark.parametrize(("at", "session", "want"), [
    (ny(8, 29), FULL, False), (ny(8, 30), FULL, True), (ny(12, 1), FULL, True), (ny(16, 15), FULL, True),
    (ny(16, 16), FULL, False), (ny(16, 20), FULL, True),                       # :20 is on the 15-minute rhythm
    (ny(13, 15, HALF[0].date()), HALF, True), (ny(13, 16, HALF[0].date()), HALF, False),
    (ny(14, 1, HALF[0].date()), HALF, False), (ny(14, 5, HALF[0].date()), HALF, True),
    (ny(10, 1, dt.date(2026, 11, 26)), None, False), (ny(10, 50, dt.date(2026, 11, 26)), None, True),
])
def test_it_sends_every_minute_from_0830_to_close_plus_15_and_on_the_slow_rhythm_otherwise(at, session, want) -> None:
    assert gap_live.due(at, session) is want


def test_the_days_session_is_read_once_and_a_fallback_is_not_kept(tmp_path: Path, monkeypatch) -> None:
    from wt.ops import window
    calls: list[bool] = []

    def load(now, back=5, ahead=10, exact=True):
        calls.append(True)
        return {now.astimezone(ET).date(): window.Session(now.date(), *HALF)}, exact
    monkeypatch.setattr(window, "load_sessions", load)
    cache = tmp_path / "session.json"
    assert gap_live.session_today(HALF[0], cache) == HALF
    assert gap_live.session_today(HALF[0], cache) == HALF
    assert len(calls) == 1
    monkeypatch.setattr(window, "load_sessions", lambda now, back=5, ahead=10: load(now, exact=window.calendar_fault(OSError())))
    other = tmp_path / "other.json"
    gap_live.session_today(HALF[0], other)
    assert not other.exists()


class Sent(list):
    result: dict[str, bool]


@pytest.fixture
def sends(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Sent:
    out = Sent()
    result = {"ok": True}

    def send(data: bytes, url: str, secret: str, bypass: str | None, tries: int = 3, deadline: float | None = None,
             key_id: str | None = None) -> tuple[bool, str]:
        out.append(data)
        return (True, "200 stored") if result["ok"] else (False, "HTTP 503")
    monkeypatch.setattr(publish, "send", send)
    monkeypatch.setattr(publish, "read_health",
                        lambda url, bypass: ({"editions": {"gap_hunter_live": {"accepts": 1}}}, ""))
    monkeypatch.setattr(gap_live, "session_today", lambda now, cache: FULL)
    out.result = result
    return out


def test_a_quiet_minute_is_still_sent_so_the_page_can_tell_fresh_from_stale(tmp_path: Path, sends) -> None:
    for m in (41, 42, 43):
        assert gap_live.run(ny(9, m), env=ENV, out=tmp_path, view=view(), san=san()) == 0
    assert len(sends) == 3
    assert json.loads(sends[-1])["as_of"].startswith("2026-11-25T09:43")


def test_nothing_is_sent_outside_the_window_off_the_rhythm(tmp_path: Path, sends) -> None:
    assert gap_live.run(ny(17, 1), env=ENV, out=tmp_path, view=view(), san=san()) == 0
    assert sends == []


def test_nothing_is_sent_until_the_site_takes_the_document(tmp_path: Path, sends, monkeypatch) -> None:
    monkeypatch.setattr(publish, "read_health", lambda url, bypass: ({"editions": {"paper_options": {"accepts": 5}}}, ""))
    assert gap_live.run(ny(9, 41), env=ENV, out=tmp_path, view=view(), san=san()) == 0
    assert sends == []
    assert not (tmp_path / "site_accepts.json").exists()        # asked again next run, not remembered as 0


def test_one_failed_send_is_not_a_failed_job_three_in_a_row_are_and_a_success_resets(tmp_path: Path, sends) -> None:
    sends.result["ok"] = False
    rcs = [gap_live.run(ny(9, m), env=ENV, out=tmp_path, view=view(), san=san()) for m in (41, 42, 43)]
    assert rcs == [0, 0, 1]
    sends.result["ok"] = True
    assert gap_live.run(ny(9, 44), env=ENV, out=tmp_path, view=view(), san=san()) == 0
    sends.result["ok"] = False
    assert gap_live.run(ny(9, 45), env=ENV, out=tmp_path, view=view(), san=san()) == 0


def test_a_fault_never_raises(tmp_path: Path, sends) -> None:
    assert gap_live.run(ny(9, 41), env=ENV, out=tmp_path, view={"timeline": object()}, san=san()) in (0, 2)


def test_the_job_runs_every_minute_in_session_and_its_slow_rhythm_keeps_the_cadence_check() -> None:
    j = JOBS["gap-hunter-publish"]
    assert j.command == ("-m", "wt.ops.gap_live") and not j.trading and not j.preflight and j.desk == "stocks"
    assert j.interval_s == 900 and "*:05/15:30 UTC" in j.calendars
    assert any("/1:30 America/New_York" in c for c in j.calendars)
