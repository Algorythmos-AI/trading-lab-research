"""Gap Hunter's own pages for what used to be journal-only: entries off at arm, a poll that keeps failing, no quotes
for an open position, and the position itself (filled, then closed with its R). Replayed on constructed days. No page
names a symbol or a price: the ntfy topic is public (wt.ops.alerts, "What a page may carry")."""
from __future__ import annotations

import pytest
from test_runner_s import Rec, at, flat_and_clean, journal
from test_runner_s import env as env  # noqa: F401 — the shared state fixture
from test_runner_s_gap import STALLED, STOPPED, gap, session, tape_of  # noqa: F401 — gap is a fixture

from wt.live import runner_s

pytestmark = pytest.mark.replay


def no_symbol(rec: Rec) -> None:
    for _kind, _key, _prio, title, message in rec.calls:
        assert "ABC" not in title and "ABC" not in message and "$" not in message


def test_a_trade_pages_when_it_fills_and_again_with_its_r_when_it_closes(gap):  # noqa: F811
    rec = Rec()
    b = session(tape_of(STOPPED), alerts=rec)
    fired = rec.page("paper-s:position", "fire")
    assert fired[2] == 3 and "in a trade" in fired[3]
    closed = rec.page("paper-s:position", "resolve")
    assert "closed" in closed[3] and closed[4].startswith("Closed at -1.") and "R." in closed[4]
    no_symbol(rec)
    flat_and_clean(b)


def test_a_day_with_no_trade_sends_no_position_page(gap):  # noqa: F811
    from test_runner_s_gap import NO_ENTRY
    rec = Rec()
    session(tape_of(NO_ENTRY), alerts=rec)
    assert "paper-s:position" not in rec.keys()


def test_arming_with_entries_off_pages_once(gap):  # noqa: F811
    runner_s.RECORD.write_text("# DEC-0066\n\n- **Status: PROPOSED on 2026-11-19.**\n")
    rec = Rec()
    session(tape_of(STALLED), alerts=rec)
    p = rec.page("paper-s:entries-off", "once_per_day")
    assert p[2] == 4 and "1 reason" in p[4]
    no_symbol(rec)


def test_three_failed_polls_in_a_row_page_once(gap, monkeypatch):  # noqa: F811
    calls = [0]
    real = runner_s.KILL

    class Flaky:                                       # the kill-file check fails for 5 polls after arming
        def exists(self) -> bool:
            calls[0] += 1
            if 2 <= calls[0] <= 6:
                raise OSError("simulated")
            return real.exists()
    monkeypatch.setattr(runner_s, "KILL", Flaky())
    rec = Rec()
    session(tape_of(STALLED), alerts=rec)
    j = journal(gap, allow_errors=True)
    assert sum(1 for r in j if r["event"] == "loop_error") == 5
    p = rec.page("paper-s:loop-error", "once_per_day")
    assert p[2] == 5 and "last 3 polls" in p[4]


def test_a_single_failed_poll_does_not_page(gap, monkeypatch):  # noqa: F811
    calls = [0]
    real = runner_s.KILL

    class Once:
        def exists(self) -> bool:
            calls[0] += 1
            if calls[0] in (2, 4):                     # two failures, never two in a row
                raise OSError("simulated")
            return real.exists()
    monkeypatch.setattr(runner_s, "KILL", Once())
    rec = Rec()
    session(tape_of(STALLED), alerts=rec)
    assert "paper-s:loop-error" not in rec.keys()


def test_two_minutes_without_quotes_for_an_open_position_pages(gap, monkeypatch):  # noqa: F811
    real = runner_s.Data.quote

    def quote(self, sym):
        if at(9, 31, 30) <= self.clock() < at(9, 34, 30):
            raise TimeoutError("simulated")
        return real(self, sym)
    monkeypatch.setattr(runner_s.Data, "quote", quote)
    rec = Rec()
    b = session(tape_of(STALLED), alerts=rec)
    j = journal(gap, allow_errors=True)
    assert any(r["event"] == "data_timeout" and r.get("what") == "quote" for r in j)
    assert rec.page("paper-s:data-timeout", "once_per_day")[2] == 4
    flat_and_clean(b)
