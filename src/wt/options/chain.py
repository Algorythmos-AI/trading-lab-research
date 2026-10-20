"""The options clone's contract choice (DEC-0030). Pure: no network, no clock (callers pass the time).

It reads the broker's option snapshots as they come (`latestQuote` with a timestamp, `greeks`, `impliedVolatility`,
`dailyBar`), measures how old each quote is, and picks one same-day contract or says why there is none. A modelled
price is never treated as executable: the entry limit comes from the live ask, capped.
"""
from __future__ import annotations

import datetime as dt
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

OCC = re.compile(r"(?P<root>[A-Z]{1,6})(?P<yy>\d{2})(?P<mm>\d{2})(?P<dd>\d{2})(?P<cp>[CP])(?P<k>\d{8})")


@dataclass(frozen=True)
class Contract:
    symbol: str
    root: str
    expiry: dt.date
    side: str          # call | put
    strike: float


def parse_occ(symbol: str) -> Contract | None:
    """A standard contract symbol, or None (an adjusted contract has a digit in its root and is left out)."""
    m = OCC.fullmatch(symbol)
    if m is None:
        return None
    try:
        exp = dt.date(2000 + int(m["yy"]), int(m["mm"]), int(m["dd"]))
    except ValueError:
        return None
    return Contract(symbol, m["root"], exp, "call" if m["cp"] == "C" else "put", int(m["k"]) / 1000)


@dataclass(frozen=True)
class Quote:
    contract: Contract
    bid: float | None
    ask: float | None
    quoted_at: dt.datetime | None
    delta: float | None
    iv: float | None
    volume: float
    modelled: bool = False     # delta and iv worked out here from the quote's mid (the feed sent none)

    @property
    def mid(self) -> float | None:
        return (self.bid + self.ask) / 2 if self.bid is not None and self.ask is not None else None

    def age_s(self, now: dt.datetime) -> float | None:
        return None if self.quoted_at is None else (now - self.quoted_at).total_seconds()


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _when(t: Any) -> dt.datetime | None:
    try:
        at = dt.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo is not None else None


def _obj(v: Any) -> Mapping[str, Any]:
    return v if isinstance(v, Mapping) else {}


def parse_snapshots(raw: Mapping[str, Any]) -> list[Quote]:
    """The `snapshots` object of `/v1beta1/options/snapshots`, as quotes. A row that cannot be read is left out; a
    missing bid, ask or greek stays None (a blank is honest, a made-up number is not)."""
    out: list[Quote] = []
    for sym, snap in raw.items():
        c = parse_occ(str(sym))
        if c is None or not isinstance(snap, Mapping):
            continue
        q, gk, day = (_obj(snap.get(k)) for k in ("latestQuote", "greeks", "dailyBar"))
        bid, ask = _num(q.get("bp")), _num(q.get("ap"))
        bid = bid if bid is not None and bid > 0 else None
        ask = ask if ask is not None and ask > 0 else None
        if bid is not None and ask is not None and bid > ask:      # a crossed quote is no quote
            bid = ask = None
        out.append(Quote(c, bid, ask, _when(q.get("t")), _num(gk.get("delta")), _num(snap.get("impliedVolatility")),
                         _num(day.get("v")) or 0.0))
    return out


def with_model(quotes: Sequence[Quote], spot: float, minutes_left: float) -> list[Quote]:
    """The quotes with a missing implied volatility and delta worked out from the two-sided quote's mid
    (`wt.options.bs`, no rates, no dividend). The broker's feed sends no greeks for contracts expiring the same day;
    without this no same-day contract could pass the delta floor. A quote that cannot be solved is left as it is."""
    from wt.options import bs
    out: list[Quote] = []
    for q in quotes:
        mid = q.mid
        if (q.delta is None or q.iv is None) and mid and mid > 0 and spot > 0 and minutes_left > 0:
            kind: bs.Kind = "call" if q.contract.side == "call" else "put"
            iv = q.iv if q.iv else bs.implied_vol(mid, spot, q.contract.strike, minutes_left, kind)
            g = bs.greeks(spot, q.contract.strike, minutes_left, iv, kind) if iv else None
            if iv and g is not None:
                q = Quote(q.contract, q.bid, q.ask, q.quoted_at, q.delta if q.delta is not None else g.delta, iv,
                          q.volume, True)
        out.append(q)
    return out


def entry_limit(ask: float, buffer_pct: float, cap: float) -> float:
    """The entry limit: the live ask plus `buffer_pct`, to the cent, never above `cap`."""
    return round(min(ask * (1 + buffer_pct / 100), cap), 2)


@dataclass(frozen=True)
class Choice:
    quote: Quote | None
    reasons: dict[str, int]      # why each refused contract was refused, counted


def pick(quotes: Sequence[Quote], root: str, side: str, session: dt.date, spot: float, now: dt.datetime,
         cfg: Mapping[str, Any], open_interest: Mapping[str, float], held: set[str], late: bool) -> Choice:
    """The same-day contract to buy, or None with the reasons counted.

    Among `root`'s `side` contracts expiring on `session`, with a fresh two-sided quote: delta at least the floor,
    ask at most `max_ask`, spread within both caps, volume and open interest at their floors, not a contract the
    account holds. Of those that pass, the one whose strike is nearest the stock."""
    floor = float(cfg["min_delta_late" if late else "min_delta"])
    min_vol = float(cfg["min_volume_index"] if root in cfg.get("index_names", ()) else cfg["min_volume"])
    stale_s = float(cfg.get("quote_stale_flat_s", 60))
    reasons: dict[str, int] = {}
    ok: list[Quote] = []

    def no(why: str) -> None:
        reasons[why] = reasons.get(why, 0) + 1

    for q in quotes:
        c = q.contract
        if c.root != root or c.side != side or c.expiry != session:
            continue
        age = q.age_s(now)
        if q.bid is None or q.ask is None:
            no("no-two-sided-quote")
        elif age is None or age > stale_s:
            no("stale-quote")
        elif q.delta is None:
            no("no-delta")
        elif abs(q.delta) < floor:
            no("delta-below-floor")
        elif q.ask > float(cfg["max_ask"]):
            no("premium-over-cap")
        elif (q.ask - q.bid) > float(cfg["max_spread"]) or (q.mid and (q.ask - q.bid) / q.mid * 100
                                                               > float(cfg["max_spread_pct_of_mid"])):
            no("spread-too-wide")
        elif q.volume < min_vol:
            no("volume-below-floor")
        elif open_interest.get(c.symbol, 0.0) < float(cfg["min_open_interest"]):
            no("open-interest-below-floor")
        elif c.symbol in held:
            no("already-held")
        else:
            ok.append(q)
    if not ok:
        return Choice(None, reasons or {"no-same-day-contract": 1})
    return Choice(min(ok, key=lambda q: (abs(q.contract.strike - spot), q.contract.strike)), reasons)
