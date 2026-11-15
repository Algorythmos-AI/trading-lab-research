"""Read-only view of the Alpaca PAPER account for the dashboard collector.

This class has no order methods, so code that holds an AccountReader cannot place, replace or cancel anything.
`paper=True` is hard-coded, as in the paper adapter. The client URL must be exactly the paper endpoint before any
request, and the first account answer must be a paper account ("PA"), or PaperOnlyError is raised. There is no
environment check: the dashboard job reads the account under MODE=backtest.
"""
from __future__ import annotations

from typing import Any

from alpaca.trading.client import TradingClient

from wt.core.config import env
from wt.core.safety import assert_paper_account, assert_paper_client_url, client_base_url

ACCOUNT_FIELDS = ("equity", "last_equity", "cash", "buying_power", "daytrade_count", "pattern_day_trader", "status",
                  "trading_blocked")


def _plain(v: Any) -> Any:
    """alpaca-py returns decimal strings and enums; the dashboard wants numbers and plain strings."""
    if hasattr(v, "value"):
        return v.value
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return v
    return v


class AccountReader:
    def __init__(self) -> None:
        self._c = TradingClient(env("APCA_API_KEY_ID"), env("APCA_API_SECRET_KEY"), paper=True)
        assert_paper_client_url(client_base_url(self._c))      # before any request; no env check (MODE=backtest)
        self._paper_account = False

    def _account(self) -> Any:
        """The account, checked to be a paper one the first time it is read."""
        a: Any = self._c.get_account()          # alpaca-py types these as model-or-raw unions
        if not self._paper_account:
            assert_paper_account(getattr(a, "account_number", None))
            self._paper_account = True
        return a

    def positions(self) -> list[tuple[str, int]]:
        """(symbol, signed quantity): short is negative."""
        if not self._paper_account:
            self._account()
        out: list[tuple[str, int]] = []
        raw: list[Any] = list(self._c.get_all_positions())   # alpaca-py types these as model-or-raw unions
        for p in raw:
            q = int(float(_plain(p.qty)))
            if str(_plain(getattr(p, "side", ""))) == "short" and q > 0:
                q = -q
            out.append((str(p.symbol), q))
        return out

    def snapshot(self, max_positions: int = 20) -> dict[str, Any]:
        a: Any = self._account()
        clock: Any = self._c.get_clock()
        out: dict[str, Any] = {k: _plain(getattr(a, k, None)) for k in ACCOUNT_FIELDS}
        out.update(paper=True, market_is_open=bool(clock.is_open), next_open=clock.next_open.isoformat(),
                   next_close=clock.next_close.isoformat())
        positions: list[Any] = list(self._c.get_all_positions())
        out["positions"] = [{"symbol": p.symbol, "qty": _plain(p.qty), "market_value": _plain(p.market_value),
                             "unrealized_pl": _plain(p.unrealized_pl)} for p in positions][:max_positions]
        return out
