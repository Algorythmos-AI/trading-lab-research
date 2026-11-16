"""The options clone's read of the tape (DEC-0030): 2-minute bars, VWAP, EMAs, ATR and one regime word per bar.

Pure: no network, no clock. Callers pass the session's 1-minute bars and the time; nothing here decides a trade.
"""
from __future__ import annotations

import datetime as dt
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo("America/New_York")
OPEN = dt.time(9, 30)


@dataclass(frozen=True)
class Bar:
    """One bar. `start` and `end` are aware New York times; `v` is the volume and `pv` the sum of price x volume."""
    start: dt.datetime
    end: dt.datetime
    o: float
    h: float
    l: float  # noqa: E741
    c: float
    v: float
    pv: float


def _when(t: Any) -> dt.datetime | None:
    try:
        at = dt.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None
    return at.astimezone(NEW_YORK) if at.tzinfo is not None else None


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def minute_bars(rows: Sequence[Mapping[str, Any]], session: dt.date) -> list[Bar]:
    """A feed's 1-minute bars (`t` start, `o` `h` `l` `c` `v`, optional `vw`) inside the session's regular hours,
    sorted, one per minute. A row that cannot be read, or whose prices are not positive, is left out."""
    open_at = dt.datetime.combine(session, OPEN, NEW_YORK)
    out: dict[dt.datetime, Bar] = {}
    for r in rows:
        at = _when(r.get("t")) if isinstance(r, Mapping) else None
        if at is None or at < open_at or at.date() != session:
            continue
        o, h, lo, c = (_num(r.get(k)) for k in ("o", "h", "l", "c"))
        v = _num(r.get("v")) or 0.0
        if o is None or h is None or lo is None or c is None or min(o, h, lo, c) <= 0:
            continue
        vw = _num(r.get("vw"))
        typical = vw if vw is not None and vw > 0 else (h + lo + c) / 3
        out[at] = Bar(at, at + dt.timedelta(minutes=1), o, max(h, o, c), min(lo, o, c), c, max(v, 0.0),
                      typical * max(v, 0.0))
    return [out[k] for k in sorted(out)]


def resample(minutes: Sequence[Bar], width: int, now: dt.datetime,
             grace: dt.timedelta | None = None) -> list[Bar]:
    """Clock-aligned `width`-minute bars from the open, finished by `now` (a bucket counts once `now` reaches its
    end). A bucket with no minute in it is left out, as a feed leaves it out.

    With `grace` (the live clone): a bucket whose last minute has not arrived yet counts only once `now` is `grace`
    past its end, so a minute the feed delivers late is not read as missing and its bucket is not judged on the
    first minute's close. A minute the feed never sends (IEX leaves out a minute with no trade there) still ends
    its bucket, `grace` later. Without `grace` (the dry run, whose minutes are all final): as before."""
    if not minutes:
        return []
    open_at = dt.datetime.combine(minutes[0].start.date(), OPEN, NEW_YORK)
    buckets: dict[int, list[Bar]] = {}
    for b in minutes:
        k = int((b.start - open_at).total_seconds() // 60) // width
        buckets.setdefault(k, []).append(b)
    out: list[Bar] = []
    for k in sorted(buckets):
        start = open_at + dt.timedelta(minutes=k * width)
        end = start + dt.timedelta(minutes=width)
        if now < end:
            break
        ms = buckets[k]
        if grace is not None and ms[-1].start < end - dt.timedelta(minutes=1) and now < end + grace:
            break
        out.append(Bar(start, end, ms[0].o, max(m.h for m in ms), min(m.l for m in ms), ms[-1].c,
                       sum(m.v for m in ms), sum(m.pv for m in ms)))
    return out


def vwap(bars: Sequence[Bar]) -> float | None:
    """The session's volume-weighted price so far, or None before any volume."""
    v = sum(b.v for b in bars)
    return sum(b.pv for b in bars) / v if v > 0 else None


def ema(values: Sequence[float], n: int) -> float | None:
    """Exponential average seeded with the simple mean of the first `n` values; None with fewer than `n`."""
    if len(values) < n:
        return None
    k = 2.0 / (n + 1)
    e = sum(values[:n]) / n
    for x in values[n:]:
        e = x * k + e * (1 - k)
    return e


def atr(bars: Sequence[Bar], n: int) -> float | None:
    """Mean true range of the last `n` bars (as `wt.options.levels.atr`); None with fewer than `n + 1` bars."""
    if len(bars) < n + 1:
        return None
    pairs = zip(bars[-n - 1:-1], bars[-n:], strict=True)
    return sum(max(b.h - b.l, abs(b.h - a.c), abs(b.l - a.c)) for a, b in pairs) / n


@dataclass(frozen=True)
class Tape:
    """What the clone knows about one name at a bar's close."""
    close: float
    vwap: float | None
    ema_fast: float | None
    ema_slow: float | None
    atr: float | None
    day_high: float
    day_low: float
    last_range: float
    word: str          # trend-up | trend-down | range | shock | unknown


def read(bars: Sequence[Bar], atr_n: int, fast: int, slow: int, shock_atr: float) -> Tape | None:
    """The tape at the last finished bar, or None before the first. `shock`: the last bar's range is more than
    `shock_atr` ATRs. `trend-up`: the close above VWAP and the fast EMA above the slow one; `trend-down` the mirror.
    `unknown`: not enough bars for the averages yet."""
    if not bars:
        return None
    closes = [b.c for b in bars]
    last = bars[-1]
    a = atr(bars[:-1], atr_n) if len(bars) > atr_n + 1 else None
    w, ef, es = vwap(bars), ema(closes, fast), ema(closes, slow)
    rng = last.h - last.l
    if a is not None and a > 0 and rng > shock_atr * a:
        word = "shock"
    elif w is None or ef is None or es is None or a is None:
        word = "unknown"
    elif last.c > w and ef > es:
        word = "trend-up"
    elif last.c < w and ef < es:
        word = "trend-down"
    else:
        word = "range"
    return Tape(last.c, w, ef, es, atr(bars, atr_n), max(b.h for b in bars), min(b.l for b in bars), rng, word)
