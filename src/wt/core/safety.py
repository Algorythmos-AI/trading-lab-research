"""Paper-only lock (audit M1).

Real-money trading is never enabled from this repository. Before this module, only `paper=True` in the adapter
protected that: `MODE` was checked in one place, `is_paper` was hard-coded, and `LIVE_TRADING_ENABLED` and
`APCA_API_BASE_URL` were never read. Now every real broker adapter checks all four conditions when it is
constructed, and re-checks the environment before each order:

  * MODE is "paper"
  * LIVE_TRADING_ENABLED is not true
  * the trading endpoint is the paper endpoint
  * the account number is a paper account (Alpaca paper accounts start with "PA")

SimBroker is exempt: it never talks to a broker.
"""
from __future__ import annotations

import os

PAPER_HOSTS = ("paper-api.alpaca.markets",)
TRUE = {"1", "true", "yes", "on"}


class PaperOnlyError(RuntimeError):
    """Raised instead of sending anything that could reach a live account."""


def env_violations(environ: dict[str, str] | None = None) -> list[str]:
    e = os.environ if environ is None else environ
    out = []
    if e.get("MODE", "") != "paper":
        out.append(f"MODE is {e.get('MODE', '')!r}, not 'paper'")
    if e.get("LIVE_TRADING_ENABLED", "false").strip().lower() in TRUE:
        out.append("LIVE_TRADING_ENABLED is true")
    base = e.get("APCA_API_BASE_URL", "")
    if base and not any(h in base for h in PAPER_HOSTS):
        out.append("APCA_API_BASE_URL is not the paper endpoint")
    return out


def paper_violations(base_url: str, account_number: str | None, environ: dict[str, str] | None = None) -> list[str]:
    out = env_violations(environ)
    if not any(h in base_url for h in PAPER_HOSTS):
        out.append("the trading client does not point at the paper endpoint")
    if not account_number or not str(account_number).startswith("PA"):
        out.append("the account is not a paper account")
    return out


def assert_paper(base_url: str, account_number: str | None) -> None:
    if v := paper_violations(base_url, account_number):
        raise PaperOnlyError("; ".join(v))


def assert_paper_env() -> None:
    if v := env_violations():
        raise PaperOnlyError("; ".join(v))
