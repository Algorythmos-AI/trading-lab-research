"""Paper-only lock (audit M1).

Real-money trading is never enabled from this repository. Before this module, only `paper=True` in the adapter
protected that: `MODE` was checked in one place, `is_paper` was hard-coded, and `LIVE_TRADING_ENABLED` and
`APCA_API_BASE_URL` were never read. Now every real broker adapter checks all four conditions when it is
constructed, and re-checks the environment before each order:

  * MODE is "paper"
  * LIVE_TRADING_ENABLED is not true
  * the trading endpoint is exactly https://paper-api.alpaca.markets (any path), and so is APCA_API_BASE_URL when
    it is set
  * the account number is a paper account (Alpaca paper accounts start with "PA")

The first three are checked before the client sends its first request, the account number on the first answer.
The read-only AccountReader checks only the client URL and the account number: it runs under MODE=backtest in the
dashboard job.

SimBroker is exempt: it never talks to a broker.
"""
from __future__ import annotations

import os
import sys
from typing import Any
from urllib.parse import urlparse

PAPER_HOST = "paper-api.alpaca.markets"
PAPER_HOSTS = (PAPER_HOST,)
TRUE = {"1", "true", "yes", "on"}
FALSE = {"", "0", "false", "no", "off"}     # the only values that mean "not live"; anything else fails closed


class PaperOnlyError(RuntimeError):
    """Raised instead of sending anything that could reach a live account."""


def is_paper_url(url: Any) -> bool:
    """True only for https://paper-api.alpaca.markets with any path (`/v2` is fine).

    The host is compared exactly, as written: a look-alike host (`paper-api.alpaca.markets.evil.com`), a user part, a
    port, upper case, plain http, a query or a fragment all fail. A substring test let every one of those through.
    """
    u = getattr(url, "value", url)          # alpaca-py keeps the base URL as a str Enum
    if not isinstance(u, str) or u != u.strip() or any(c.isspace() or ord(c) < 32 for c in u):
        return False
    try:
        p = urlparse(u)
    except ValueError:
        return False
    return (u.startswith("https://") and p.scheme == "https" and p.netloc == PAPER_HOST and not p.params
            and not p.query and not p.fragment and "#" not in u and "?" not in u)


def client_base_url(client: Any) -> str:
    """The base URL an alpaca-py client was built with. It is set at construction, before any request."""
    b = getattr(client, "_base_url", "")
    return str(getattr(b, "value", b))


def env_violations(environ: dict[str, str] | None = None) -> list[str]:
    e = os.environ if environ is None else environ
    out = []
    if e.get("MODE", "") != "paper":
        out.append(f"MODE is {e.get('MODE', '')!r}, not 'paper'")
    if e.get("LIVE_TRADING_ENABLED", "false").strip().lower() not in FALSE:     # "y", "enabled", "TRUE!" are on too
        out.append("LIVE_TRADING_ENABLED is set to a value that is not false")
    base = e.get("APCA_API_BASE_URL", "")
    if base and not is_paper_url(base):        # unset is allowed: the host never sets it
        out.append("APCA_API_BASE_URL is not the paper endpoint")
    return out


def client_url_violations(base_url: str) -> list[str]:
    return [] if is_paper_url(base_url) else ["the trading client does not point at the paper endpoint"]


def account_violations(account_number: Any) -> list[str]:
    a = "" if account_number is None else str(account_number)
    return [] if a.startswith("PA") else ["the account is not a paper account"]


def endpoint_violations(base_url: str, environ: dict[str, str] | None = None) -> list[str]:
    """The checks that need no request: the environment and the client's URL."""
    return env_violations(environ) + client_url_violations(base_url)


def paper_violations(base_url: str, account_number: str | None, environ: dict[str, str] | None = None) -> list[str]:
    return endpoint_violations(base_url, environ) + account_violations(account_number)


def _raise_if(v: list[str]) -> None:
    if v:
        raise PaperOnlyError("; ".join(v))


def assert_paper_endpoint(base_url: str) -> str:
    """Call BEFORE the client sends anything: the environment and the client URL. Returns the host."""
    _raise_if(endpoint_violations(base_url))
    return PAPER_HOST


def assert_paper_client_url(base_url: str) -> str:
    """The client URL alone, for the read-only AccountReader, which also runs under MODE=backtest. Returns the
    host."""
    _raise_if(client_url_violations(base_url))
    return PAPER_HOST


def assert_paper_account(account_number: Any) -> str:
    """Call on the first account answer, before anything else is sent. Returns the masked account number."""
    _raise_if(account_violations(account_number))
    return mask_account(str(account_number))


def mask_account(account_number: str) -> str:
    return f"PA…{account_number[-3:]}"


def passed_line(host: str, masked_account: str) -> str:
    return f"paper check passed: {host}, {masked_account}"


def report_passed(host: str, masked_account: str) -> None:
    """One line on stderr, the job log. stdout carries the runners' journal lines. Never raises (H4)."""
    try:
        print(passed_line(host, masked_account), file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def assert_paper(base_url: str, account_number: str | None) -> None:
    _raise_if(paper_violations(base_url, account_number))


def assert_paper_env() -> None:
    _raise_if(env_violations())
