"""The Trades page's journal (stocksdelta/journal) from what `pull` read (ADR 0011). Pure: no network, no clock.

Ported from the cloud sync that ran until the host took over (push_journal.py and pull_account.py, Oct 2026), so the
page reads the same before and after the move. Trades are matched first in, first out per contract. A long option
still held after its expiry counts as expired worthless; an option sold with no buy before it is listed under
"gaps". Results are before fees (the API carries none). No account number, balance detail or broker order id goes
into the journal; trade ids are hashes.
"""
from __future__ import annotations

import collections
import datetime as dt
import hashlib
from collections.abc import Iterable, Mapping, Sequence
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
SYDNEY = ZoneInfo("Australia/Sydney")
TRANSFER_MIN_AUD = 50.0          # a jump in value no trade explains, at least this big, is logged as money in or out
Key = tuple[str, str, float | None, str | None]


def _t(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def stamp(t: dt.datetime) -> str:
    return t.astimezone(ET).isoformat(timespec="seconds")


Fill = tuple[dt.datetime, str, Key, str, float, float, float]


def fills_of(groups: Iterable[Mapping[str, Any]]) -> list[Fill]:
    out: list[Fill] = []
    seen: set[Any] = set()
    for g in groups:
        for o in g.get("orders") or []:
            q = float(o.get("filled_quantity") or 0)
            if q == 0 or o["order_id"] in seen:
                continue
            seen.add(o["order_id"])
            p = float(o.get("filled_price") or 0)
            leg = (o.get("legs") or [{}])[0]
            key: Key
            if o["instrument_type"] == "OPTION":
                key = (o["symbol"], leg["option_type"].lower(), float(leg["strike_price"]), leg["option_expire_date"])
                mult = float(leg.get("option_contract_multiplier") or 100)
            else:
                key = (o["symbol"], "stock", None, None)
                mult = 1.0
            t = _t(o.get("filled_time_at") or o["place_time_at"])
            out.append((t, str(o["order_id"]), key, str(o["side"]), q, p, mult))
    out.sort()
    return out


def _tid(*parts: Any) -> str:
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:20]


def build(groups: Sequence[Mapping[str, Any]], now: dt.datetime) -> dict[str, Any]:
    fills = fills_of(groups)
    books: dict[Key, collections.deque[list[Any]]] = collections.defaultdict(collections.deque)
    trades: list[dict[str, Any]] = []
    gaps: list[dict[str, Any]] = []

    def trade(key: Key, lot: list[Any], n: float, exit_p: float, t: dt.datetime, close: str, oid: str) -> dict[str, Any]:
        long_ = lot[0] > 0
        pnl = (exit_p - lot[1]) * n * lot[4] * (1 if long_ else -1)
        trades.append({
            "id": _tid(lot[3], oid, n, len(trades)), "symbol": key[0], "kind": key[1],
            "strike": key[2], "expiry": key[3], "side": "long" if long_ else "short", "qty": round(n, 6),
            "opened_at": stamp(lot[2]), "closed_at": stamp(t), "entry": round(lot[1], 4), "exit": round(exit_p, 4),
            "multiplier": lot[4], "pnl": round(pnl, 2), "close": close})
        return trades[-1]

    for t, oid, key, side, q, p, mult in fills:
        s = 1 if side == "BUY" else -1
        rem, book = q, books[key]
        while rem > 1e-9 and book and (book[0][0] > 0) != (s > 0):
            lot = book[0]
            n = min(rem, abs(lot[0]))
            trade(key, lot, n, p, t, "order", oid)
            lot[0] -= n * (1 if lot[0] > 0 else -1)
            rem -= n
            if abs(lot[0]) < 1e-9:
                book.popleft()
        if rem > 1e-9:
            book.append([s * rem, p, t, oid, mult])

    today = now.astimezone(ET).date()
    after_close = now.astimezone(ET).time() >= dt.time(16, 15)
    open_lots = []
    for key, book in books.items():
        for lot in book:
            exp = dt.date.fromisoformat(key[3]) if key[3] else None
            if exp and (exp < today or (exp == today and after_close)):
                tr = trade(key, lot, abs(lot[0]), 0.0, dt.datetime.combine(exp, dt.time(16), ET), "expired", "exp")
                if lot[0] < 0:          # sold with no buy before it: the history is missing the open
                    gaps.append({"date": exp.isoformat(), "kind": "close-without-open", "symbol": key[0], "pnl": tr["pnl"]})
            else:
                open_lots.append({"symbol": key[0], "kind": key[1], "strike": key[2], "expiry": key[3],
                                  "side": "long" if lot[0] > 0 else "short", "qty": round(abs(lot[0]), 6),
                                  "entry": round(lot[1], 4), "opened_at": stamp(lot[2])})
    trades.sort(key=lambda r: (r["closed_at"], r["id"]))
    first = fills[0][0].astimezone(ET).date().isoformat() if fills else None
    return {
        "schema": "stocksdelta/journal", "schema_version": 1, "run_id": f"webull-{now.strftime('%Y%m%dT%H%M%SZ')}",
        "as_of": now.isoformat(timespec="seconds").replace("+00:00", "Z"), "source": "webull-au", "currency": "USD",
        "fees_included": False, "fills": len(fills), "history_from": first, "trades": trades,
        "open": open_lots[:500], "gaps": gaps[:200],
    }


def fill_hash(groups: Sequence[Mapping[str, Any]]) -> str:
    """Changes when a fill, its price or its status changes: what makes a new journal worth sending."""
    rows = sorted((str(o["order_id"]), o.get("filled_quantity"), o.get("filled_price"), o.get("status"))
                  for g in groups for o in g.get("orders") or [] if float(o.get("filled_quantity") or 0) > 0)
    return hashlib.sha256(repr(rows).encode()).hexdigest()


# ---- money in and out ------------------------------------------------------------------------------------------------

def derive(raw: Mapping[str, Any], realized_usd: float) -> dict[str, Any]:
    """A balance reading as the money block uses it. The totals are AUD and the USD rows USD: their ratio is the rate
    Webull itself used."""
    cash, mv = float(raw["cash"]), float(raw["market_value"])
    usd_cash, usd_mv, aud_cash = float(raw.get("usd_cash") or 0), float(raw.get("usd_market_value") or 0), float(raw.get("aud_cash") or 0)
    rate = (cash - aud_cash) / usd_cash if abs(usd_cash) > 1 else (mv / usd_mv if abs(usd_mv) > 1 else None)
    return {"at": raw["at"], "currency": "AUD", "value": round(cash + mv, 2), "cash": round(cash, 2),
            "positions": round(mv, 2), "unrealized": round(float(raw.get("unrealized") or 0), 2),
            "realized_usd": round(realized_usd, 2), "usd_aud": round(rate, 5) if rate else None}


def detect(prev: Mapping[str, Any], cur: Mapping[str, Any], transfers: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Money in or out between two readings: the change in value that the trades don't explain."""
    if not cur.get("usd_aud"):
        return None
    traded = (cur["realized_usd"] - prev["realized_usd"]) * cur["usd_aud"] + (cur["unrealized"] - prev["unrealized"])
    residual = round((cur["value"] - prev["value"]) - traded, 2)
    if abs(residual) < TRANSFER_MIN_AUD:
        return None
    since = (dt.date.fromisoformat(prev["at"][:10]) - dt.timedelta(days=10)).isoformat()
    if any(t.get("source") == "statement" and t["date"] >= since and abs(t["amount"] - residual) <= max(5.0, 0.02 * abs(residual))
           for t in transfers):
        return None                     # the owner's own record already has it
    day = _t(cur["at"]).astimezone(SYDNEY).date().isoformat()
    return {"date": day, "amount": residual, "kind": "deposit" if residual > 0 else "withdrawal",
            "source": "detected", "between": [prev["at"], cur["at"]]}


def money_block(seed: Mapping[str, Any] | None, snaps: Sequence[Mapping[str, Any]],
                transfers: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The journal's `money`: the seed (what the page showed when the host took over) plus the host's own readings."""
    if not snaps and not seed:
        return None
    by_day: dict[str, float] = {v["date"]: v["value"] for v in (seed or {}).get("values") or []}
    for s in snaps:
        by_day[_t(s["at"]).astimezone(SYDNEY).date().isoformat()] = s["value"]
    all_t = list((seed or {}).get("transfers") or []) + list(transfers)
    statement = sorted(t["date"] for t in all_t if t.get("source") == "statement")
    s0: Mapping[str, Any] = seed or {}
    last: Mapping[str, Any] = snaps[-1] if snaps else {
        "at": s0["as_of"], "currency": s0.get("currency", "AUD"), "value": s0["account_value"],
        "cash": s0.get("cash"), "positions": s0.get("positions"), "usd_aud": s0.get("usd_rate")}
    return {
        "currency": last.get("currency", "AUD"), "as_of": last["at"], "account_value": last["value"], "cash": last["cash"],
        "positions": last["positions"], "usd_rate": last.get("usd_aud"),
        "complete_from": statement[0] if statement else (seed or {}).get("complete_from"),
        "transfers": [{"date": t["date"], "amount": round(float(t["amount"]), 2), "source": t["source"]}
                      for t in sorted(all_t, key=lambda t: t["date"])][-2000:],
        "values": [{"date": d, "value": v} for d, v in sorted(by_day.items())][-4000:],
    }
