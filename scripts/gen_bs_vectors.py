"""Writes dashboard/test/fixtures/bs.vectors.json: option values, sensitivities, implied volatilities and
long-option numbers worked out by `wt.options.bs` and `wt.options.longopt` for a fixed, seeded set of inputs.

The Python tests and the dashboard's tests both assert these vectors, so the pricing in the two languages cannot
drift apart unnoticed. Synthetic inputs only: no market data.

    python scripts/gen_bs_vectors.py            # rewrite the vectors
    python scripts/gen_bs_vectors.py --check    # exit 1 if the committed vectors are stale (CI)
"""
from __future__ import annotations

import dataclasses
import json
import random
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.options import bs, longopt  # noqa: E402

VECTORS = ROOT / "dashboard" / "test" / "fixtures" / "bs.vectors.json"
SEED = 20261011
KINDS: tuple[bs.Kind, ...] = ("call", "put")

# Inputs the formulas are most likely to get wrong: at and past expiry, far in and out of the money, almost no
# volatility, a great deal of it, no volatility at all, and a rate and a dividend yield that are not zero.
EDGES: list[tuple[float, float, float, float | None, float, float]] = [
    # stock, strike, minutes to expiry, volatility, rate, dividend yield
    (100.0, 100.0, 0.0, 0.2, 0.0, 0.0),
    (100.0, 100.0, 0.5, 0.2, 0.0, 0.0),
    (100.0, 100.0, 1.0, 0.2, 0.0, 0.0),
    (100.0, 100.0, 390.0, 0.2, 0.0, 0.0),
    (780.43, 780.0, 45.0, 0.1192, 0.0, 0.0),
    (780.43, 785.0, 240.0, 0.1192, 0.0, 0.0),
    (780.43, 700.0, 2880.0, 0.1192, 0.0, 0.0),
    (780.43, 860.0, 2880.0, 0.1192, 0.0, 0.0),
    (229.36, 230.0, 14400.0, 0.295, 0.04, 0.0),
    (229.36, 230.0, 14400.0, 0.295, 0.04, 0.013),
    (50.0, 55.0, 30240.0, 1.8, 0.0, 0.0),
    (50.0, 55.0, 30240.0, 0.0005, 0.0, 0.0),
    (50.0, 45.0, 30240.0, None, 0.0, 0.0),
    (50.0, 55.0, 30240.0, None, 0.04, 0.0),
    (12.5, 12.5, 525600.0, 0.6, 0.04, 0.02),
]


def _price_case(
    s: float, k: float, minutes: float, sigma: float | None, kind: bs.Kind, r: float, q: float
) -> dict[str, Any]:
    g = bs.greeks(s, k, minutes, sigma, kind, r, q)
    return {
        "s": s, "k": k, "minutes": minutes, "sigma": sigma, "kind": kind, "r": r, "q": q,
        "price": bs.price(s, k, minutes, sigma, kind, r, q),
        "greeks": dataclasses.asdict(g) if g else None,
    }


def _random_inputs(rng: random.Random) -> tuple[float, float, float, float, float, float]:
    s = round(rng.uniform(8, 900), 2)
    step = 0.5 if s < 50 else 1.0 if s < 200 else 5.0
    k = max(step, round(s * (1 + rng.uniform(-0.12, 0.12)) / step) * step)
    minutes = float(rng.choice([5, 30, 120, 390, 1440, 2880, 7200, 14400, 30240]))
    sigma = round(rng.uniform(0.08, 0.9), 4)
    return s, k, minutes, sigma, rng.choice([0.0, 0.0, 0.04]), rng.choice([0.0, 0.0, 0.013])


def build() -> dict[str, Any]:
    rng = random.Random(SEED)
    prices = [_price_case(s, k, m, sig, kind, r, q) for (s, k, m, sig, r, q) in EDGES for kind in KINDS]
    for _ in range(60):
        s, k, m, sig, r, q = _random_inputs(rng)
        prices.append(_price_case(s, k, m, sig, rng.choice(KINDS), r, q))

    # Implied volatility from a price in whole cents, as a quote would give it. Cases where the price hardly moves
    # with volatility are left out: there the answer is decided by rounding, and the two languages need not agree.
    implied: list[dict[str, Any]] = []
    while len(implied) < 40:
        s, k, m, sig, r, q = _random_inputs(rng)
        kind = rng.choice(KINDS)
        value = round(bs.price(s, k, m, sig, kind, r, q), 2)
        iv = bs.implied_vol(value, s, k, m, kind, r, q)
        g = bs.greeks(s, k, m, iv, kind, r, q) if iv is not None else None
        if g is None or g.vega_pt < 1e-6 * s:
            continue
        implied.append({"value": value, "s": s, "k": k, "minutes": m, "kind": kind, "r": r, "q": q, "sigma": iv})
    # Prices no volatility explains: nothing, a quote under what the option is worth exercised, one above the stock.
    unexplained: list[tuple[float, float, float, bs.Kind]] = [
        (0.0, 100.0, 100.0, "call"),
        (4.0, 100.0, 90.0, "call"),
        (3.5, 100.0, 108.0, "put"),
        (101.0, 100.0, 100.0, "call"),
        (120.0, 100.0, 110.0, "put"),
    ]
    for value, s, k, kind in unexplained:
        iv = bs.implied_vol(value, s, k, 2880.0, kind)
        implied.append({"value": value, "s": s, "k": k, "minutes": 2880.0, "kind": kind, "r": 0.0, "q": 0.0, "sigma": iv})

    longs: list[dict[str, Any]] = []
    for i in range(30):
        s, k, m, sig, r, q = _random_inputs(rng)
        kind = rng.choice(KINDS)
        premium = max(0.01, round(bs.price(s, k, m, sig, kind, r, q), 2))
        contracts = rng.choice([1, 1, 2, 5])
        s_then = round(s * (1 + rng.uniform(-0.03, 0.03)), 2)
        ahead = float(rng.choice([0, 30, 60, 390, 100000]))
        move = None if i % 7 == 0 else round(s * sig / 16, 2)
        value = longopt.value_if(s_then, k, m, sig, kind, ahead, r, q)
        longs.append({
            "strike": k, "premium": premium, "kind": kind, "spot": s, "expected_move": move, "contracts": contracts,
            "minutes": m, "sigma": sig, "r": r, "q": q, "s_then": s_then, "ahead": ahead,
            "breakeven": longopt.breakeven(k, premium, kind),
            "breakeven_moves": longopt.breakeven_moves(k, premium, kind, s, move),
            "max_loss": longopt.max_loss(premium, contracts),
            "value_if": value,
            "pnl": longopt.pnl(value, premium, contracts),
            "decay_hour": longopt.decay(s, k, m, sig, kind, 60.0, r, q),
        })
    return {
        "schema": "wt/bs-vectors",
        "version": 1,
        "note": "Written by scripts/gen_bs_vectors.py from wt.options.bs and wt.options.longopt. Do not edit by hand.",
        "price": prices,
        "implied": implied,
        "long": longs,
    }


def render() -> str:
    return json.dumps(build(), indent=1) + "\n"


def main(argv: list[str]) -> int:
    text = render()
    if "--check" in argv:
        if not VECTORS.exists() or VECTORS.read_text() != text:
            print(f"{VECTORS.relative_to(ROOT)} is stale: run python scripts/gen_bs_vectors.py", file=sys.stderr)
            return 1
        return 0
    VECTORS.write_text(text)
    print(f"wrote {VECTORS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
