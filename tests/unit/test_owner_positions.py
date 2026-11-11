"""wt.owner.positions: the owner's journal pieces grouped into positions (DEC-0045 sections 1 and 2).

The committed vectors are what the dashboard's TypeScript is held to, so the first test here keeps them current; the
rest check the definitions directly, so a wrong rule cannot agree with itself through the vectors alone.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

from wt.owner import positions

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("gen_owner_vectors", ROOT / "scripts" / "gen_owner_vectors.py")
assert spec and spec.loader
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)


def test_committed_vectors_are_current() -> None:
    assert gen.current(), "run python scripts/gen_owner_vectors.py"


def test_the_staleness_check_sees_a_changed_number_and_a_missing_case_but_not_rounding() -> None:
    fresh = gen.build()
    nudged = gen.build()
    nudged["cases"][1]["expect"]["positions"][0]["net"] *= 1 + 1e-13
    assert gen.same(fresh, nudged)
    changed = gen.build()
    changed["cases"][1]["expect"]["positions"][0]["net"] += 0.01
    assert not gen.same(fresh, changed)
    shorter = gen.build()
    shorter["cases"].pop()
    assert not gen.same(fresh, shorter)


def test_the_vectors_cover_what_the_record_names() -> None:
    names = " | ".join(c["name"] for c in gen.cases())
    for words in ("single piece", "scale-out", "scale-in", "re-entry", "very instant", "expire", "later New York day",
                  "shares and short", "cost zero", "no open time", "without a zone", "basic-format", "tie on opened_at", "not filed as short", "partial closes", "clock change", "already carries fees"):
        assert words in names


def _p(opened: str, closed: str, entry: float, exit_: float, qty: float = 1, **kw: Any) -> dict[str, Any]:
    return gen.piece(opened, closed, entry, exit_, qty, **kw)


D = "2026-10-14"


def test_the_fees_are_the_owners_figures() -> None:
    assert positions.OPEN_FEE_PER_CONTRACT == 0.55
    assert positions.CLOSE_FEE_PER_CONTRACT == 0.56
    assert positions.EXPIRED_CLOSE_FEE == 0.0
    assert positions.R25_SHARE == 0.25
    assert positions.R50_DOLLARS == 50.0


def test_a_sell_half_is_one_position_and_a_re_entry_is_another() -> None:
    trades = [
        _p(f"{D}T14:00:00Z", f"{D}T14:05:00Z", 1.0, 1.2),
        _p(f"{D}T14:00:00Z", f"{D}T14:20:00Z", 1.0, 1.4),
        _p(f"{D}T14:20:00Z", f"{D}T14:25:00Z", 1.0, 0.9),
    ]
    book = positions.owner_positions({"trades": trades})
    assert [len(p.piece_ids) for p in book.positions] == [2, 1]
    first = book.positions[0]
    assert first.cost == pytest.approx(200)
    assert first.gross == pytest.approx(60)
    assert first.fees == pytest.approx(2 * 0.55 + 2 * 0.56)
    assert first.net == pytest.approx(60 - 2.22)
    assert first.r25 == pytest.approx((60 - 2.22) / 50)
    assert first.r50 == pytest.approx((60 - 2.22) / 50)
    assert first.r25_gross == pytest.approx(60 / 50)
    assert first.hold_minutes == pytest.approx(20)
    assert first.option_pct == pytest.approx((60 - 2.22) / 200)


def test_an_expired_piece_pays_no_closing_fee() -> None:
    book = positions.owner_positions({"trades": [
        _p(f"{D}T19:00:00Z", f"{D}T19:30:00Z", 0.5, 0.6, 2),
        _p(f"{D}T19:00:00Z", f"{D}T20:00:00Z", 0.5, 0.0, 1, close="expired"),
    ]})
    (p,) = book.positions
    assert (p.contracts_opened, p.contracts_closed, p.contracts_expired) == (3, 2, 1)
    assert p.fees == pytest.approx(3 * 0.55 + 2 * 0.56)


def test_pieces_of_other_days_contracts_or_kinds_never_join() -> None:
    book = positions.owner_positions({"trades": [
        _p(f"{D}T14:00:00Z", f"{D}T14:30:00Z", 1.0, 1.1),
        _p(f"{D}T14:01:00Z", f"{D}T14:30:00Z", 1.0, 1.1, strike=601),
        _p(f"{D}T14:01:00Z", f"{D}T14:30:00Z", 1.0, 1.1, kind="put"),
        _p(f"{D}T14:01:00Z", f"{D}T14:30:00Z", 1.0, 1.1, expiry="2026-10-17"),
        _p(f"{D}T14:01:00Z", f"{D}T14:30:00Z", 1.0, 1.1, symbol="QQQ"),
    ]})
    assert len(book.positions) == 5


def test_flags_leave_a_position_out_without_dropping_it() -> None:
    book = positions.owner_positions({
        "trades": [_p(f"{D}T14:00:00Z", f"{D}T14:02:00Z", 0.0, 0.5, pnl=50)],
        "gaps": [{"date": D, "kind": "close-without-open", "symbol": "SPY"}],
        "fees_included": None,
    })
    (p,) = book.positions
    assert p.flags.zero_cost and p.flags.gap_piece and not p.counts
    assert p.r25 is None and p.option_pct is None
    assert book.left_out == {"zero_cost": 1, "gap_piece": 1, "open_lot": 0}


def test_a_journal_with_fees_takes_none_off() -> None:
    book = positions.owner_positions({"trades": [_p(f"{D}T14:00:00Z", f"{D}T14:02:00Z", 1.0, 0.5)], "fees_included": True})
    (p,) = book.positions
    assert p.fees == 0 and p.net == p.gross and p.flags.fees_included and book.fees_included
