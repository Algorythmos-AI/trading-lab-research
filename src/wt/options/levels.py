"""The Options desk's levels engine. Pure functions: no network, no clock (callers pass dates).

Bars come from IBKR get_price_history (daily, regular hours). Every level is computed from finished, official
daily bars keyed by their New York session date; nothing is typed by hand.

Moved here from the cloud project that ran it (its `olib` module) with its behaviour unchanged: the after-close
routine has built every edition with this code since 2026-10-09. The types are new; the arithmetic is not.
"""
from __future__ import annotations

import datetime as dt
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, TypedDict

# ---------------------------------------------------------------- calendar
# NYSE full-day closures. Checked against IBKR's daily bars for 2024-10-10..2026-10-09 by the tests.
HOLIDAYS = {
    # 2024
    "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04",
    "2024-09-02", "2024-11-28", "2024-12-25",
    # 2025 (9 Jan: national day of mourning for President Carter)
    "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19",
    "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
    # 2026
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03",
    "2026-09-07", "2026-11-26", "2026-12-25",
    # 2027
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05",
    "2027-09-06", "2027-11-25", "2027-12-24",
}
# 1:00 pm ET closes.
HALF_DAYS = {"2024-07-03", "2024-11-29", "2024-12-24", "2025-07-03", "2025-11-28", "2025-12-24",
             "2026-11-27", "2026-12-24", "2027-11-26"}
CALENDAR_THROUGH = "2027-12-31"


def is_session(d: str) -> bool:
    if d > CALENDAR_THROUGH:
        raise ValueError(f"exchange calendar only covers through {CALENDAR_THROUGH}; extend HOLIDAYS")
    return dt.date.fromisoformat(d).weekday() < 5 and d not in HOLIDAYS


def next_session(d: str) -> str:
    x = dt.date.fromisoformat(d)
    while True:
        x += dt.timedelta(days=1)
        if is_session(x.isoformat()):
            return x.isoformat()


def prev_session(d: str) -> str:
    x = dt.date.fromisoformat(d)
    while True:
        x -= dt.timedelta(days=1)
        if is_session(x.isoformat()):
            return x.isoformat()


def week_key(d: str) -> tuple[int, int]:
    """ISO year-week. A holiday-shortened week is still one week: its last session closes it."""
    y, w, _ = dt.date.fromisoformat(d).isocalendar()
    return (y, w)


def month_key(d: str) -> str:
    return d[:7]


def close_final_utc(d: str) -> dt.datetime:
    """When the official close for session d is safe to use: 15 minutes after the bell, in UTC."""
    close_h = 13 if d in HALF_DAYS else 16
    local = dt.datetime.fromisoformat(f"{d}T{close_h:02d}:15:00")
    return local + dt.timedelta(hours=-_ny_utc_offset_hours(dt.date.fromisoformat(d)))


def _ny_utc_offset_hours(day: dt.date) -> int:
    """-4 during US daylight time (2nd Sunday of March to 1st Sunday of November), else -5."""
    def nth_sunday(year: int, month: int, n: int) -> dt.date:
        first = dt.date(year, month, 1)
        return first + dt.timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))
    start, end = nth_sunday(day.year, 3, 2), nth_sunday(day.year, 11, 1)
    return -4 if start <= day < end else -5


# ---------------------------------------------------------------- bars
@dataclass(frozen=True)
class Bar:
    d: str
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0


@dataclass
class Load:
    bars: list[Bar]
    widened: list[str] = field(default_factory=list)   # dates whose open/close sat outside high-low
    dropped_partial: str | None = None                 # an unfinished session bar that was removed
    problems: list[str] = field(default_factory=list)  # anything that should stop a run


def load_ibkr(raw: Mapping[str, Any], *, since: str = "", now_utc: dt.datetime | None = None) -> Load:
    """Normalize one IBKR get_price_history result (daily bars).

    - Keys bars by the date in their own timestamp; ignores chart_start/chart_end (often wrong).
    - Widens a bar whose open or close sits a few cents outside its high-low (closing-auction prints).
    - Drops a bar whose session close is not final yet at now_utc (pass the current UTC time).
    - Flags duplicate dates, non-sessions, missing sessions and suspected splits as problems.
    """
    out: dict[str, Bar] = {}
    res = Load(bars=[])
    keys = ("open", "high", "low", "close")
    if any(k not in raw for k in keys) or "time" not in raw:
        res.problems.append("result has no OHLC arrays")
        return res
    n = len(raw["time"])
    if any(len(raw[k]) != n for k in keys):
        res.problems.append("OHLC arrays have different lengths")
        return res
    vol = raw.get("volume") or [0] * n
    for i, t in enumerate(raw["time"]):
        d = t[:10]
        if d < since:
            continue
        o, h, l, c = (float(raw[k][i]) for k in keys)
        if not all(math.isfinite(x) and x > 0 for x in (o, h, l, c)):
            res.problems.append(f"{d}: non-positive or missing price")
            continue
        if h < max(o, c) or l > min(o, c):
            res.widened.append(d)
            h, l = max(h, o, c), min(l, o, c)
        if d in out:
            res.problems.append(f"{d}: duplicate bar")
        if not is_session(d):
            res.problems.append(f"{d}: bar on a non-trading day")
        out[d] = Bar(d, o, h, l, c, float(vol[i] if i < len(vol) else 0))
    bars = [out[d] for d in sorted(out)]
    if now_utc is not None and bars and now_utc < close_final_utc(bars[-1].d):
        res.dropped_partial = bars[-1].d
        bars = bars[:-1]
    for a, b in zip(bars, bars[1:], strict=False):
        if next_session(a.d) != b.d:
            res.problems.append(f"missing session(s) between {a.d} and {b.d}")
        r = b.o / a.c
        for k in (2, 3, 4, 5, 10, 20):
            if abs(r * k - 1) < 0.08 or abs(r / k - 1) < 0.08:
                res.problems.append(f"{b.d}: open/prev-close ratio {r:.3f} looks like a 1:{k} or {k}:1 split")
    res.bars = bars
    return res


def atr(bars: list[Bar], n: int = 14) -> float:
    if len(bars) < n + 1:
        raise ValueError(f"need {n + 1} bars for ATR{n}")
    trs = [max(b.h - b.l, abs(b.h - a.c), abs(b.l - a.c)) for a, b in zip(bars[-n - 1:], bars[-n:], strict=False)]
    return sum(trs) / n


def close_strength(b: Bar) -> tuple[float, str]:
    """Where the close sits in the day's range (0 = low, 1 = high) and the chip label."""
    pos = (b.c - b.l) / (b.h - b.l) if b.h > b.l else 0.5
    return pos, ("STRONG" if pos >= 0.75 else "WEAK" if pos <= 0.25 else "MID")


# ---------------------------------------------------------------- levels
@dataclass
class Level:
    name: str      # e.g. PDH, PWL, 52WH, MA50, DEMAND
    price: float
    tf: str        # day | week | month | 52w | ma | sd
    weight: int
    lo: float | None = None   # zones (supply/demand) carry a band
    hi: float | None = None


WEIGHTS = {"day": 1, "week": 2, "month": 3, "52w": 3, "ma": 1, "sd": 2}


class Zone(TypedDict):
    """Levels that sit together: one band, the sum of their weights, and which side of the last close it is."""
    lo: float
    hi: float
    weight: int
    members: list[str]
    side: str      # support | resistance
    big: bool


class LevelSet(TypedDict):
    """Everything `levels_for` works out for one session."""
    session: str
    from_bar: str
    half_day: bool
    prev_week: list[str]
    prev_month: str
    last: dict[str, float]
    atr14: float
    close_strength: dict[str, Any]
    levels: list[Level]
    zones: list[Zone]


def _range(bars: list[Bar]) -> tuple[float, float]:
    return max(b.h for b in bars), min(b.l for b in bars)


def levels_for(bars: list[Bar], session: str) -> LevelSet:
    """All levels that apply to `session`, built only from bars dated before it."""
    hist = [b for b in bars if b.d < session]
    if len(hist) < 30:
        raise ValueError("need at least 30 finished sessions")
    last = hist[-1]
    if next_session(last.d) != session:
        raise ValueError(f"last finished bar is {last.d}, but {session} does not follow it: bars are stale")
    lv: list[Level] = [Level("PDH", last.h, "day", 1), Level("PDL", last.l, "day", 1), Level("PDC", last.c, "day", 1)]

    wk = week_key(session)
    weeks: dict[tuple[int, int], list[Bar]] = {}
    for b in hist:
        weeks.setdefault(week_key(b.d), []).append(b)
    done_weeks = [k for k in sorted(weeks) if k < wk]
    pw = weeks[done_weeks[-1]]
    h, l = _range(pw)
    lv += [Level("PWH", h, "week", 2), Level("PWL", l, "week", 2)]
    if wk in weeks:                                   # this week so far (Tue-Fri sessions)
        h, l = _range(weeks[wk])
        lv += [Level("WTDH", h, "week", 1), Level("WTDL", l, "week", 1)]

    mk = month_key(session)
    months: dict[str, list[Bar]] = {}
    for b in hist:
        months.setdefault(month_key(b.d), []).append(b)
    done_months = [k for k in sorted(months) if k < mk]
    pm = months[done_months[-1]]
    h, l = _range(pm)
    lv += [Level("PMH", h, "month", 3), Level("PML", l, "month", 3)]

    y = hist[-252:]
    h, l = _range(y)
    lv += [Level("52WH", h, "52w", 3), Level("52WL", l, "52w", 3)]
    for n, w in ((20, 1), (50, 2), (200, 3)):
        if len(hist) >= n:
            lv.append(Level(f"MA{n}", sum(b.c for b in hist[-n:]) / n, "ma", w))
    lv += supply_demand(hist)

    a = atr(hist)
    pos, chip = close_strength(last)
    return {
        "session": session,
        "from_bar": last.d,
        "half_day": session in HALF_DAYS,
        "prev_week": [pw[0].d, pw[-1].d],
        "prev_month": done_months[-1],
        "last": {"open": last.o, "high": last.h, "low": last.l, "close": last.c},
        "atr14": a,
        "close_strength": {"pos": round(pos, 3), "chip": chip},
        "levels": lv,
        "zones": merge_zones(lv, last.c),
    }


def supply_demand(hist: list[Bar], lookback: int = 120) -> list[Level]:
    """Demand zone = the quiet base before a strong up day; supply = before a strong down day.

    Strong day: range > 1.5x the prior ATR14 and a close in the top (demand) or bottom (supply) quarter.
    Base: up to 3 bars right before it whose range is under 0.7x ATR, else the single prior bar.
    A zone is dropped once a later session closes through it (it has been used up).
    """
    out: list[Level] = []
    start = max(16, len(hist) - lookback)
    for i in range(start, len(hist)):
        b = hist[i]
        a = atr(hist[: i])
        if b.h - b.l <= 1.5 * a:
            continue
        pos, _ = close_strength(b)
        kind = "DEMAND" if pos >= 0.75 and b.c > b.o else "SUPPLY" if pos <= 0.25 and b.c < b.o else None
        if not kind:
            continue
        base: list[Bar] = []
        for j in range(i - 1, max(i - 4, 0), -1):
            if hist[j].h - hist[j].l < 0.7 * a:
                base.append(hist[j])
            else:
                break
        base = base or [hist[i - 1]]
        hi, lo = max(x.h for x in base), min(x.l for x in base)
        later = hist[i + 1:]
        broken = any(x.c < lo for x in later) if kind == "DEMAND" else any(x.c > hi for x in later)
        if not broken:
            out.append(Level(kind, (hi + lo) / 2, "sd", 2, lo=lo, hi=hi))
    return out


def merge_zones(lv: list[Level], ref: float, pct: float = 0.005) -> list[Zone]:
    """Merge levels within `pct` of the zone's LOWEST member (no chaining), add weights.

    Weight 5+ is a big zone. Side is support below `ref` (the last close) and resistance above.
    """
    pts: list[tuple[float, float, Level]] = []
    for x in lv:
        lo, hi = (x.lo, x.hi) if x.lo is not None and x.hi is not None else (x.price, x.price)
        pts.append((lo, hi, x))
    pts.sort(key=lambda p: p[0])
    bases: list[float] = []
    zones: list[Zone] = []
    for lo, hi, x in pts:
        if zones and lo / bases[-1] - 1 <= pct:
            z = zones[-1]
            z["hi"] = max(z["hi"], hi)
            z["lo"] = min(z["lo"], lo)
            z["weight"] += x.weight
            z["members"].append(x.name)
        else:
            bases.append(lo)
            zones.append({"lo": lo, "hi": hi, "weight": x.weight, "members": [x.name], "side": "", "big": False})
    for z in zones:
        mid = (z["lo"] + z["hi"]) / 2
        z["side"] = "support" if mid < ref else "resistance"
        z["big"] = z["weight"] >= 5
    return zones


def expected_move(price: float, annual_iv: float, days: int) -> float:
    """1-sigma move over `days` sessions implied by an annualized volatility (0.25 = 25%)."""
    return price * annual_iv * math.sqrt(days / 252)


# ---------------------------------------------------------------- live state (used from phase 3)
def state(price: float, lv: LevelSet, *, session_open: float | None = None, minutes_in: int | None = None,
          test_band: float | None = None) -> str:
    """One word for where price stands against the session's levels.

    GAP ABOVE / GAP BELOW: the session opened beyond PDH/PDL (not a tradable break by itself).
    NO TRADE: inside the first 15 minutes. TESTING S/R: within `test_band` of a big zone edge.
    """
    pdh = next(x.price for x in lv["levels"] if x.name == "PDH")
    pdl = next(x.price for x in lv["levels"] if x.name == "PDL")
    if minutes_in is not None and minutes_in < 15:
        return "NO TRADE"
    if session_open is not None and session_open > pdh and price > pdh:
        return "GAP ABOVE"
    if session_open is not None and session_open < pdl and price < pdl:
        return "GAP BELOW"
    band = test_band if test_band is not None else 0.25 * lv["atr14"]
    for z in lv["zones"]:
        if z["big"] and (abs(price - z["lo"]) <= band or abs(price - z["hi"]) <= band or z["lo"] <= price <= z["hi"]):
            return "TESTING SUPPORT" if z["side"] == "support" else "TESTING RESISTANCE"
    if price > pdh:
        return "ABOVE PDH"
    if price < pdl:
        return "BELOW PDL"
    return "INSIDE"
