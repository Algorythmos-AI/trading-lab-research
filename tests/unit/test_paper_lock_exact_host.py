"""Paper lock, exact host (V9 track C): the URL test, the check order in each Alpaca class, and the pass line."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from wt.brokers import alpaca_options_paper, alpaca_paper, alpaca_read
from wt.core.safety import (PaperOnlyError, env_violations, is_paper_url, mask_account, passed_line,
                            paper_violations)

PAPER = "https://paper-api.alpaca.markets"
OK_ENV = {"MODE": "paper", "LIVE_TRADING_ENABLED": "false"}


# ---- the URL test -------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("url", [PAPER, PAPER + "/", PAPER + "/v2", PAPER + "/v2/account"])
def test_the_paper_host_is_accepted_with_any_path(url):
    assert is_paper_url(url)
    assert env_violations({**OK_ENV, "APCA_API_BASE_URL": url}) == []
    assert paper_violations(url, "PA3ABCDEFG", OK_ENV) == []


@pytest.mark.parametrize("url", [
    "https://paper-api.alpaca.markets.evil.com",
    "https://paper-api.alpaca.markets.evil.com/v2",
    "https://evil.com/paper-api.alpaca.markets",
    "https://evil.com?paper-api.alpaca.markets",
    "https://paper-api.alpaca.markets@evil.com",
    "https://user@paper-api.alpaca.markets",
    "http://paper-api.alpaca.markets",
    "https://paper-api.alpaca.markets:443",
    "https://paper-api.alpaca.markets:8443/v2",
    "https://PAPER-API.ALPACA.MARKETS",
    "https://Paper-api.alpaca.markets/v2",
    "HTTPS://paper-api.alpaca.markets",
    "https://paper-api.alpaca.markets.",
    "https://paper-api.alpaca.markets?x=1",
    "https://paper-api.alpaca.markets#frag",
    " https://paper-api.alpaca.markets",
    "https://paper-api.alpaca.markets\n",
    "https://paper-api.alpaca.markets\\@evil.com",
    "https://api.alpaca.markets",
    "paper-api.alpaca.markets",
])
def test_look_alike_urls_are_refused(url):
    assert not is_paper_url(url)
    assert any("APCA_API_BASE_URL" in x for x in env_violations({**OK_ENV, "APCA_API_BASE_URL": url}))
    assert any("paper endpoint" in x for x in paper_violations(url, "PA3ABCDEFG", OK_ENV))


def test_an_empty_client_url_is_refused():
    assert not is_paper_url("")
    assert any("paper endpoint" in x for x in paper_violations("", "PA3ABCDEFG", OK_ENV))


def test_an_unset_base_url_variable_is_allowed():
    assert env_violations(OK_ENV) == []
    assert env_violations({**OK_ENV, "APCA_API_BASE_URL": ""}) == []


def test_the_pass_line_shows_the_host_and_only_the_last_three_characters():
    assert passed_line("paper-api.alpaca.markets", mask_account("PA3ABCDEFG")) == \
        "paper check passed: paper-api.alpaca.markets, PA…EFG"


# ---- a fake alpaca-py client --------------------------------------------------------------------------------------

class FakeClient:
    """Records every request. The base URL is set at construction, as alpaca-py's is."""
    base_url: Any = PAPER
    account_number: Any = "PA3ABCDEFG"
    calls: list[str] = []

    def __init__(self, *a: Any, **kw: Any) -> None:
        self._base_url = type(self).base_url
        self._retry = 3
        self._session = SimpleNamespace(request=self._request)

    def _request(self, method: str, url: str, **kw: Any) -> Any:
        FakeClient.calls.append(f"{method} {url}")

    def get_account(self) -> Any:
        FakeClient.calls.append("get_account")
        return SimpleNamespace(account_number=type(self).account_number, equity="600", last_equity="600", cash="600",
                               buying_power="600", daytrade_count=0, pattern_day_trader=False, status="ACTIVE",
                               trading_blocked=False)

    def get_clock(self) -> Any:
        FakeClient.calls.append("get_clock")
        import datetime as dt
        t = dt.datetime(2026, 11, 16, 9, 30)
        return SimpleNamespace(is_open=False, next_open=t, next_close=t)

    def get_all_positions(self) -> list[Any]:
        FakeClient.calls.append("get_all_positions")
        return [SimpleNamespace(symbol="QQQM", qty="2", side="long", market_value="500", unrealized_pl="1")]


@pytest.fixture
def fake(monkeypatch):
    class C(FakeClient):
        pass
    FakeClient.calls = []
    for mod in (alpaca_paper, alpaca_options_paper, alpaca_read):
        monkeypatch.setattr(mod, "TradingClient", C)
    for k, v in {**OK_ENV, "APCA_API_KEY_ID": "k", "APCA_API_SECRET_KEY": "s"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("APCA_API_BASE_URL", raising=False)
    return C


def stock() -> Any:
    return alpaca_paper.AlpacaPaperBroker()


def clone() -> Any:
    return alpaca_options_paper.AlpacaOptionsPaperBroker("k", "s", True)


BROKERS = [pytest.param(stock, id="stock"), pytest.param(clone, id="clone")]


# ---- the two brokers: URL and env before any request, PA on the first answer ----------------------------------------

@pytest.mark.parametrize("build", BROKERS)
def test_a_paper_setup_connects_with_one_request_and_logs_one_line(fake, build, capsys):
    build()
    assert FakeClient.calls == ["get_account"]
    err = capsys.readouterr().err.splitlines()
    assert err == ["paper check passed: paper-api.alpaca.markets, PA…EFG"]


@pytest.mark.parametrize("build", BROKERS)
@pytest.mark.parametrize("url", ["https://paper-api.alpaca.markets.evil.com", "https://api.alpaca.markets",
                                 "http://paper-api.alpaca.markets", "https://paper-api.alpaca.markets:443"])
def test_a_bad_client_url_is_refused_before_any_request(fake, build, url, capsys):
    fake.base_url = url
    with pytest.raises(PaperOnlyError, match="paper endpoint"):
        build()
    assert FakeClient.calls == []
    assert "paper check passed" not in capsys.readouterr().err


@pytest.mark.parametrize("build", BROKERS)
@pytest.mark.parametrize("name, value, why", [
    ("MODE", "backtest", "MODE"),
    ("LIVE_TRADING_ENABLED", "true", "LIVE_TRADING_ENABLED"),
    ("APCA_API_BASE_URL", "https://paper-api.alpaca.markets.evil.com", "APCA_API_BASE_URL"),
])
def test_a_bad_environment_is_refused_before_any_request(fake, build, monkeypatch, name, value, why):
    monkeypatch.setenv(name, value)
    with pytest.raises(PaperOnlyError, match=why):
        build()
    assert FakeClient.calls == []


@pytest.mark.parametrize("build", BROKERS)
def test_the_paper_base_url_variable_with_a_path_is_allowed(fake, build, monkeypatch):
    monkeypatch.setenv("APCA_API_BASE_URL", PAPER + "/v2")
    build()
    assert FakeClient.calls == ["get_account"]


@pytest.mark.parametrize("build", BROKERS)
@pytest.mark.parametrize("acct", ["3ABCDEFG", None, ""])
def test_a_live_account_is_refused_after_the_first_answer(fake, build, acct, capsys):
    fake.account_number = acct
    with pytest.raises(PaperOnlyError, match="not a paper account"):
        build()
    assert FakeClient.calls == ["get_account"]
    assert "paper check passed" not in capsys.readouterr().err


# ---- the read-only reader: client URL and PA, no environment check -------------------------------------------------

def test_the_reader_still_works_under_mode_backtest(fake, monkeypatch):
    monkeypatch.setenv("MODE", "backtest")
    snap = alpaca_read.AccountReader().snapshot()
    assert snap["paper"] is True and snap["equity"] == 600.0
    assert FakeClient.calls == ["get_account", "get_clock", "get_all_positions"]
    FakeClient.calls = []
    assert alpaca_read.AccountReader().positions() == [("QQQM", 2)]
    assert FakeClient.calls == ["get_account", "get_all_positions"]


def test_the_reader_ignores_the_environment(fake, monkeypatch):
    monkeypatch.delenv("MODE", raising=False)
    monkeypatch.setenv("LIVE_TRADING_ENABLED", "true")
    assert alpaca_read.AccountReader().positions() == [("QQQM", 2)]


@pytest.mark.parametrize("url", ["https://paper-api.alpaca.markets.evil.com", "https://api.alpaca.markets"])
def test_the_reader_refuses_a_bad_client_url_before_any_request(fake, url):
    fake.base_url = url
    with pytest.raises(PaperOnlyError, match="paper endpoint"):
        alpaca_read.AccountReader()
    assert FakeClient.calls == []


@pytest.mark.parametrize("read", ["snapshot", "positions"])
def test_the_reader_refuses_a_live_account_before_reading_more(fake, read):
    fake.account_number = "3ABCDEFG"
    with pytest.raises(PaperOnlyError, match="not a paper account"):
        getattr(alpaca_read.AccountReader(), read)()
    assert FakeClient.calls == ["get_account"]


def test_the_real_client_is_built_on_the_exact_paper_host():
    """alpaca-py's own paper client passes the exact test, with no request made."""
    from alpaca.common.enums import BaseURL
    from alpaca.trading.client import TradingClient

    from wt.core.safety import client_base_url
    assert is_paper_url(client_base_url(TradingClient("k", "s", paper=True)))
    assert not is_paper_url(BaseURL.TRADING_LIVE)
