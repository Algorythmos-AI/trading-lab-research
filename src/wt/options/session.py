"""The options clone's preparation for a session (DEC-0030). Pure: no network, no clock (callers pass the time).

Which names to watch, which levels to mark and which are strong, the session's clock, how far the day can still be
expected to move, and whether an event closes entries now.
"""
from __future__ import annotations

import datetime as dt
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast
from zoneinfo import ZoneInfo

from wt.options import levels as lv
from wt.options.setups import Mark

NEW_YORK = ZoneInfo("America/New_York")
SESSION_MINUTES = 390
HALF_DAY_MINUTES = 210


def names(focus: Mapping[str, Any] | None, edition_session: str | None, session: str,
          fallback: Sequence[str], max_names: int) -> tuple[list[str], str]:
    """The day's names and where they came from. The focus block's names, by rank, when the edition it came in is
    for `session`; otherwise the fallback (a focus picked for another day is not today's focus)."""
    items = (focus or {}).get("items") if isinstance(focus, Mapping) else None
    if edition_session == session and isinstance(items, list) and items:
        ranked = sorted((i for i in items if isinstance(i, Mapping) and isinstance(i.get("symbol"), str)),
                        key=lambda i: int(i.get("rank") or 99))
        picked = list(dict.fromkeys(str(i["symbol"]).upper() for i in ranked))[:max_names]
        if picked:
            return picked, "focus"
    return list(fallback)[:max_names], "fallback"


def marks(levels: lv.LevelSet, wanted: Sequence[str], strong_names: Sequence[str],
          premarket: tuple[float, float] | None) -> list[Mark]:
    """The marked levels: the wanted named levels, plus the pre-market high and low. A level is strong when its name
    is one of `strong_names` or it belongs to a big zone of `merge_zones`."""
    big = {name for z in levels["zones"] if z["big"] for name in z["members"]}
    out = [Mark(x.name, x.price, x.name in strong_names or x.name in big)
           for x in levels["levels"] if x.name in wanted]
    if premarket is not None:
        hi, lo = premarket
        out += [Mark("PMKH", hi, False), Mark("PMKL", lo, False)]
    return sorted(out, key=lambda m: m.price)


def levelset_from_edition(ticker: Mapping[str, Any]) -> lv.LevelSet | None:
    """One options-edition ticker's levels and zones in the shape `marks` reads (DEC-0033), or None if unreadable."""
    try:
        levels = [lv.Level(str(x["name"]), float(x["price"]), str(x.get("tf", "")), int(x.get("weight", 1)),
                           float(x["lo"]) if x.get("lo") is not None else None,
                           float(x["hi"]) if x.get("hi") is not None else None)
                  for x in ticker.get("levels") or [] if isinstance(x, Mapping)]
        zones = [z for z in ticker.get("zones") or [] if isinstance(z, Mapping)]
    except (KeyError, TypeError, ValueError):
        return None
    if not levels or not all(math.isfinite(x.price) and x.price > 0 for x in levels):
        return None
    return cast(lv.LevelSet, {"levels": levels, "zones": zones})     # `marks` reads only these two keys


def premarket_range(rows: Sequence[Mapping[str, Any]], session: dt.date) -> tuple[float, float] | None:
    """The pre-market high and low (04:00 to 09:30 New York) from 1-minute rows, or None without any."""
    start = dt.datetime.combine(session, dt.time(4, 0), NEW_YORK)
    end = dt.datetime.combine(session, dt.time(9, 30), NEW_YORK)
    hs, ls = [], []
    for r in rows:
        try:
            at = dt.datetime.fromisoformat(str(r.get("t")).replace("Z", "+00:00")).astimezone(NEW_YORK)
            h, low = float(r["h"]), float(r["l"])
        except (TypeError, ValueError, KeyError, AttributeError):
            continue
        if start <= at < end and math.isfinite(h) and math.isfinite(low) and h > 0 and low > 0:
            hs.append(h)
            ls.append(low)
    return (max(hs), min(ls)) if hs else None


@dataclass(frozen=True)
class Clock:
    """The session's times as aware New York datetimes."""
    open: dt.datetime
    first_entry: dt.datetime
    last_entry: dt.datetime
    flatten: dt.datetime
    verify_flat: dt.datetime
    critical: dt.datetime
    close: dt.datetime
    half_day: bool


def clock(session: str, cfg: Mapping[str, Any]) -> Clock:
    """The times of config/options_clone.yaml `day` for `session`, with the half-day set on a half day."""
    day = dt.date.fromisoformat(session)
    half = session in lv.HALF_DAYS
    times = {**cfg, **cfg["half_day"]} if half else dict(cfg)

    def at(hhmm: str) -> dt.datetime:
        h, m = (int(x) for x in str(hhmm).split(":"))
        return dt.datetime.combine(day, dt.time(h, m), NEW_YORK)

    return Clock(at("09:30"), at(times["first_entry"]), at(times["last_entry"]), at(times["flatten"]),
                 at(times["verify_flat"]), at(times["critical"]), at("13:00" if half else "16:00"), half)


def remaining_move(spot: float, annual_iv: float | None, now: dt.datetime, ck: Clock) -> float | None:
    """One standard deviation of the move still possible today: the day's expected move scaled by the square root
    of the share of the session left. None without a usable volatility."""
    if annual_iv is None or not (math.isfinite(annual_iv) and annual_iv > 0) or spot <= 0:
        return None
    total = HALF_DAY_MINUTES if ck.half_day else SESSION_MINUTES
    left = max((ck.close - now).total_seconds() / 60, 0.0)
    return lv.expected_move(spot, annual_iv, 1) * math.sqrt(min(left, total) / total)


def event_block(now: dt.datetime, root: str, macro: Sequence[Mapping[str, Any]],
                earnings: Sequence[Mapping[str, Any]], cfg: Mapping[str, Any],
                index_names: Sequence[str]) -> str | None:
    """Why an entry in `root` is closed now by a scheduled event, or None.

    Macro rows (`date`, `time_et`, `type`, `policy`): `skip` closes the day, `blackout_window` closes from
    `macro_before_min` before to `macro_after_min` after; an FOMC decision also closes `fomc_blackout` and, for a
    single name, everything after `fomc_single_names_until`. Earnings rows (`symbol`, `date`, `when`): a single name
    reporting today (any time) or after yesterday's close is closed for the day."""
    today = now.date()
    for e in macro:
        if str(e.get("date")) != today.isoformat():
            continue
        kind, pol = str(e.get("type", "")), str(e.get("policy", ""))
        if pol == "skip":
            return f"macro-skip:{kind}"
        try:
            h, m = (int(x) for x in str(e.get("time_et", "")).split(":"))
        except ValueError:
            continue
        t = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if pol == "blackout_window" and (t - dt.timedelta(minutes=int(cfg["macro_before_min"])) <= now
                                         <= t + dt.timedelta(minutes=int(cfg["macro_after_min"]))):
            return f"macro-blackout:{kind}"
        if kind == "fomc_decision":
            a, b = (now.replace(hour=int(x[:2]), minute=int(x[3:]), second=0, microsecond=0)
                    for x in cfg["fomc_blackout"])
            if a <= now <= b:
                return "fomc-blackout"
            until = str(cfg["fomc_single_names_until"])
            if root not in index_names and now >= now.replace(hour=int(until[:2]), minute=int(until[3:]),
                                                              second=0, microsecond=0):
                return "fomc-single-name"
    if root not in index_names:
        prev = dt.date.fromisoformat(lv.prev_session(today.isoformat()))
        for r in earnings:
            if str(r.get("symbol", "")).upper() != root:
                continue
            d, when = str(r.get("date")), str(r.get("when", ""))
            if d == today.isoformat() or (d == prev.isoformat() and when == "amc"):
                return "earnings"
    return None
