"""Sleeve S: the day's reversal universe, chosen only from what is known at the time of each scan (HYP-0070).

The registered reversal trial (HYP-0019) takes its universe from the completed daily bar of the day being traded
(`scripts/r3_intraday.py rev_superset`): the day's final low, high and volume. No live process can know those.
This module is the same idea without the look-ahead. Every five minutes the whole market's snapshot is read, and a
name joins the day's universe when, at that moment:

  * its last price is between US$15 and US$250;
  * its session low is at least 3% under its session open; and
  * its volume so far is at least the share of 500,000 that the frozen time-of-day curve
    (config/hod_volume_curve.json) gives for the last completed minute.

It is done in two steps. The snapshot picks candidates: its daily bar carries the regular session's open and low,
but its volume counts pre-market trades too (checked against the feed on 2026-11-19), so on volume it can only say
too much. Each candidate is then confirmed on its own closed regular-session minute bars, which give the open, the
low, the last close and the volume so far exactly; only a confirmed name joins.

A name that has joined stays for the day. Nothing here reads a bar that has not closed or a daily bar of another
day, and nothing here places an order.
"""
from __future__ import annotations

import datetime as dt
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from wt.core.clock import ET
from wt.core.config import CONFIG_DIR
from wt.data.alpaca import DATA

CURVE_FILE = CONFIG_DIR / "hod_volume_curve.json"
PRICE = (15.0, 250.0)
DROP_MIN = 0.03
DAY_VOLUME = 500_000
SCAN_EVERY_MIN = 5
SNAPSHOT_CHUNK = 1000           # symbols per snapshot request (2,500 answered in one on 2026-11-19)
SESSION_MIN = 390


def load_curve(path: Path = CURVE_FILE) -> np.ndarray:
    """The frozen cumulative share of a session's volume by minute (index 0 = the 09:30 bar). A file that is not
    such a curve raises: a scan on a wrong curve would admit the wrong names without any sign of it."""
    curve = np.asarray(json.loads(path.read_text())["curve"], float)
    if curve.shape != (SESSION_MIN,) or not np.all(np.isfinite(curve)) or np.any(np.diff(curve) < 0) \
            or curve[-1] != 1.0:
        raise ValueError(f"{path.name} is not a cumulative volume curve of {SESSION_MIN} minutes")
    return curve


def completed_minutes(now: dt.datetime, open_dt: dt.datetime) -> int:
    """Whole minutes of the session that have ended by `now` (0 before 09:31)."""
    return max(0, int((now - open_dt).total_seconds() // 60))


def volume_floor(curve: np.ndarray, minutes_done: int) -> float:
    """The volume a name must have traded by now: 500,000 times the curve's share at the last completed minute.
    Before the first minute has ended there is no completed minute, and nothing qualifies."""
    if minutes_done < 1:
        return float("inf")
    return DAY_VOLUME * float(curve[min(minutes_done, SESSION_MIN) - 1])


@dataclass(frozen=True)
class Snap:
    """What one name's snapshot says about today so far."""
    last: float
    open: float
    low: float
    volume: float


def parse_snapshot(snap: Any, day: dt.date) -> Snap | None:
    """Today's figures from one snapshot, or None when it does not carry them. The daily bar must be today's: before
    a name's first print the feed still shows yesterday's bar, and reading that would be yesterday's drop."""
    if not isinstance(snap, Mapping):
        return None
    bar, trade = snap.get("dailyBar"), snap.get("latestTrade")
    if not isinstance(bar, Mapping) or not isinstance(trade, Mapping):
        return None
    try:
        bar_day = pd.Timestamp(bar["t"]).tz_convert(ET).date()
        traded = pd.Timestamp(trade["t"]).tz_convert(ET).date()
        out = Snap(last=float(trade["p"]), open=float(bar["o"]), low=float(bar["l"]), volume=float(bar["v"]))
    except (KeyError, TypeError, ValueError):
        return None
    if bar_day != day or traded != day:
        return None
    if not all(np.isfinite(x) and x > 0 for x in (out.last, out.open, out.low)) or not np.isfinite(out.volume):
        return None
    return out


def from_bars(bars: pd.DataFrame | None, open_dt: dt.datetime, now: dt.datetime) -> Snap | None:
    """The session so far from 1-minute bars: only bars of the regular session whose minute has ended by `now`."""
    if bars is None or not len(bars):
        return None
    t = pd.to_datetime(bars.t, utc=True)
    b = bars[(t >= pd.Timestamp(open_dt)) & (t + pd.Timedelta(minutes=1) <= pd.Timestamp(now))]
    if not len(b):
        return None
    return Snap(last=float(b.c.iloc[-1]), open=float(b.o.iloc[0]), low=float(b.l.min()), volume=float(b.v.sum()))


def qualifies(s: Snap, floor: float) -> bool:
    return PRICE[0] <= s.last <= PRICE[1] and (s.open - s.low) / s.open >= DROP_MIN - 1e-12 and s.volume >= floor


def tradable_symbols(assets: Iterable[Mapping[str, Any]]) -> list[str]:
    """Active, tradable US stock symbols a snapshot request can carry (no class or unit suffix)."""
    out = {str(a["symbol"]) for a in assets
           if a.get("tradable") and a.get("status", "active") == "active" and str(a.get("symbol", "")).isalpha()}
    return sorted(out)


def fetch_snapshots(a: Any, symbols: list[str]) -> dict[str, Any]:
    """The consolidated-tape snapshot of every symbol, in chunks. A chunk that fails raises: half a market read as
    the whole market would be a silent hole in the universe."""
    out: dict[str, Any] = {}
    for i in range(0, len(symbols), SNAPSHOT_CHUNK):
        got = a.get(f"{DATA}/v2/stocks/snapshots", {"symbols": ",".join(symbols[i:i + SNAPSHOT_CHUNK]), "feed": "sip"})
        if not isinstance(got, Mapping):
            raise ValueError("snapshot reply is not an object")
        out.update(got)
    return out


@dataclass
class Universe:
    """The day's universe. `joined[symbol]` is the scan time at which the name qualified; it never leaves."""
    day: dt.date
    open_dt: dt.datetime
    curve: np.ndarray
    joined: dict[str, dt.datetime] = field(default_factory=dict)
    last_scan: dt.datetime | None = None
    scans: int = 0

    def due(self, now: dt.datetime) -> bool:
        """A scan is due once per five-minute mark of the session, from 09:35."""
        if now < self.open_dt + dt.timedelta(minutes=SCAN_EVERY_MIN):
            return False
        mark = completed_minutes(now, self.open_dt) // SCAN_EVERY_MIN
        return self.last_scan is None or completed_minutes(self.last_scan, self.open_dt) // SCAN_EVERY_MIN < mark

    def candidates(self, snapshots: Mapping[str, Any], now: dt.datetime) -> list[str]:
        """Step one of a scan: the names, not yet in the universe, whose snapshot passes. Marks the scan as run."""
        floor = volume_floor(self.curve, completed_minutes(now, self.open_dt))
        out = []
        for sym in sorted(snapshots):
            if sym in self.joined:
                continue
            s = parse_snapshot(snapshots[sym], self.day)
            if s is not None and qualifies(s, floor):
                out.append(sym)
        self.last_scan, self.scans = now, self.scans + 1
        return out

    def admit(self, candidates: list[str], bars: Mapping[str, pd.DataFrame], now: dt.datetime) -> list[str]:
        """Step two: confirm each candidate on its closed regular-session minute bars. Returns the names that
        joined, in symbol order. A candidate with no bars is not confirmed."""
        floor = volume_floor(self.curve, completed_minutes(now, self.open_dt))
        new = []
        for sym in sorted(candidates):
            s = from_bars(bars.get(sym), self.open_dt, now)
            if sym not in self.joined and s is not None and qualifies(s, floor):
                self.joined[sym] = now
                new.append(sym)
        return new
