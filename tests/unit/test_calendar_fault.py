"""The deploy gate says why the market calendar could not be read: rejected keys, no secrets file, or an outage.

Every case goes through window.load_sessions with the real client (wt.data.alpaca.AlpacaREST) and the real
wt.core.config.env; only requests.Session.get is replaced. So there is no network, and an exception reworded in
either module fails here instead of quietly becoming "cause unknown".
"""
from __future__ import annotations

import datetime as dt
import json

import pytest
import requests

from wt.ops import deploy, window
from wt.ops.schedule import SYDNEY

NOW = dt.datetime(2026, 9, 30, 14, 0, tzinfo=SYDNEY)     # 00:00 ET on a session day: no blackout, no job due
KEY_ID, KEY_SECRET = "test-key-id", "test-key-secret"
ROWS = [{"date": "2026-09-30", "open": "09:30", "close": "16:00"}]
OLD_LINE = "market calendar unavailable (weekday fallback in use); retry when the Alpaca calendar answers"


def answer(status: int, body: object = None) -> requests.Response:
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps({"message": f"key {KEY_ID} refused"} if body is None else body).encode()
    return r


@pytest.fixture
def alpaca(monkeypatch):
    """Keys in the environment, and every GET answered by what the test passes in. Returns the list of calls."""
    monkeypatch.setenv("APCA_API_KEY_ID", KEY_ID)
    monkeypatch.setenv("APCA_API_SECRET_KEY", KEY_SECRET)
    monkeypatch.setattr("wt.data.alpaca.time.sleep", lambda s: None)        # the client's back-off between tries

    def serve(outcome: requests.Response | Exception) -> list[str]:
        calls: list[str] = []

        def get(self, url, params=None, timeout=None):
            calls.append(url)
            if isinstance(outcome, Exception):
                raise outcome
            # as on the wire: the error carries the request, and the request carries the keys in its headers
            outcome.request = requests.Request("GET", url, headers=dict(self.headers), params=params).prepare()
            outcome.url = outcome.request.url
            return outcome

        monkeypatch.setattr(requests.Session, "get", get)
        return calls

    return serve


def gate_line(sessions, exact) -> str:
    [line] = window.deploy_blockers(NOW, sessions, {}, [], exact)           # the gate is closed, for this one reason
    assert KEY_ID not in line and KEY_SECRET not in line
    return line


@pytest.mark.parametrize("status", [401, 403])
def test_rejected_keys_are_reported_as_keys_and_not_as_an_outage(alpaca, status):
    calls = alpaca(answer(status))
    sessions, exact = window.load_sessions(NOW)
    assert not exact and exact.kind == "credentials"
    assert sessions == window.weekday_sessions(dt.date(2026, 9, 25), 16)    # still the fallback: fails closed
    line = gate_line(sessions, exact)
    assert f"Alpaca rejected this host's API keys (HTTP {status} from /v2/calendar)" in line
    assert "not an outage" in line and "sudo wt-set-secrets" in line and window.RETRY not in line
    assert len(calls) == 1                                                  # a refusal is not retried


@pytest.mark.parametrize("missing", ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"])
def test_a_missing_env_var_points_at_the_secrets_file(alpaca, monkeypatch, missing):
    calls = alpaca(answer(200, ROWS))
    monkeypatch.delenv(missing)
    sessions, exact = window.load_sessions(NOW)
    assert not exact and exact.kind == "secrets" and calls == []
    line = gate_line(sessions, exact)
    assert f"{missing} is not set: this host's secrets file is missing or unreadable" in line
    assert "sudo wt-set-secrets" in line and window.RETRY not in line


@pytest.mark.parametrize("outcome", [answer(503), answer(429), requests.ConnectionError("no route")],
                         ids=["5xx", "429", "network"])
def test_an_outage_keeps_the_retry_wording(alpaca, outcome):
    calls = alpaca(outcome)
    sessions, exact = window.load_sessions(NOW)
    assert not exact and exact.kind == "unreachable" and len(calls) == 8
    line = gate_line(sessions, exact)
    assert "Alpaca did not answer (GET failed after 8 tries" in line and line.endswith(window.RETRY)
    assert "wt-set-secrets" not in line


def test_an_unknown_failure_is_not_filed_under_a_known_cause(alpaca):
    alpaca(answer(200, []))                         # no rows: the client's own KeyError, not a missing env var
    sessions, exact = window.load_sessions(NOW)
    assert not exact and exact.kind == "other"
    assert "the calendar read failed (KeyError)" in gate_line(sessions, exact)
    alpaca(answer(404))
    sessions, exact = window.load_sessions(NOW)
    assert not exact and exact.kind == "other"
    assert "the calendar read failed (HTTP 404 from /v2/calendar)" in gate_line(sessions, exact)


def test_other_causes_are_classified_without_the_client():
    assert window.calendar_fault(requests.Timeout("slow")).kind == "unreachable"
    assert window.calendar_fault(ImportError("No module named 'pandas'")).kind == "other"   # and it still fails closed
    assert window.calendar_fault(RuntimeError("something else")).kind == "other"
    assert not window.calendar_fault(Exception())


def test_a_good_answer_is_exact_and_opens_the_gate(alpaca):
    alpaca(answer(200, ROWS))
    sessions, exact = window.load_sessions(NOW)
    assert exact is True and list(sessions) == [dt.date(2026, 9, 30)]
    assert window.deploy_blockers(NOW, sessions, {}, [], exact) == []


def test_a_bare_false_keeps_the_old_line():
    assert gate_line({}, False) == OLD_LINE


def test_the_gate_command_prints_the_cause(alpaca, monkeypatch, tmp_path, capsys):
    alpaca(answer(401))
    monkeypatch.setattr("wt.ops.locks.LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr(deploy, "running_jobs", lambda: {})
    monkeypatch.setattr(deploy, "_now", lambda: NOW)
    assert deploy.main(["gate"]) == 2
    out = capsys.readouterr().out
    assert out.startswith("Deploy gate CLOSED:\n  market calendar unavailable (weekday fallback in use): Alpaca rej")
    assert "sudo wt-set-secrets" in out and KEY_ID not in out and KEY_SECRET not in out
