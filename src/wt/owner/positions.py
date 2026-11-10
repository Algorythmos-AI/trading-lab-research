"""The owner's journal pieces grouped into positions, and each position's cost, fees, result and R.

The definitions are DEC-0045 sections 1 and 2 (EXP-0031 config.yaml `positions` and `unit`), frozen there.
`dashboard/src/lib/owner-positions.ts` is the same arithmetic in TypeScript; both are held to the vectors in
`dashboard/test/fixtures/owner.vectors.json`, written by `scripts/gen_owner_vectors.py`.

The journal's `trades` are matched pieces, first in, first out, not trades. A position is the long call or put pieces
of one contract (symbol, kind, strike, expiry) opened on one New York day: sorted by opened_at, a piece joins the
current group while it opens strictly before the group's latest close so far, so a re-entry after a full exit is a
position of its own. Stock and short pieces are not positions. Pure: no I/O.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final, TypeGuard
from zoneinfo import ZoneInfo

NY: Final = ZoneInfo("America/New_York")

#: The owner's own Webull costs per option contract, given by the owner in session on 2026-11-11 (commission $0.50
#: plus the regulatory, OCC and SEC fees, about $1.11 a round trip). DEC-0045 section 2 freezes them; a change is a
#: dated amendment to that record. An estimate: it can drift by a cent. A piece left to expire pays no closing fee.
OPEN_FEE_PER_CONTRACT: Final = 0.55
CLOSE_FEE_PER_CONTRACT: Final = 0.56
EXPIRED_CLOSE_FEE: Final = 0.0

#: R25 is a result in units of a quarter of the premium (rule 5's -25% stop), so -1 is the stop.
R25_SHARE: Final = 0.25
#: R50 is a result in units of $50 (rule 4's risk per trade).
R50_DOLLARS: Final = 50.0

_EPOCH: Final = datetime(1970, 1, 1, tzinfo=UTC)
_FRACTION = re.compile(r"\.(\d+)")
#: The journal schema's stamp: extended format, a zone of Z or +hh:mm / -hh:mm. The TypeScript twin reads exactly these.
_STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")

Piece = Mapping[str, Any]


def stamp_ms(iso: str) -> int:
    """An ISO time as whole milliseconds since the epoch, truncated as JavaScript's Date.parse does.

    Only the schema's stamp is read; anything else (a basic-format time, a zone of +0000 or +00, none) raises.
    """
    if not _STAMP.fullmatch(iso):
        raise ValueError(f"not a stamp: {iso!r}")
    text = iso.replace("Z", "+00:00")
    text = _FRACTION.sub(lambda m: "." + m.group(1)[:6].ljust(6, "0"), text, count=1)
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError(f"time without a zone: {iso!r}")
    return (dt - _EPOCH) // timedelta(milliseconds=1)


def ny_day(iso: str) -> str:
    """The New York date of an ISO time, YYYY-MM-DD."""
    return datetime.fromtimestamp(stamp_ms(iso) / 1000, tz=UTC).astimezone(NY).date().isoformat()


def _num(v: object) -> TypeGuard[float]:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _usable(t: object) -> bool:
    """A usable matched piece: a malformed entry is skipped rather than raised on."""
    if not isinstance(t, Mapping):
        return False
    if not all(isinstance(t.get(k), str) for k in ("id", "symbol", "opened_at", "closed_at")):
        return False
    if not all(_num(t.get(k)) for k in ("qty", "entry", "exit", "multiplier", "pnl")):
        return False
    try:
        stamp_ms(t["opened_at"])
        stamp_ms(t["closed_at"])
    except ValueError:
        return False
    return True


def is_position_piece(t: Piece) -> bool:
    """A long call or put piece: the pieces positions are made of."""
    return t.get("kind") in ("call", "put") and t.get("side") == "long"


def _contract(t: Piece) -> tuple[Any, Any, float | None, Any]:
    strike = t.get("strike")
    return (t.get("symbol"), t.get("kind"), float(strike) if _num(strike) else None, t.get("expiry"))


def _id_key(t: Piece) -> tuple[int, list[int]]:
    # The TypeScript compares ids by UTF-16 code units; for the ids a journal carries that is code-point order.
    return (stamp_ms(t["opened_at"]), [ord(c) for c in str(t["id"])])


def group_pieces(trades: Sequence[object]) -> list[list[Piece]]:
    """The long option pieces grouped into positions, ordered by t0 then id (DEC-0045 section 1)."""
    by_key: dict[tuple[Any, ...], list[Piece]] = {}
    for t in trades:
        if not _usable(t):
            continue
        assert isinstance(t, Mapping)
        if not is_position_piece(t):
            continue
        by_key.setdefault((*_contract(t), ny_day(t["opened_at"])), []).append(t)
    groups: list[list[Piece]] = []
    for pieces in by_key.values():
        pieces.sort(key=_id_key)
        current: list[Piece] | None = None
        latest = 0
        for t in pieces:
            if current is not None and stamp_ms(t["opened_at"]) < latest:
                current.append(t)
                latest = max(latest, stamp_ms(t["closed_at"]))
            else:
                current = [t]
                latest = stamp_ms(t["closed_at"])
                groups.append(current)
    groups.sort(key=lambda g: _id_key(g[0]))
    return groups


@dataclass(frozen=True)
class Flags:
    gap_piece: bool
    zero_cost: bool
    open_lot: bool
    fees_included: bool


@dataclass(frozen=True)
class Position:
    id: str
    symbol: str
    kind: str
    strike: float | None
    expiry: str | None
    day: str
    piece_ids: tuple[str, ...]
    t0: str
    last_close: str
    hold_minutes: float
    contracts_opened: float
    contracts_closed: float
    contracts_expired: float
    cost: float
    proceeds: float
    gross: float
    fees: float
    net: float
    option_pct: float | None
    gross_pct: float | None
    r25: float | None
    r50: float
    r25_gross: float | None
    r50_gross: float
    closed_later_day: bool
    flags: Flags
    counts: bool


def position_of(
    pieces: Sequence[Piece],
    open_lots: Sequence[object] | None = None,
    gaps: Sequence[object] | None = None,
    fees_included: bool | None = None,
) -> Position:
    """The arithmetic of one group of pieces (DEC-0045 section 2)."""
    first = pieces[0]
    day = ny_day(first["opened_at"])
    last = first
    cost = proceeds = gross = 0.0
    opened = closed = expired = 0.0
    later = False
    for p in pieces:
        if stamp_ms(p["closed_at"]) > stamp_ms(last["closed_at"]):
            last = p
        cost += p["entry"] * p["multiplier"] * p["qty"]
        proceeds += p["exit"] * p["multiplier"] * p["qty"]
        gross += p["pnl"]
        opened += p["qty"]
        if p.get("close") == "expired":
            expired += p["qty"]
        else:
            closed += p["qty"]
        if ny_day(p["closed_at"]) != day:
            later = True
    included = fees_included is True
    fees = 0.0 if included else (
        OPEN_FEE_PER_CONTRACT * opened + CLOSE_FEE_PER_CONTRACT * closed + EXPIRED_CLOSE_FEE * expired
    )
    net = gross - fees
    key = _contract(first)
    days = {ny_day(p["opened_at"]) for p in pieces} | {ny_day(p["closed_at"]) for p in pieces}
    gap_piece = any(
        isinstance(g, Mapping) and g.get("symbol") == first["symbol"] and g.get("date") in days for g in gaps or []
    )
    open_lot = False
    for lot in open_lots or []:
        if not isinstance(lot, Mapping) or _contract(lot) != key:
            continue
        # A lot with no usable open time may be this position's rest, so it is counted as one (the cautious reading).
        at = lot.get("opened_at")
        if not isinstance(at, str):
            open_lot = True
            continue
        try:
            if ny_day(at) == day:
                open_lot = True
        except ValueError:
            open_lot = True
    zero_cost = not cost > 0

    def per(v: float, d: float) -> float | None:
        return v / d if d > 0 else None

    strike = first.get("strike")
    return Position(
        id=str(first["id"]),
        symbol=str(first["symbol"]),
        kind=str(first["kind"]),
        strike=float(strike) if _num(strike) else None,
        expiry=first.get("expiry"),
        day=day,
        piece_ids=tuple(str(p["id"]) for p in pieces),
        t0=str(first["opened_at"]),
        last_close=str(last["closed_at"]),
        hold_minutes=max(0.0, (stamp_ms(last["closed_at"]) - stamp_ms(first["opened_at"])) / 60_000),
        contracts_opened=opened,
        contracts_closed=closed,
        contracts_expired=expired,
        cost=cost,
        proceeds=proceeds,
        gross=gross,
        fees=fees,
        net=net,
        option_pct=per(net, cost),
        gross_pct=per(gross, cost),
        r25=per(net, R25_SHARE * cost),
        r50=net / R50_DOLLARS,
        r25_gross=per(gross, R25_SHARE * cost),
        r50_gross=gross / R50_DOLLARS,
        closed_later_day=later,
        flags=Flags(gap_piece=gap_piece, zero_cost=zero_cost, open_lot=open_lot, fees_included=included),
        counts=not (gap_piece or zero_cost or open_lot),
    )


@dataclass(frozen=True)
class Book:
    positions: list[Position]
    excluded_stock: int
    excluded_short: int
    excluded_other: int
    fees_included: bool
    left_out: dict[str, int] = field(default_factory=dict)


def owner_positions(doc: Mapping[str, Any]) -> Book:
    """Every position in a journal document, with what was left out and why."""
    trades = doc.get("trades")
    pieces: list[object] = list(trades) if isinstance(trades, list) else []
    open_lots = doc.get("open") if isinstance(doc.get("open"), list) else None
    gaps = doc.get("gaps") if isinstance(doc.get("gaps"), list) else None
    fees_included = doc.get("fees_included")
    positions = [
        position_of(g, open_lots, gaps, fees_included if isinstance(fees_included, bool) else None)
        for g in group_pieces(pieces)
    ]
    stock = short = other = 0
    for t in pieces:
        if not _usable(t):
            continue
        assert isinstance(t, Mapping)
        if is_position_piece(t):
            continue
        if t.get("kind") == "stock":
            stock += 1
        elif t.get("side") == "short":
            short += 1
        else:
            other += 1
    return Book(
        positions=positions,
        excluded_stock=stock,
        excluded_short=short,
        excluded_other=other,
        fees_included=fees_included is True,
        left_out={
            "zero_cost": sum(p.flags.zero_cost for p in positions),
            "gap_piece": sum(p.flags.gap_piece for p in positions),
            "open_lot": sum(p.flags.open_lot for p in positions),
        },
    )
