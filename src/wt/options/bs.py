"""Black-Scholes for one long option: its value, its sensitivities, and the volatility a price implies.

The Options desk uses this to answer "what would this call or put be worth if the stock were there, then".
It is the textbook European formula with a flat rate and a flat dividend yield. US stock options are American,
so a put, and a call just before a dividend, are worth slightly more than this says; every number built on it is
shown as an estimate. `dashboard/src/lib/bs.ts` is the same arithmetic in TypeScript, and both are held to one set
of vectors (`scripts/gen_bs_vectors.py`).

Standard library only: `math.erfc` gives the normal distribution to full double precision, tails included.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

Kind = Literal["call", "put"]

MINUTES_PER_YEAR = 365 * 24 * 60
#: Time to expiry is never taken as less than one minute: at zero the formulas divide by zero.
MIN_MINUTES = 1.0
#: The range searched for an implied volatility: 0.01% to 1000% a year.
VOL_LO, VOL_HI = 1e-4, 10.0
#: A price this close to a bound of the search, as a fraction of the stock price, carries no information about
#: volatility: the answer would be decided by rounding. A billionth of the stock price is far below a cent.
VOL_EDGE = 1e-9
#: Halvings of that range. Sixty is past what a double can resolve, and a fixed count keeps Python and TypeScript
#: on exactly the same path.
BISECTIONS = 60


@dataclass(frozen=True)
class Greeks:
    """How the value moves: per $1 of stock, per $1 of stock again, per calendar day, per volatility point."""

    delta: float
    gamma: float
    theta_day: float
    vega_pt: float


def years(minutes: float) -> float:
    """Minutes to expiry as a fraction of a 365-day year, floored at one minute."""
    return max(minutes, MIN_MINUTES) / MINUTES_PER_YEAR


def _cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _check(s: float, k: float) -> None:
    if not (math.isfinite(s) and math.isfinite(k) and s > 0 and k > 0):
        raise ValueError("stock price and strike must be positive numbers")


def floor_value(s: float, k: float, minutes: float, kind: Kind, r: float = 0.0, q: float = 0.0) -> float:
    """The value with no volatility at all: how far in the money the forward is, never below zero."""
    _check(s, k)
    t = years(minutes)
    forward = s * math.exp(-q * t) - k * math.exp(-r * t)
    return max(forward if kind == "call" else -forward, 0.0)


def _d1d2(s: float, k: float, t: float, sigma: float, r: float, q: float) -> tuple[float, float]:
    spread = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / spread
    return d1, d1 - spread


def price(
    s: float, k: float, minutes: float, sigma: float | None, kind: Kind, r: float = 0.0, q: float = 0.0
) -> float:
    """The option's value per share. With no usable volatility it falls back to `floor_value`."""
    _check(s, k)
    if sigma is None or not (math.isfinite(sigma) and sigma > 0):
        return floor_value(s, k, minutes, kind, r, q)
    t = years(minutes)
    d1, d2 = _d1d2(s, k, t, sigma, r, q)
    stock, strike = s * math.exp(-q * t), k * math.exp(-r * t)
    if kind == "call":
        return stock * _cdf(d1) - strike * _cdf(d2)
    return strike * _cdf(-d2) - stock * _cdf(-d1)


def greeks(
    s: float, k: float, minutes: float, sigma: float | None, kind: Kind, r: float = 0.0, q: float = 0.0
) -> Greeks | None:
    """The sensitivities, or None with no usable volatility: a blank is honest, a made-up delta is not."""
    _check(s, k)
    if sigma is None or not (math.isfinite(sigma) and sigma > 0):
        return None
    t = years(minutes)
    d1, d2 = _d1d2(s, k, t, sigma, r, q)
    root = math.sqrt(t)
    stock, strike = s * math.exp(-q * t), k * math.exp(-r * t)
    decay = -stock * _pdf(d1) * sigma / (2.0 * root)
    if kind == "call":
        delta = math.exp(-q * t) * _cdf(d1)
        theta = decay - r * strike * _cdf(d2) + q * stock * _cdf(d1)
    else:
        delta = -math.exp(-q * t) * _cdf(-d1)
        theta = decay + r * strike * _cdf(-d2) - q * stock * _cdf(-d1)
    return Greeks(
        delta=delta,
        gamma=math.exp(-q * t) * _pdf(d1) / (s * sigma * root),
        theta_day=theta / 365.0,
        vega_pt=stock * _pdf(d1) * root / 100.0,
    )


def implied_vol(
    value: float, s: float, k: float, minutes: float, kind: Kind, r: float = 0.0, q: float = 0.0
) -> float | None:
    """The volatility at which `price` gives `value`, or None when no volatility in the searched range does.

    That is the case for a price at or under the no-volatility floor (a stale or crossed quote), for one above what
    even 1000% a year would give, and for one so close to either that rounding would decide the answer.
    """
    _check(s, k)
    if not (math.isfinite(value) and value > 0):
        return None
    lo, hi = VOL_LO, VOL_HI
    edge = VOL_EDGE * s
    if value - price(s, k, minutes, lo, kind, r, q) <= edge or price(s, k, minutes, hi, kind, r, q) - value <= edge:
        return None
    for _ in range(BISECTIONS):
        mid = 0.5 * (lo + hi)
        if price(s, k, minutes, mid, kind, r, q) < value:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)
