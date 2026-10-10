"""wt.options.bs and wt.options.longopt: the pricing the Options desk shows.

The committed vectors are what the dashboard's TypeScript is held to, so the first test here keeps them current;
the rest check the arithmetic against things that must be true whatever the inputs.
"""
from __future__ import annotations

import importlib.util
import math
import random
from pathlib import Path

import pytest

from wt.options import bs, longopt

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("gen_bs_vectors", ROOT / "scripts" / "gen_bs_vectors.py")
assert spec and spec.loader
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

KINDS: tuple[bs.Kind, ...] = ("call", "put")


def test_committed_vectors_are_current():
    assert gen.VECTORS.read_text() == gen.render(), "run python scripts/gen_bs_vectors.py"


def _cases(n: int, seed: int, *, tame: bool = False):
    """Seeded inputs. `tame` keeps them where a finite difference is a fair judge of a derivative."""
    rng = random.Random(seed)
    for _ in range(n):
        s = rng.uniform(5, 900)
        k = s * math.exp(rng.uniform(-0.08, 0.08) if tame else rng.uniform(-0.4, 0.4))
        if tame:
            minutes = rng.uniform(2 * 1440, 60 * 1440)
        else:
            minutes = rng.choice([0, 1, 30, 390, 1440, 14400, 200000]) * rng.uniform(0.5, 1.5)
        sigma = rng.uniform(0.15, 0.8) if tame else rng.uniform(0.02, 3.0)
        yield s, k, minutes, sigma, rng.choice([0.0, 0.04]), rng.choice([0.0, 0.013])


def test_put_call_parity():
    for s, k, m, sig, r, q in _cases(500, 1):
        t = bs.years(m)
        gap = bs.price(s, k, m, sig, "call", r, q) - bs.price(s, k, m, sig, "put", r, q)
        assert gap == pytest.approx(s * math.exp(-q * t) - k * math.exp(-r * t), abs=1e-9 * s)


def test_value_stays_between_its_floor_and_its_ceiling_and_rises_with_volatility():
    for s, k, m, sig, r, q in _cases(500, 2):
        t = bs.years(m)
        for kind in KINDS:
            value = bs.price(s, k, m, sig, kind, r, q)
            ceiling = s * math.exp(-q * t) if kind == "call" else k * math.exp(-r * t)
            assert bs.floor_value(s, k, m, kind, r, q) - 1e-9 * s <= value <= ceiling + 1e-9 * s
            assert bs.price(s, k, m, sig * 1.1, kind, r, q) >= value - 1e-9 * s


def test_greeks_match_finite_differences():
    for s, k, m, sig, r, q in _cases(200, 3, tame=True):
        for kind in KINDS:
            g = bs.greeks(s, k, m, sig, kind, r, q)
            assert g is not None
            # A small step for the slope, where the step's own error grows with its square; a larger one for the
            # curvature, where a small step would divide rounding noise by its square.
            h = 1e-5 * s
            slope = (bs.price(s + h, k, m, sig, kind, r, q) - bs.price(s - h, k, m, sig, kind, r, q)) / (2 * h)
            assert g.delta == pytest.approx(slope, abs=1e-6)
            h = 1e-4 * s
            up, mid, down = (bs.price(x, k, m, sig, kind, r, q) for x in (s + h, s, s - h))
            # Judged against the gamma of an at-the-money option on the same inputs: far from the money gamma
            # is tiny, and an error relative to it would be all rounding.
            at_the_money = 0.4 / (s * sig * math.sqrt(bs.years(m)))
            assert g.gamma == pytest.approx((up - 2 * mid + down) / (h * h), abs=1e-4 * at_the_money)
            dv = 1e-5
            vega = (bs.price(s, k, m, sig + dv, kind, r, q) - bs.price(s, k, m, sig - dv, kind, r, q)) / (2 * dv)
            assert g.vega_pt == pytest.approx(vega / 100, rel=1e-6, abs=1e-12 * s)
            # A minute later the option has a minute less to live: the value then, less the value a minute earlier,
            # scaled to a day.
            theta = (bs.price(s, k, m - 1, sig, kind, r, q) - bs.price(s, k, m + 1, sig, kind, r, q)) / 2 * 1440
            assert g.theta_day == pytest.approx(theta, rel=1e-4, abs=1e-9 * s)


def test_a_call_gains_and_a_put_loses_as_the_stock_rises():
    for s, k, m, sig, r, q in _cases(300, 4):
        call, put = bs.greeks(s, k, m, sig, "call", r, q), bs.greeks(s, k, m, sig, "put", r, q)
        assert call is not None and put is not None
        assert 0 <= call.delta <= 1 and -1 <= put.delta <= 0
        assert call.gamma >= 0 and call.vega_pt >= 0
        assert call.gamma == pytest.approx(put.gamma, rel=1e-9, abs=1e-12)
        assert call.vega_pt == pytest.approx(put.vega_pt, rel=1e-9, abs=1e-12)


def test_implied_volatility_gives_back_the_volatility_that_made_the_price():
    solved = 0
    for s, k, m, sig, r, q in _cases(600, 5):
        for kind in KINDS:
            value = bs.price(s, k, m, sig, kind, r, q)
            g = bs.greeks(s, k, m, sig, kind, r, q)
            assert g is not None
            iv = bs.implied_vol(value, s, k, m, kind, r, q)
            if g.vega_pt >= 1e-6 * s and bs.VOL_LO * 2 < sig < bs.VOL_HI / 2:
                assert iv == pytest.approx(sig, abs=1e-7)
                solved += 1
            elif iv is not None:
                # Where volatility hardly moves the price the answer is loose, but it must still reprice.
                assert bs.price(s, k, m, iv, kind, r, q) == pytest.approx(value, abs=1e-8 * s)
    assert solved > 300


@pytest.mark.parametrize("value", [0.0, -1.0, math.nan, math.inf])
def test_implied_volatility_is_none_for_a_price_that_is_not_one(value):
    assert bs.implied_vol(value, 100, 100, 2880, "call") is None


def test_implied_volatility_is_none_for_a_price_no_volatility_explains():
    # Under what the option is worth exercised now: a stale or crossed quote.
    assert bs.implied_vol(4.0, 100, 90, 2880, "call") is None
    assert bs.implied_vol(3.5, 100, 108, 2880, "put") is None
    # Exactly the floor, and a hair above it: rounding would decide the answer.
    assert bs.implied_vol(10.0, 100, 90, 2880, "call") is None
    assert bs.implied_vol(10.0 + 1e-8, 100, 90, 2880, "call") is None
    # More than the stock itself for a call, more than the strike for a put.
    assert bs.implied_vol(101.0, 100, 100, 2880, "call") is None
    assert bs.implied_vol(120.0, 100, 110, 2880, "put") is None


def test_time_to_expiry_is_floored_at_one_minute():
    assert bs.years(0) == bs.years(1) == bs.years(-30) == 1 / bs.MINUTES_PER_YEAR
    for kind in KINDS:
        at_bell = bs.price(100, 100, 0, 0.2, kind)
        assert at_bell == bs.price(100, 100, 1, 0.2, kind) == bs.price(100, 100, -30, 0.2, kind)
        assert 0 < at_bell < 0.05
        g = bs.greeks(100, 100, 0, 0.2, kind)
        assert g is not None and all(math.isfinite(x) for x in (g.delta, g.gamma, g.theta_day, g.vega_pt))


@pytest.mark.parametrize("sigma", [None, 0.0, -0.2, math.nan, math.inf])
def test_no_usable_volatility_gives_the_floor_and_blank_greeks(sigma):
    assert bs.price(50, 45, 30240, sigma, "call") == 5.0
    assert bs.price(50, 45, 30240, sigma, "put") == 0.0
    assert bs.price(50, 55, 30240, sigma, "put") == 5.0
    assert bs.greeks(50, 45, 30240, sigma, "call") is None


@pytest.mark.parametrize(("s", "k"), [(0, 100), (100, 0), (-5, 100), (100, -5), (math.nan, 100), (100, math.inf)])
def test_a_stock_price_or_strike_that_is_not_positive_is_refused(s, k):
    calls = (
        lambda: bs.price(s, k, 60, 0.2, "call"),
        lambda: bs.greeks(s, k, 60, 0.2, "put"),
        lambda: bs.floor_value(s, k, 60, "call"),
        lambda: bs.implied_vol(1.0, s, k, 60, "call"),
    )
    for call in calls:
        with pytest.raises(ValueError):
            call()


def test_breakeven_is_the_strike_plus_or_minus_what_was_paid():
    assert longopt.breakeven(780, 4.25, "call") == 784.25
    assert longopt.breakeven(780, 4.25, "put") == 775.75
    # At expiry, at breakeven, the option is worth what was paid (time floored at one minute, hence the tolerance).
    assert bs.price(784.25, 780, 0, 0.12, "call") == pytest.approx(4.25, abs=1e-3)
    assert bs.price(775.75, 780, 0, 0.12, "put") == pytest.approx(4.25, abs=1e-3)


def test_breakeven_distance_counts_in_the_direction_the_option_needs():
    assert longopt.breakeven_moves(780, 4.0, "call", 778, 6.0) == pytest.approx(1.0)
    assert longopt.breakeven_moves(780, 4.0, "put", 778, 6.0) == pytest.approx(1 / 3)
    # Already past breakeven: negative.
    assert longopt.breakeven_moves(780, 4.0, "call", 790, 6.0) == pytest.approx(-1.0)
    assert longopt.breakeven_moves(780, 4.0, "put", 770, 6.0) == pytest.approx(-1.0)
    for move in (None, 0.0, -1.0, math.nan):
        assert longopt.breakeven_moves(780, 4.0, "call", 778, move) is None


def test_the_most_a_long_option_loses_is_what_was_paid():
    assert longopt.max_loss(4.25) == 425.0
    assert longopt.max_loss(4.25, 3) == 1275.0
    assert longopt.pnl(0.0, 4.25, 3) == -longopt.max_loss(4.25, 3)
    assert longopt.pnl(6.25, 4.25) == pytest.approx(200.0)


def test_waiting_costs_and_an_expired_option_has_nothing_left_to_lose():
    for kind in KINDS:
        hour = longopt.decay(780, 780, 390, 0.12, kind)
        assert 0 < hour < bs.price(780, 780, 390, 0.12, kind)
        # Asking further ahead than the option has to live stops at expiry.
        assert longopt.decay(780, 780, 30, 0.12, kind, 60) == longopt.decay(780, 780, 30, 0.12, kind, 30)
    assert longopt.decay(780, 780, 0, 0.12, "call") == 0.0


def test_value_at_another_price_later_matches_pricing_it_there_and_then():
    assert longopt.value_if(785, 780, 390, 0.12, "call", 60) == bs.price(785, 780, 330, 0.12, "call")
    assert longopt.value_if(785, 780, 390, 0.12, "call") == bs.price(785, 780, 390, 0.12, "call")
    # Past expiry it is what the option is worth exercised, to within the one-minute floor.
    assert longopt.value_if(785, 780, 390, 0.12, "call", 10_000) == pytest.approx(5.0, abs=1e-3)
    assert longopt.value_if(785, 780, 390, 0.12, "put", 10_000) == pytest.approx(0.0, abs=1e-3)
