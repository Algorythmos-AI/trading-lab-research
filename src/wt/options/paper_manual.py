"""The hand-placed paper account's closed option trades, for the Paper options page (DEC-0057).

The account's own activity list is read (filled orders, and option expiries, exercises and assignments) and matched
into round trips, first in, first out, one contract at a time:

- a buy closes what was sold first, oldest first, and opens a long lot with what is left; a sell does the reverse;
- an expiry closes every open lot of its contract at zero;
- an exercise or an assignment takes its lots out of the account by that event, not by a sale: no result is booked,
  and the contract is listed in `gaps`;
- a symbol that is not a standard option contract is not an option trade and is left out.

The matching is pure (`round_trips`). The reading (`refresh`) asks the account object it is given, which can only
GET (wt.options.live.OptionsAccount), oldest first, a bounded number of pages a run, and keeps what it has read in
a cache file so the next run asks only for what is newer. Read only: nothing here can place, change or cancel an
order. No account number, balance or order id is kept in what is sent: a trade's id is a hash.

When the clone trades in this same account (it has no keys of its own), its fills are in this list too. They are
left out by contract and New York day: any fill on a contract the clone traded that day. A hand trade on the very
same contract the same day would be left out with them; the count left out is sent, so the page can say so.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
from collections import deque
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from wt.ops import safeio

NEW_YORK = ZoneInfo("America/New_York")
TYPES = ("FILL", "OPEXP", "OPASN", "OPXRC")
EXPIRY, TAKEN = "OPEXP", ("OPASN", "OPXRC")
PAGE_SIZE = 100                   # the account API's maximum without a date
MAX_PAGES = 20                    # a run reads at most this many pages; the next run carries on from the cache
FIRST_LOOKBACK_DAYS = 730         # how far back the first read starts
MAX_KEPT = 50_000                 # activities kept in the cache: far above what a paper account's hand trades reach
MAX_TRADES = 2000                 # the schema's cap: the newest are kept
MAX_GAPS = 200

_OCC = re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")
_ID = re.compile(r"^[A-Za-z0-9:_.\-]{1,120}$")


class Account(Protocol):
    def activities(self, after: str, page_token: str | None) -> list[Any]: ...


# ---------------------------------------------------------------- reading
def _when(a: Mapping[str, Any]) -> dt.datetime | None:
    """When an activity happened. A fill has its own time; an expiry, exercise or assignment has only its day, and
    is put at that day's 16:00 in New York, after every fill of the session."""
    t = a.get("transaction_time")
    if isinstance(t, str) and t:
        try:
            got = dt.datetime.fromisoformat(t.replace("Z", "+00:00"))
        except ValueError:
            return None
        return got if got.tzinfo else got.replace(tzinfo=dt.UTC)
    d = a.get("date")
    if isinstance(d, str):
        try:
            day = dt.date.fromisoformat(d[:10])
        except ValueError:
            return None
        return dt.datetime.combine(day, dt.time(16, 0), NEW_YORK)
    return None


def _qty(v: Any) -> float | None:
    try:
        x = abs(float(v))
    except (TypeError, ValueError):
        return None
    return x if 0 < x < 1_000_000 and x == x else None


def _price(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if 0 <= x <= 100_000 and x == x else None


def clean(raw: Iterable[Any]) -> list[dict[str, Any]]:
    """The activities this module reads, reduced to what it needs and nothing else (no order id, no amounts of
    cash): id, type, time, contract, side, quantity and price. Anything else, or anything malformed, is dropped."""
    out: list[dict[str, Any]] = []
    for a in raw:
        if not isinstance(a, Mapping):
            continue
        kind, ident, symbol, at = a.get("activity_type"), a.get("id"), a.get("symbol"), _when(a)
        if kind not in TYPES or not isinstance(ident, str) or not _ID.match(ident) or not isinstance(symbol, str) or at is None:
            continue
        row: dict[str, Any] = {"id": ident, "type": kind, "at": at.astimezone(dt.UTC).replace(microsecond=0).isoformat(),
                               "symbol": symbol}
        if kind == "FILL":
            side, qty, price = a.get("side"), _qty(a.get("qty")), _price(a.get("price"))
            if side not in ("buy", "sell", "sell_short") or qty is None or price is None:
                continue
            row.update({"side": "buy" if side == "buy" else "sell", "qty": qty, "price": price})
        out.append(row)
    return out


def load(cache: Path) -> dict[str, Any]:
    try:
        kept = json.loads(cache.read_text())
        if isinstance(kept, dict) and isinstance(kept.get("activities"), list) and isinstance(kept.get("after"), str):
            return kept
    except (OSError, ValueError):
        pass
    return {}


def refresh(account: Account, cache: Path, now: dt.datetime, max_pages: int = MAX_PAGES) -> list[dict[str, Any]]:
    """Every activity read so far, oldest first, after asking the account for what is newer than the cache holds.
    A fault from the account is the caller's to catch: the cache is then as it was."""
    kept = load(cache)
    known: dict[str, dict[str, Any]] = {a["id"]: a for a in kept.get("activities", [])
                                       if isinstance(a, dict) and isinstance(a.get("id"), str)}
    # A day's overlap with the last read: an expiry is dated, not timed, and may be written after later fills.
    last = max((a["at"] for a in known.values()), default=None)
    after = (dt.datetime.fromisoformat(last) - dt.timedelta(days=1) if last else now - dt.timedelta(days=FIRST_LOOKBACK_DAYS))
    start = str(kept.get("after") or after.astimezone(dt.UTC).isoformat())
    token: str | None = None
    for _ in range(max_pages):
        page = account.activities(after.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), token)
        for a in clean(page):
            known[a["id"]] = a
        ids = [a.get("id") for a in page if isinstance(a, Mapping) and isinstance(a.get("id"), str)]
        if len(page) < PAGE_SIZE or not ids or ids[-1] == token:
            break
        token = ids[-1]
    rows = sorted(known.values(), key=lambda a: (a["at"], a["type"] != "FILL", a["id"]))[-MAX_KEPT:]
    safeio.atomic_write(cache, json.dumps({"after": start, "activities": rows}, separators=(",", ":")), cache.parent)
    return rows


# ---------------------------------------------------------------- matching
def _ny_day(iso: str) -> str:
    return dt.datetime.fromisoformat(iso).astimezone(NEW_YORK).date().isoformat()


def _trade_id(*parts: str) -> str:
    return "m-" + hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def round_trips(activities: Sequence[Mapping[str, Any]], clone_days: Iterable[tuple[str, str]] = ()) -> dict[str, Any]:
    """`activities` (as `clean` gives them, any order) matched into closed trades, oldest close first.
    `clone_days`: (contract, New York day) pairs the clone traded in this same account; fills on them are left out."""
    skip = set(clone_days)
    lots: dict[str, deque[dict[str, Any]]] = {}
    trades: list[dict[str, Any]] = []
    gaps: list[dict[str, str]] = []
    excluded = other = 0
    for a in sorted(activities, key=lambda x: (str(x.get("at")), x.get("type") != "FILL", str(x.get("id")))):
        symbol, at, kind = str(a.get("symbol")), str(a.get("at")), a.get("type")
        if not _OCC.match(symbol):
            other += 1
            continue
        book = lots.setdefault(symbol, deque())
        if kind == "FILL":
            if (symbol, _ny_day(at)) in skip:
                excluded += 1
                continue
            side = "long" if a.get("side") == "buy" else "short"
            left, price = float(a["qty"]), float(a["price"])
            while left > 1e-9 and book and book[0]["side"] != side:
                lot = book[0]
                take = min(left, lot["qty"])
                sign = 1 if lot["side"] == "long" else -1
                trades.append({"id": _trade_id(lot["id"], str(a["id"]), str(len(trades))), "contract": symbol, "side": lot["side"],
                               "qty": round(take, 4), "opened_at": lot["at"], "closed_at": max(at, lot["at"]),
                               "entry": lot["price"], "exit": price,
                               "pnl_usd": round((price - lot["price"]) * 100 * take * sign, 2), "close": "order"})
                lot["qty"] -= take
                left -= take
                if lot["qty"] <= 1e-9:
                    book.popleft()
            if left > 1e-9:
                book.append({"id": str(a["id"]), "side": side, "qty": left, "price": price, "at": at})
        elif kind == EXPIRY:
            while book:
                lot = book.popleft()
                sign = 1 if lot["side"] == "long" else -1
                trades.append({"id": _trade_id(lot["id"], str(a["id"]), str(len(trades))), "contract": symbol, "side": lot["side"],
                               "qty": round(lot["qty"], 4), "opened_at": lot["at"], "closed_at": max(at, lot["at"]),
                               "entry": lot["price"], "exit": 0.0,
                               "pnl_usd": round(-lot["price"] * 100 * lot["qty"] * sign, 2), "close": "expired"})
        elif kind in TAKEN and book:
            book.clear()
            gaps.append({"date": _ny_day(at), "contract": symbol})
    trades.sort(key=lambda t: (t["closed_at"], t["id"]))
    first = min((str(a.get("at")) for a in activities if a.get("at")), default=None)
    left_out = max(0, len(trades) - MAX_TRADES)
    return {"history_from": _ny_day(first) if first else None, "truncated": left_out, "excluded_clone_fills": excluded,
            "trades": trades[left_out:], "gaps": gaps[-MAX_GAPS:], "_other": other}


def clone_days(plans: Mapping[str, Mapping[str, Any]]) -> set[tuple[str, str]]:
    """The (contract, New York day) pairs of the clone's own trades, from its plan files (trade id `<date>-O-<n>`)."""
    out: set[tuple[str, str]] = set()
    for tid, p in plans.items():
        symbol = p.get("symbol")
        if isinstance(symbol, str) and _OCC.match(symbol) and re.match(r"^\d{4}-\d{2}-\d{2}-O-\d+$", tid):
            out.add((symbol, tid[:10]))
    return out


def block(activities: Sequence[Mapping[str, Any]], shared: bool, plans: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """The document's `manual` block. `shared`: the clone trades in this account too, so its fills are left out."""
    got = round_trips(activities, clone_days(plans) if shared else ())
    got.pop("_other", None)
    return got
