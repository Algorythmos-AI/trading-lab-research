"""The options live document (wt.options.live): read only, paper only, and nothing about the account but its
open option contracts."""
from __future__ import annotations

import argparse
import datetime as dt
import inspect
import json

import pytest
import requests

from wt.ops import publish, units
from wt.ops.schedule import JOBS
from wt.options import live

NOW = dt.datetime(2026, 10, 12, 16, 0, tzinfo=dt.UTC)
CLOCK = {"timestamp": "2026-10-12T12:00:00-04:00", "is_open": True, "next_open": "2026-10-13T09:30:00-04:00",
         "next_close": "2026-10-12T16:00:00-04:00"}


def option(symbol="SPY261023C00780000", qty="2", **over):
    return {"asset_class": "us_option", "symbol": symbol, "qty": qty, "side": "long", "avg_entry_price": "2.85",
            "current_price": "3.1", "market_value": "620", "unrealized_pl": "50", "asset_id": "x", "cost_basis": "570",
            **over}


class Reply:
    def __init__(self, status=200, body=None, text=None):
        self.status_code, self._body, self._text = status, body, text

    def json(self):
        if self._text is not None:
            raise ValueError("not json")
        return self._body


class Session:
    """Stands in for requests.Session: it answers GETs and has nothing else to call."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def get(self, url, headers=None, timeout=None, allow_redirects=True):
        assert allow_redirects is False
        self.calls.append(url)
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class Account:
    def __init__(self, positions=None, clock=CLOCK):
        self._p, self._c = positions, clock

    def positions(self):
        if isinstance(self._p, Exception):
            raise self._p
        return self._p

    def clock(self):
        if isinstance(self._c, Exception):
            raise self._c
        return self._c


@pytest.fixture(autouse=True)
def _state(tmp_path, monkeypatch):
    monkeypatch.setattr(live, "OUT", tmp_path / "options-live")
    monkeypatch.setattr(live.time, "sleep", lambda s: None)
    for name in (live.KEY_ID_VAR, live.SECRET_VAR, "DASHBOARD_INGEST_URL", "DASHBOARD_INGEST_SECRET", "WT_ROLE",
                 "DASHBOARD_KEY_ID"):
        monkeypatch.delenv(name, raising=False)


def test_the_module_can_only_read_and_only_from_the_paper_host():
    src = inspect.getsource(live)
    assert live.PAPER_HOST == "https://paper-api.alpaca.markets"
    for word in (".post(", ".put(", ".patch(", ".delete(", "/v2/orders", "TradingClient", "api.alpaca.markets/v2"):
        assert word not in src.replace(live.PAPER_HOST, ""), word
    assert "APCA_API_KEY_ID" not in src                    # never strategy B's account
    assert [n for n in vars(live.OptionsAccount) if not n.startswith("_")] == ["positions", "clock"]
    s = Session(Reply(200, []), Reply(200, CLOCK))
    acct = live.OptionsAccount("k", "s", s)
    acct.positions(), acct.clock()
    assert s.calls == [live.PAPER_HOST + "/v2/positions", live.PAPER_HOST + "/v2/clock"]


def test_rows_carry_the_contract_and_its_numbers_and_nothing_else():
    rows, left_out = live.position_rows([
        option(),
        option("NVDA261023P00230000", "-1", side="short", market_value="-290", unrealized_pl="-50"),
        option("IWM261023C00250000", "1", avg_entry_price=None, current_price="nan"),
        option("QQQ261023C00500000", "3", side="short"),                          # short, quantity sent unsigned
    ])
    assert left_out == []
    assert rows == [
        {"contract": "IWM261023C00250000", "qty": 1, "market_value": 620.0, "unrealized_pl": 50.0},
        {"contract": "NVDA261023P00230000", "qty": -1, "avg_price": 2.85, "price": 3.1, "market_value": -290.0,
         "unrealized_pl": -50.0},
        {"contract": "QQQ261023C00500000", "qty": -3, "avg_price": 2.85, "price": 3.1, "market_value": 620.0,
         "unrealized_pl": 50.0},
        {"contract": "SPY261023C00780000", "qty": 2, "avg_price": 2.85, "price": 3.1, "market_value": 620.0,
         "unrealized_pl": 50.0},
    ]


def test_what_is_not_a_standard_option_contract_is_counted_and_never_sent():
    rows, left_out = live.position_rows([
        {"asset_class": "us_equity", "symbol": "SPY", "qty": "100"},          # stock, after an exercise
        option("NVDA1261218C00120000"),                                         # adjusted: not 100 shares
        option("spy261023c00780000"),
        option(qty="1.5"), option(qty="0"), option(qty="x"), option(qty="10000"), "torn", None,
    ])
    assert rows == []
    assert left_out == ["not-an-option:1", "not-standard:2", "unreadable:6"]
    many, left_out = live.position_rows([option(f"SPY261023C{n:08d}") for n in range(1000, 121000, 1000)])
    assert len(many) == live.MAX_POSITIONS and left_out == ["over-the-limit:20"]


def test_the_document_passes_the_sites_contract_and_names_nothing_about_the_account():
    doc = live.build([option(), {"asset_class": "us_equity", "symbol": "SPY", "qty": "100"}], CLOCK, "r1", NOW)
    assert live.validate(doc) == []
    assert doc["paper"] is True and doc["as_of"] == "2026-10-12T16:00:00+00:00"
    assert doc["market"] == {"is_open": True, "next_open": CLOCK["next_open"], "next_close": CLOCK["next_close"]}
    assert doc["problems"] == ["not-an-option:1"]
    text = json.dumps(doc)
    for word in ("asset_id", "cost_basis", "account", "equity", "buying_power", "cash"):
        assert word not in text, word
    assert live.validate(live.build([], None, "r2", NOW)) == []               # nothing held, clock unreadable
    assert live.build([], None, "r2", NOW)["market"] is None
    odd = live.market({"is_open": "yes", "next_open": "<b>soon</b>", "next_close": CLOCK["next_close"]})
    assert odd == {"is_open": None, "next_open": None, "next_close": CLOCK["next_close"]}
    assert live.validate({**doc, "paper": False}) and live.validate({**doc, "equity": 1.0})


@pytest.mark.parametrize("replies,code", [
    ([Reply(401)], "keys-rejected"),
    ([Reply(403)], "keys-rejected"),
    ([Reply(404)], "http-404"),
    ([Reply(302)], "http-302"),
    ([Reply(503), Reply(503), Reply(503)], "http-503"),
    ([requests.ConnectTimeout(), requests.ConnectTimeout(), requests.ConnectTimeout()], "network-ConnectTimeout"),
    ([Reply(200, text="<html>")], "not-json"),
    ([Reply(200, {"message": "x"})], "positions-not-a-list"),
])
def test_a_broker_fault_is_a_fixed_code_never_the_response(replies, code):
    with pytest.raises(live.BrokerFault) as e:
        live.OptionsAccount("k", "s", Session(*replies)).positions()
    assert e.value.code == code


def test_a_transient_fault_is_retried():
    s = Session(Reply(503), requests.ConnectionError(), Reply(200, [option()]))
    assert len(live.OptionsAccount("k", "s", s).positions()) == 1 and len(s.calls) == 3


def args(**kw):
    return argparse.Namespace(dry_run=False, verify=False, **kw)


def test_without_the_accounts_keys_the_job_does_nothing(capsys):
    assert live._publish(args()) == 0
    assert "not configured" in capsys.readouterr().out
    assert not (live.OUT / "outbox").exists()


def test_an_unreadable_account_sends_nothing_and_fails_on_the_second_run_in_a_row(monkeypatch, capsys):
    sent = []
    monkeypatch.setattr(publish, "send", lambda *a, **k: sent.append(a) or (True, "HTTP 200"))
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    broken = Account(live.BrokerFault("keys-rejected"))
    assert live._publish(args(), broken) == 0                # the first is noise
    assert live._publish(args(), broken) == 1                # the second alerts
    assert sent == [] and "keys-rejected" in capsys.readouterr().err
    assert live._publish(args(), Account([option()])) == 0   # and a good run clears the count
    assert len(sent) == 1
    assert live._publish(args(), broken) == 0


def test_a_run_sends_the_signed_document_and_logs_only_a_count(monkeypatch, capsys):
    sent = []
    monkeypatch.setattr(publish, "send", lambda body, url, secret, bypass, **k: sent.append((body, url)) or (True, "HTTP 200"))
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    assert live._publish(args(), Account([option()], live.BrokerFault("http-503"))) == 0
    doc = json.loads(sent[0][0])
    assert live.validate(doc) == [] and doc["market"] is None and doc["problems"] == ["clock-unavailable:http-503"]
    assert json.loads((live.OUT / "outbox" / "document.json").read_text()) == doc
    out = capsys.readouterr().out
    assert "1 option positions" in out and "SPY" not in out and "market_value" not in out


def test_a_dry_run_and_a_host_with_no_ingest_settings_send_nothing(monkeypatch):
    monkeypatch.setattr(publish, "send", lambda *a, **k: pytest.fail("sent"))
    assert live._publish(argparse.Namespace(dry_run=True, verify=False), Account([option()])) == 0
    assert live._publish(args(), Account([option()])) == 0
    monkeypatch.setenv("WT_ROLE", "shadow")                  # a shadow host without its own key never sends
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://x.invalid/api/ingest")
    monkeypatch.setenv("DASHBOARD_INGEST_SECRET", "s" * 20)
    assert live._publish(args(), Account([option()])) == 2


def test_the_job_is_an_interval_job_that_never_gates_a_deploy_and_needs_no_preflight():
    j = JOBS["options-live"]
    assert j.command == ("-m", "wt.options.live") and j.mode == "backtest"
    assert not j.trading and not j.preflight and j.interval_s == 900 and j.desk == "stocks"
    assert live.PUBLISH_BUDGET_S < j.deadline_min * 60 < j.runtime_max_h * 3600
    t = units.timer(j)
    assert "OnCalendar=Mon..Fri 09..16:04/5:00 America/New_York" in t and "OnCalendar=*:04/15:00 UTC" in t
    assert "MemoryMax=512M" in units.service(j, __import__("pathlib").Path("/r")).splitlines()


def test_the_accounts_keys_are_scrubbed_and_prompted_hidden_and_optional():
    from wt.ops import safeio
    assert {live.KEY_ID_VAR, live.SECRET_VAR} <= set(safeio.SECRET_KEYS)
    text = (live.ROOT / "deploy/oci/bin/wt-set-secrets").read_text()
    assert f'"{live.KEY_ID_VAR}||1|0"' in text and f'"{live.SECRET_VAR}||1|0"' in text
