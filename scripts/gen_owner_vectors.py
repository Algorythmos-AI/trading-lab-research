"""Writes dashboard/test/fixtures/owner.vectors.json: small synthetic journals and the positions `wt.owner.positions`
groups them into, with each position's cost, fees, result and R (DEC-0045 sections 1 and 2).

The Python tests and the dashboard's tests both assert these vectors, so the two languages cannot group or price
the owner's trades differently unnoticed. Synthetic inputs only: no journal of the owner's is read.

    python scripts/gen_owner_vectors.py            # rewrite the vectors
    python scripts/gen_owner_vectors.py --check    # exit 1 if the committed vectors are stale (CI)

The check compares numbers, not bytes, as scripts/gen_bs_vectors.py does.
"""
from __future__ import annotations

import dataclasses
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.owner import positions  # noqa: E402

VECTORS = ROOT / "dashboard" / "test" / "fixtures" / "owner.vectors.json"

_n = 0


def piece(
    opened: str,
    closed: str,
    entry: float,
    exit_: float,
    qty: float = 1,
    *,
    symbol: str = "SPY",
    kind: str = "call",
    strike: float | None = 600,
    expiry: str | None = "2026-10-16",
    side: str = "long",
    close: str = "order",
    multiplier: float = 100,
    pnl: float | None = None,
) -> dict[str, Any]:
    global _n
    _n += 1
    sign = 1 if side == "long" else -1
    return {
        "id": f"v{_n:03d}",
        "symbol": symbol,
        "kind": kind,
        "strike": strike,
        "expiry": expiry,
        "side": side,
        "qty": qty,
        "opened_at": opened,
        "closed_at": closed,
        "entry": entry,
        "exit": exit_,
        "multiplier": multiplier,
        "pnl": round(sign * (exit_ - entry) * multiplier * qty, 2) if pnl is None else pnl,
        "close": close,
    }


def cases() -> list[dict[str, Any]]:
    global _n
    _n = 0
    d = "2026-10-14"
    out: list[dict[str, Any]] = []

    def case(name: str, trades: list[Any], **extra: Any) -> None:
        out.append({"name": name, "doc": {"trades": trades, "open": extra.get("open"), "gaps": extra.get("gaps"),
                                          "fees_included": extra.get("fees_included", False)}})

    case("a single piece", [piece(f"{d}T14:00:00.000Z", f"{d}T14:04:00.000Z", 1.0, 1.2)])
    case("a scale-out: one buy of 2, two sells, is one position", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:05:00.000Z", 1.0, 1.2),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:20:00.000Z", 1.0, 1.4),
    ])
    case("a scale-in: two buys closed by one sell, is one position", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:10:00.000Z", 1.0, 0.9),
        piece(f"{d}T14:03:00.000Z", f"{d}T14:10:00.000Z", 0.95, 0.9),
    ])
    case("a re-entry after a full exit the same day is a second position", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:05:00.000Z", 1.0, 0.8),
        piece(f"{d}T14:20:00.000Z", f"{d}T14:25:00.000Z", 0.9, 1.1),
    ])
    case("opened at the very instant of the latest close starts a new position; equal opens join", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:05:00.000Z", 1.0, 1.1),
        piece(f"{d}T14:05:00.000Z", f"{d}T14:09:00.000Z", 1.1, 1.0),
        piece(f"{d}T14:05:00.000Z", f"{d}T14:12:00.000Z", 1.1, 1.3),
    ])
    case("a joining piece extends the latest close, so a later open inside it still joins", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:05:00.000Z", 1.0, 1.1),
        piece(f"{d}T14:04:00.000Z", f"{d}T14:30:00.000Z", 1.05, 0.7),
        piece(f"{d}T14:20:00.000Z", f"{d}T14:30:00.000Z", 0.8, 0.7),
    ])
    case("a piece left to expire pays no closing fee", [
        piece(f"{d}T19:00:00.000Z", f"{d}T19:30:00.000Z", 0.5, 0.6, expiry=d),
        piece(f"{d}T19:00:00.000Z", f"{d}T20:00:00.000Z", 0.5, 0.0, expiry=d, close="expired"),
    ])
    case("every piece expired", [piece(f"{d}T19:00:00.000Z", f"{d}T20:00:00.000Z", 0.4, 0.0, 3, expiry=d, close="expired")])
    case("a piece closed on a later New York day", [
        piece(f"{d}T19:30:00.000Z", "2026-10-15T14:00:00.000Z", 2.0, 1.5, expiry="2026-10-17"),
    ])
    case("shares and short pieces are not positions", [
        piece(f"{d}T14:00:00.000Z", f"{d}T15:00:00.000Z", 210.0, 212.0, 10, symbol="AAPL", kind="stock", strike=None,
              expiry=None, multiplier=1),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:30:00.000Z", 1.5, 1.0, side="short"),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:30:00.000Z", 1.5, 1.0, kind="put", strike=590),
    ])
    case("cost zero, a gap piece and a lot still open are flagged and left out", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:02:00.000Z", 0.0, 0.81, symbol="QQQ", strike=500, pnl=81),
        piece("2026-07-15T14:00:00.000Z", "2026-07-15T14:02:00.000Z", 1.0, 1.2, expiry="2026-07-17"),
        piece(f"{d}T15:00:00.000Z", f"{d}T15:10:00.000Z", 1.0, 1.1, 1, symbol="IWM", strike=220),
        piece(f"{d}T15:00:00.000Z", f"{d}T15:10:00.000Z", 1.0, 1.1, 1, symbol="IWM", strike=221),
    ], gaps=[{"date": "2026-07-15", "kind": "close-without-open", "symbol": "SPY", "pnl": 81}],
       open=[
           {"symbol": "IWM", "kind": "call", "strike": 220, "expiry": "2026-10-16", "side": "long", "qty": 2,
            "entry": 1.0, "opened_at": f"{d}T15:00:00.000Z"},
           {"symbol": "IWM", "kind": "call", "strike": 221, "expiry": "2026-10-16", "side": "long", "qty": 1,
            "entry": 1.0, "opened_at": "2026-10-13T15:00:00.000Z"},
       ])
    case("a held lot with no open time flags every position of its contract (the cautious reading)", [
        piece(f"{d}T15:00:00.000Z", f"{d}T15:10:00.000Z", 1.0, 1.1, 1, symbol="IWM", strike=222),
        piece("2026-10-13T15:00:00.000Z", "2026-10-13T15:10:00.000Z", 1.0, 1.1, 1, symbol="IWM", strike=222),
        piece(f"{d}T15:00:00.000Z", f"{d}T15:10:00.000Z", 1.0, 1.1, 1, symbol="IWM", strike=223),
    ], open=[
        {"symbol": "IWM", "kind": "call", "strike": 222, "expiry": "2026-10-16", "side": "long", "qty": 1,
         "entry": 1.0, "opened_at": None},
        {"symbol": "IWM", "kind": "call", "strike": 223, "expiry": "2026-10-16", "side": "long", "qty": 1,
         "entry": 1.0},
    ])
    case("fees on partial closes: a buy of 5 closed in three sells", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:03:00.000Z", 0.8, 1.0, 2),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:06:00.000Z", 0.8, 0.6, 2),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:09:00.000Z", 0.8, 0.5, 1),
    ])
    case("an oversized entry closed in halves is one position of its whole cost", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:06:00.000Z", 1.5, 1.0, 2),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:08:00.000Z", 1.5, 0.9, 2),
    ])
    # 2026-03-08 the clocks went forward in New York; 2026-11-01 they went back. 04:30 UTC is 23:30 the evening
    # before in winter and 00:30 that day in summer.
    case("the New York day turns at local midnight, either side of a clock change", [
        piece("2026-03-10T03:30:00.000Z", "2026-03-10T05:00:00.000Z", 1.0, 1.1, expiry="2026-03-13"),
        piece("2026-03-10T04:30:00.000Z", "2026-03-10T05:00:00.000Z", 1.0, 1.1, expiry="2026-03-13"),
        piece("2026-03-06T04:30:00.000Z", "2026-03-06T05:30:00.000Z", 1.0, 0.9, expiry="2026-03-13"),
        piece("2026-03-06T05:10:00.000Z", "2026-03-06T05:40:00.000Z", 1.0, 0.9, expiry="2026-03-13"),
        piece("2026-11-03T04:30:00.000Z", "2026-11-03T05:30:00.000Z", 1.0, 1.2, expiry="2026-11-06"),
        piece("2026-11-03T05:10:00.000Z", "2026-11-03T05:40:00.000Z", 1.0, 1.2, expiry="2026-11-06"),
    ])
    # Times are compared in whole milliseconds, as JavaScript reads them: 14:05:00.0001 opens at the very instant
    # 14:05:00.0009 closed, so it starts a new position.
    case("offsets and odd precision are read as the instant they name, in whole milliseconds", [
        piece("2026-10-14T10:00:00-04:00", "2026-10-14T10:05:00.5-04:00", 1.0, 1.1, symbol="QQQ", strike=500),
        piece("2026-10-14T14:04:59.9999Z", "2026-10-14T14:06:00Z", 1.0, 1.2, symbol="QQQ", strike=500),
        piece("2026-10-14T14:00:00Z", "2026-10-14T14:05:00.0009Z", 1.0, 1.1),
        piece("2026-10-14T14:05:00.0001Z", "2026-10-14T14:07:00Z", 1.0, 1.2),
    ])
    case("a journal that already carries fees takes none off", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:04:00.000Z", 1.0, 0.7, 2),
    ], fees_included=True)
    # Two pieces opened at the same instant are ordered by id; the lower id here opens and closes at once, so the
    # other opens at the group's latest close and starts a position of its own.
    case("a tie on opened_at is ordered by id, so a zero-length lower id stands alone", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:00:00.000Z", 1.0, 1.0),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:05:00.000Z", 1.0, 1.2),
    ])
    case("a time without a zone is not read: the piece is skipped and a held lot so stamped flags its contract", [
        piece("2026-10-14T10:00:00", "2026-10-14T10:05:00", 1.0, 1.1),
        piece(f"{d}T15:00:00.000Z", f"{d}T15:10:00.000Z", 1.0, 1.1, symbol="IWM", strike=230),
        piece(f"{d}T15:20:00.000Z", f"{d}T15:30:00.000Z", 1.0, 1.1, symbol="DIA", strike=420),
    ], open=[{"symbol": "IWM", "kind": "call", "strike": 230, "expiry": "2026-10-16", "side": "long", "qty": 1,
              "entry": 1.0, "opened_at": "2026-10-14T11:00:00"}])
    case("zones written +0000 or +00, and basic-format times, are not read in either language", [
        piece("2026-10-14T14:00:00+0000", "2026-10-14T14:05:00+0000", 1.0, 1.1),
        piece("2026-10-14T14:00:00+00", "2026-10-14T14:05:00+00", 1.0, 1.1),
        piece("20261014T140000Z", "20261014T140500Z", 1.0, 1.1),
        piece(f"{d}T14:00:00.000Z", f"{d}T14:05:00.000Z", 1.0, 1.1, symbol="DIA", strike=420),
    ])
    case("a long piece of a kind that is not an option or a share is left out, not filed as short", [
        piece(f"{d}T14:00:00.000Z", f"{d}T14:05:00.000Z", 1.0, 1.1, kind="future"),
    ])
    case("malformed entries are skipped", [None, {"id": "x"}, piece(f"{d}T14:00:00.000Z", f"{d}T14:01:00.000Z", 1.0, 1.0)])
    return out


def _position(p: positions.Position) -> dict[str, Any]:
    row = dataclasses.asdict(p)
    row["piece_ids"] = list(p.piece_ids)
    return row


def build() -> dict[str, Any]:
    rows = []
    for c in cases():
        book = positions.owner_positions(c["doc"])
        rows.append({
            **c,
            "expect": {
                "positions": [_position(p) for p in book.positions],
                "excluded": {"stock": book.excluded_stock, "short": book.excluded_short, "other": book.excluded_other},
                "left_out": book.left_out,
                "fees_included": book.fees_included,
            },
        })
    return {
        "schema": "wt/owner-vectors",
        "version": 1,
        "note": "Written by scripts/gen_owner_vectors.py from wt.owner.positions. Do not edit by hand.",
        "fees": {
            "open_per_contract": positions.OPEN_FEE_PER_CONTRACT,
            "close_per_contract": positions.CLOSE_FEE_PER_CONTRACT,
            "expired_close": positions.EXPIRED_CLOSE_FEE,
        },
        "cases": rows,
    }


def render() -> str:
    return json.dumps(build(), indent=1) + "\n"


def same(a: Any, b: Any) -> bool:
    """True when two vector files say the same thing: the same shape, the same words, numbers within a part in a
    billion (or a million-millionth, for the ones near zero)."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, bool) or isinstance(b, bool) or a is None or b is None or isinstance(a, str) or isinstance(b, str):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)
    return False


def current() -> bool:
    """True when the committed vectors are what this code would write."""
    return VECTORS.exists() and same(json.loads(VECTORS.read_text()), json.loads(render()))


def main(argv: list[str]) -> int:
    if "--check" in argv:
        if not current():
            print(f"{VECTORS.relative_to(ROOT)} is stale: run python scripts/gen_owner_vectors.py", file=sys.stderr)
            return 1
        return 0
    VECTORS.write_text(render())
    print(f"wrote {VECTORS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
