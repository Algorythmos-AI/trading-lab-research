"""The numbers a holder of one long call or put asks for: where it breaks even, what it would be worth if the stock
were somewhere else later, what an hour of waiting costs, and the most it can lose.

Built on `wt.options.bs`, so the same caveat holds: these are estimates from a flat-volatility model. Money amounts
are for whole contracts of 100 shares; `dashboard/src/lib/longopt.ts` is the same arithmetic in TypeScript.
"""
from __future__ import annotations

from wt.options import bs
from wt.options.bs import Kind

#: Shares in one standard contract. Adjusted contracts of another size are left out before they get here.
MULTIPLIER = 100


def breakeven(strike: float, premium: float, kind: Kind) -> float:
    """The stock price at expiry at which the option is worth exactly what was paid for it."""
    return strike + premium if kind == "call" else strike - premium


def breakeven_moves(
    strike: float, premium: float, kind: Kind, spot: float, expected_move: float | None
) -> float | None:
    """How far the stock is from breakeven, in expected moves, counted in the direction the option needs.

    Positive means the stock still has that far to go; negative means it is already past breakeven. None without a
    usable expected move.
    """
    if expected_move is None or not expected_move > 0:
        return None
    gap = breakeven(strike, premium, kind) - spot
    return (gap if kind == "call" else -gap) / expected_move


def max_loss(premium: float, contracts: int = 1) -> float:
    """The most a long option can lose: what was paid for it."""
    return premium * MULTIPLIER * contracts


def pnl(value: float, premium: float, contracts: int = 1) -> float:
    """Profit or loss if the option is worth `value` per share, against the premium paid."""
    return (value - premium) * MULTIPLIER * contracts


def decay(
    s: float, strike: float, minutes: float, sigma: float | None, kind: Kind,
    ahead: float = 60.0, r: float = 0.0, q: float = 0.0,
) -> float:
    """What the option loses per share over the next `ahead` minutes if the stock and its volatility stay put."""
    later = max(minutes - ahead, 0.0)
    return bs.price(s, strike, minutes, sigma, kind, r, q) - bs.price(s, strike, later, sigma, kind, r, q)


def value_if(
    s_then: float, strike: float, minutes: float, sigma: float | None, kind: Kind,
    ahead: float = 0.0, r: float = 0.0, q: float = 0.0,
) -> float:
    """The option's value per share if the stock is at `s_then` in `ahead` minutes, volatility unchanged."""
    return bs.price(s_then, strike, max(minutes - ahead, 0.0), sigma, kind, r, q)
