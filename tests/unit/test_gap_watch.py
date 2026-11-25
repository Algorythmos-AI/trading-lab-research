"""wt.ops.gap_watch: Gap Hunter's watch from outside its process. No host, no network: fixtures and tmp_path only."""
from __future__ import annotations

import datetime as dt
import json

import pytest

from wt.core.clock import ET
from wt.ops import gap_watch as gw
from wt.ops.window import Session

DAY = dt.date(2026, 11, 24)


def et(h: int, m: int, day: dt.date = DAY) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=ET)


OPEN, CLOSE = et(9, 30), et(16, 0)
RUNNING = {"job": "paper-s", "status": "running", "started": et(8, 30).astimezone(dt.UTC).isoformat()}


def keys(found: list[gw.Finding]) -> list[str]:
    return [f.key for f in found]


def test_a_runner_up_and_armed_is_no_finding():
    assert gw.findings(et(10, 0), OPEN, CLOSE, RUNNING, True, True, 0) == []


@pytest.mark.parametrize("now", [et(8, 0), et(9, 34), et(15, 59), et(16, 30)])
def test_nothing_is_watched_before_the_open_plus_5_or_in_the_last_minute(now):
    assert gw.findings(now, OPEN, CLOSE, None, False, False, 0) == []


def test_a_day_with_no_session_is_never_watched():
    assert gw.findings(et(10, 0), None, None, None, False, False, 1) == []


def test_a_half_day_is_watched_to_its_own_close():
    half = et(13, 0)
    assert keys(gw.findings(et(12, 30), OPEN, half, None, False, False, 0)) == ["paper-s:watch-not-started"]
    assert gw.findings(et(13, 30), OPEN, half, None, False, False, 0) == []


def test_no_run_today_is_not_started():
    yesterday = {**RUNNING, "started": et(8, 30, DAY - dt.timedelta(days=1)).isoformat(), "status": "ok"}
    for hb in (None, yesterday):
        found = gw.findings(et(9, 40), OPEN, CLOSE, hb, False, False, 0)
        assert keys(found) == ["paper-s:watch-not-started"] and found[0].priority == 4


@pytest.mark.parametrize("status, word", [("refused", "refused"), ("failed", "failed"), ("ok", "ended"),
                                          ("timeout", "deadline")])
def test_a_run_that_ended_in_the_session_says_how(status, word):
    found = gw.findings(et(11, 0), OPEN, CLOSE, {**RUNNING, "status": status}, False, True, 0)
    assert keys(found) == ["paper-s:watch-ended"] and word in found[0].message


def test_a_refused_restart_with_a_position_open_is_priority_5():
    """The audit's M5: a restart whose preflight is refused exits 0 and is never restarted."""
    found = gw.findings(et(11, 0), OPEN, CLOSE, {**RUNNING, "status": "refused"}, False, True, 1)
    assert found[0].priority == 5 and "1 open position" in found[0].message


def test_a_running_heartbeat_with_no_process_is_dead():
    found = gw.findings(et(11, 0), OPEN, CLOSE, RUNNING, False, True, 0)
    assert keys(found) == ["paper-s:watch-dead"] and found[0].priority == 5


def test_up_but_not_armed_by_the_open_plus_5():
    assert keys(gw.findings(et(9, 35), OPEN, CLOSE, RUNNING, True, False, 0)) == ["paper-s:watch-not-armed"]


def test_armed_reads_only_todays_row():
    rows = [{"event": "armed", "day": "2026-11-23"}, {"event": "session_end"}]
    assert not gw.armed_on(rows, DAY)
    assert gw.armed_on([*rows, {"event": "armed", "day": "2026-11-24"}], DAY)


def test_the_journal_tail_skips_a_torn_first_line_and_bad_lines(tmp_path):
    f = tmp_path / "j.jsonl"
    rows = [json.dumps({"event": "x", "n": i, "pad": "p" * 50}) for i in range(100)]
    f.write_text("\n".join([*rows, "not json"]) + "\n")
    tail = gw.journal_tail(f, max_bytes=500)
    assert tail and all(r["event"] == "x" for r in tail) and tail[-1]["n"] == 99
    assert gw.journal_tail(tmp_path / "missing.jsonl") == []


def test_open_positions_counts_plans_holding_shares(tmp_path):
    for i, state in enumerate(["in_position", "exiting", "closed", "entry_working"]):
        (tmp_path / f"p{i}.json").write_text(json.dumps({"state": state}))
    (tmp_path / "bad.json").write_text("{")
    assert gw.open_positions(tmp_path) == 2
    assert gw.open_positions(tmp_path / "none") == 0


class FakeAlerts:
    def __init__(self, firing: set[str] | None = None) -> None:
        self.firing_keys = set(firing or ())
        self.sent: list[tuple[str, str, int]] = []

    def fire(self, key, title, message, priority=4):
        if key in self.firing_keys:
            return False
        self.firing_keys.add(key)
        self.sent.append(("fire", key, priority))
        return True

    def resolve(self, key, title, message, priority=2):
        if key not in self.firing_keys:
            return False
        self.firing_keys.discard(key)
        self.sent.append(("resolve", key, priority))
        return True


@pytest.fixture
def host(tmp_path, monkeypatch):
    from wt.live import runner_s
    from wt.ops import heartbeat, locks, window
    hb = tmp_path / "heartbeats"
    hb.mkdir()
    monkeypatch.setattr(runner_s, "JOURNAL", tmp_path / "journal.jsonl")
    monkeypatch.setattr(runner_s, "PLANS", tmp_path / "plans")
    monkeypatch.setattr(runner_s, "switched_on", lambda: frozenset({"HYP-0071"}))
    monkeypatch.setattr(heartbeat, "HEARTBEAT_DIR", hb)
    monkeypatch.setattr(locks, "is_held", lambda name, root=None: True)
    monkeypatch.setattr(window, "load_sessions",
                        lambda now, *a, **k: ({DAY: Session(DAY, OPEN, CLOSE)}, True))
    return tmp_path


def test_run_pages_once_a_day_and_resolves_when_it_clears(host):
    (host / "heartbeats" / "paper-s.json").write_text(json.dumps(RUNNING))
    a = FakeAlerts()
    assert gw.run(et(9, 40), a) == ["paper-s:watch-not-armed"]
    assert gw.run(et(9, 45), a) == []                                  # still firing: no second page
    (host / "journal.jsonl").write_text(json.dumps({"event": "armed", "day": DAY.isoformat()}) + "\n")
    gw.run(et(9, 50), a)
    assert a.sent == [("fire", "paper-s:watch-not-armed:2026-11-24", 4),
                      ("resolve", "paper-s:watch-not-armed:2026-11-24", 2)]


def test_run_is_silent_when_nothing_is_switched_on(host, monkeypatch):
    from wt.live import runner_s
    monkeypatch.setattr(runner_s, "switched_on", lambda: frozenset())
    a = FakeAlerts()
    assert gw.run(et(10, 0), a) == [] and a.sent == []


def test_run_watches_no_holiday(host, monkeypatch):
    from wt.ops import window
    monkeypatch.setattr(window, "load_sessions", lambda now, *a, **k: ({}, True))
    a = FakeAlerts()
    assert gw.run(et(10, 0, dt.date(2026, 11, 26)), a) == [] and a.sent == []


def test_the_publish_job_never_fails_over_the_watch(monkeypatch, capsys):
    from wt.ops import publish

    def boom(*a, **k):
        raise RuntimeError("no host")
    monkeypatch.setattr(gw, "run", boom)
    publish.gap_hunter_watch()
    assert "could not run (RuntimeError)" in capsys.readouterr().out
