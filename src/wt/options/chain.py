"""The options clone's contract choice (DEC-0030). Pure: no network, no clock (callers pass the time).

It reads the broker's option snapshots as they come (`latestQuote` with a timestamp, `greeks`, `impliedVolatility`,
`dailyBar`), measures how old each quote is, and picks one contract of the name's expiry for the day (same-day, or
the nearest listed one under DEC-0034) or says why there is none. A modelled price is never treated as executable:
the entry limit comes from the live ask, capped.
"""
from __future__ import annotations

import datetime as dt
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from wt.options.levels import HALF_DAYS
from wt.options.regime import NEW_YORK

OCC = re.compile(r"(?P<root>[A-Z]{1,6})(?P<yy>\d{2})(?P<mm>\d{2})(?P<dd>\d{2})(?P<cp>[CP])(?P<k>\d{8})")


FUTURE_QUOTE_S = 2.0      # a quote stamped more than this ahead of the host clock is refused, not counted fresh


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


def expiry_close(expiry: dt.date) -> dt.datetime:
    """When a contract expiring on `expiry` stops trading: 16:00 New York, 13:00 on a half day."""
    return dt.datetime.combine(expiry, dt.time(13 if expiry.isoformat() in HALF_DAYS else 16), NEW_YORK)


def minutes_to_expiry(expiry: dt.date, now: dt.datetime) -> float:
    """Calendar minutes from `now` to `expiry`'s close, at least one (DEC-0034: `wt.options.bs` counts a 365-day
    calendar year, so the volatility and the delta are solved on the same clock)."""
    return max((expiry_close(expiry) - now).total_seconds() / 60, 1.0)


def with_model(quotes: Sequence[Quote], spot: float, now: dt.datetime) -> list[Quote]:
    """The quotes with a missing implied volatility and delta worked out from the two-sided quote's mid
    (`wt.options.bs`, no rates, no dividend), each to its own contract's expiry close (`minutes_to_expiry`). The
    broker's feed sends no greeks for contracts expiring the same day; without this no same-day contract could pass
    the delta floor. A quote that cannot be solved is left as it is."""
    from wt.options import bs
    out: list[Quote] = []
    for q in quotes:
        mid = q.mid
        minutes_left = minutes_to_expiry(q.contract.expiry, now)
        if (q.delta is None or q.iv is None) and mid and mid > 0 and spot > 0:
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
    miss: dict[str, Any] | None = None   # when none passed: the refused contract nearest the stock, why, its numbers


def contract_detail(q: Quote) -> dict[str, Any]:
    """What the decision log keeps of a contract: its expiry, whether its greeks were modelled here, its delta."""
    return {"expiry": q.contract.expiry.isoformat(), "modelled": q.modelled,
            "delta": None if q.delta is None else round(abs(q.delta), 4)}


def pick(quotes: Sequence[Quote], root: str, side: str, expiry: dt.date, spot: float, now: dt.datetime,
         cfg: Mapping[str, Any], open_interest: Mapping[str, float], held: set[str], late: bool) -> Choice:
    """The contract to buy, or None with the reasons counted.

    Among `root`'s `side` contracts expiring on `expiry` (the name's expiry for the day), with a fresh two-sided
    quote: delta at least the floor, ask at most `max_ask`, spread within both caps, volume and open interest at
    their floors, not a contract the account holds. Of those that pass, the one whose strike is nearest the stock."""
    floor = float(cfg["min_delta_late" if late else "min_delta"])
    min_vol = float(cfg["min_volume_index"] if root in cfg.get("index_names", ()) else cfg["min_volume"])
    stale_s = float(cfg.get("quote_stale_flat_s", 60))
    reasons: dict[str, int] = {}
    ok: list[Quote] = []
    near: tuple[float, float, str, Quote] | None = None

    def no(why: str) -> None:
        nonlocal near
        reasons[why] = reasons.get(why, 0) + 1
        key = (abs(q.contract.strike - spot), q.contract.strike, why, q)
        if near is None or key[:2] < near[:2]:
            near = key

    for q in quotes:
        c = q.contract
        if c.root != root or c.side != side or c.expiry != expiry:
            continue
        age = q.age_s(now)
        if q.bid is None or q.ask is None:
            no("no-two-sided-quote")
        elif age is None or age > stale_s:
            no("stale-quote")
        elif age < -FUTURE_QUOTE_S:                  # stamped ahead of this clock: its age can't be told (Stage 2 too)
            no("future-quote")
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
        return Choice(None, reasons or {"no-contract-of-the-expiry": 1},
                      None if near is None else _miss(near[3], near[2], now, cfg, floor, min_vol, stale_s, open_interest))
    return Choice(min(ok, key=lambda q: (abs(q.contract.strike - spot), q.contract.strike)), reasons)


def _miss(q: Quote, why: str, now: dt.datetime, cfg: Mapping[str, Any], floor: float, min_vol: float,
          stale_s: float, open_interest: Mapping[str, float]) -> dict[str, Any]:
    """The refused contract nearest the stock: why, and the number against the gate that refused it."""
    out: dict[str, Any] = {"reason": why, **contract_detail(q)}
    age = q.age_s(now)
    if why == "stale-quote":
        out |= {"age_s": None if age is None else round(age, 1), "max_s": stale_s}
    elif why == "delta-below-floor":
        out |= {"floor": floor}
    elif why == "premium-over-cap":
        out |= {"ask": q.ask, "max": float(cfg["max_ask"])}
    elif why == "spread-too-wide" and q.ask is not None and q.bid is not None:
        out |= {"spread": round(q.ask - q.bid, 4), "max": float(cfg["max_spread"]),
                "spread_pct": round((q.ask - q.bid) / q.mid * 100, 2) if q.mid else None,
                "max_pct": float(cfg["max_spread_pct_of_mid"])}
    elif why == "volume-below-floor":
        out |= {"volume": q.volume, "min": min_vol}
    elif why == "open-interest-below-floor":
        out |= {"open_interest": open_interest.get(q.contract.symbol, 0.0), "min": float(cfg["min_open_interest"])}
    return out
