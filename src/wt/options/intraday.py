"""Where each probation rule stands during a session, from market data that runs a quarter of an hour behind.
Pure: no network, no clock (callers pass the time).

The after-close run scores the rules on the broker's official hourly bars once the session is over. This module
answers the same question while the session is still open, from another feed's half-hour bars, with the same
code (`wt.options.rules.probation_triggers`). The two feeds' bars can differ by cents, and so can the levels built
from them, so what this says is provisional: the after-close record is the one that counts.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Mapping, Sequence
from typing import Any
from zoneinfo import ZoneInfo

from wt.options import levels as lv
from wt.options import rules

NEW_YORK = ZoneInfo("America/New_York")
OPEN = dt.time(9, 30)
CLOSE = dt.time(16, 0)
EARLY_CLOSE = dt.time(13, 0)
# What `probation_triggers` calls a result, as a state for a rule that has triggered.
STATE = {"stop": "stopped", "target": "target", "close": "closed"}


def slots(session: str) -> list[tuple[dt.datetime, dt.datetime]]:
    """The session's hourly bars as the broker cuts them: 09:30 to 10:00, then each clock hour to the close
    (13:00 on a half day). Start and end as aware New York times."""
    day = dt.date.fromisoformat(session)
    end = dt.datetime.combine(day, EARLY_CLOSE if session in lv.HALF_DAYS else CLOSE, NEW_YORK)
    at = dt.datetime.combine(day, OPEN, NEW_YORK)
    out = []
    while at < end:
        nxt = min(at.replace(minute=0) + dt.timedelta(hours=1), end)
        out.append((at, nxt))
        at = nxt
    return out


def _when(t: Any) -> dt.datetime | None:
    try:
        at = dt.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo is not None else None


def hourly_bars(parts: Sequence[Mapping[str, Any]], session: str, cutoff: dt.datetime) -> list[lv.Bar]:
    """The session's finished hourly bars, built from shorter bars (`t` the bar's start, `o` `h` `l` `c`). An hour
    counts once `cutoff` has reached its end; one with no trades in it is left out, as a feed leaves it out."""
    out = []
    for start, end in slots(session):
        if cutoff < end:
            break
        inside = sorted(((at, p) for p in parts if isinstance(p, Mapping) and (at := _when(p.get("t"))) is not None
                         and start <= at < end), key=lambda x: x[0])        # on the time alone: two bars may share one
        try:
            o, c = float(inside[0][1]["o"]), float(inside[-1][1]["c"])
            h, low = max(float(p["h"]) for _, p in inside), min(float(p["l"]) for _, p in inside)
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if min(o, h, low, c) > 0:
            out.append(lv.Bar(start.strftime("%Y-%m-%dT%H:%M"), o, max(h, o, c), min(low, o, c), c))
    return out


def daily_raw(bars: Sequence[Mapping[str, Any]]) -> dict[str, list[Any]]:
    """A feed's daily bars in the shape `levels.load_ibkr` checks: the date comes from the bar's own time."""
    raw: dict[str, list[Any]] = {"time": [], "open": [], "high": [], "low": [], "close": [], "volume": []}
    for b in bars:
        at = _when(b.get("t"))
        if at is None:
            continue
        raw["time"].append(at.astimezone(NEW_YORK).date().isoformat())
        for key, k in (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c")):
            raw[key].append(b.get(k))
        raw["volume"].append(b.get("v") or 0)
    return raw


def rule_states(hourly: Sequence[lv.Bar], levels: lv.LevelSet, complete: bool) -> list[dict[str, Any]]:
    """One row a rule, in the engine's order: `waiting` until it triggers, then `open`, `stopped`, `target`, or
    `closed` once the session is over. A triggered rule carries the New York time of the hourly close it
    triggered on and its result in R so far.

    The replay never enters on a session's last bar, because nothing is left to hold. Mid-session the latest
    finished hour is not the last, so a bar that repeats its close is added after it: the replay can then see a
    trigger on it, and nothing in that added bar can move a stop, a target or a result."""
    bars = list(hourly)
    if bars and not complete:
        last = bars[-1]
        bars.append(lv.Bar(last.d + "+", last.c, last.c, last.c, last.c))
    found = {t["rule"]: t for t in rules.probation_triggers(bars, levels)} if bars else {}
    ends = {b.d: (dt.datetime.fromisoformat(b.d).replace(minute=0) + dt.timedelta(hours=1)).strftime("%H:%M")
            for b in hourly}
    out: list[dict[str, Any]] = []
    for rule in rules.RULES:
        t = found.get(rule)
        if t is None:
            out.append({"rule": rule, "state": "waiting"})
            continue
        state = STATE[t["exit"]] if complete or t["exit"] != "close" else "open"
        out.append({"rule": rule, "state": state, "bar": ends.get(t["trigger_bar"]), "side": t["side"], "r": t["r"]})
    return out
