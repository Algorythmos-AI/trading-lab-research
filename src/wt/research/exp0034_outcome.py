"""EXP-0034's outcome code (DEC-0051 section 8, precondition 3): bars, entry_open, the exit and R of one break.

Frozen once merged: a later change other than a defect fix recorded by a dated README note before the read is an
early end. `outcome_code_sha256()` is the SHA-256 of this file's bytes; tests/unit/test_exp0034.py pins it (with the read module, the parser and the script), so
any edit fails the suite until the pin (and the README line) is changed on purpose.

What it implements, each by reference:
- the bars: EXP-0032 config.yaml `bars` (SIP 1-minute bars by name, raw, fetched at least 30 minutes after the close,
  paged to the end, saved with SHA-256, the first complete fetch never replaced; kept from 09:30 to before the close;
  joined into 2-minute bars from 09:30; usable when the first bar starts at 09:30, the last at 15:58 (12:58 on a
  half day) and at most 5 slots have no bar);
- entry_open: the open of the first 2-minute bar that starts at or after the scoring record's evaluation time;
- the exit: EXP-0032 config.yaml `outcome.after_fill`, unchanged, with the entry_open bar as the fill bar and the
  card's frozen T1 and stop;
- R = round(sg x (exit - entry_open) / |card entry - card stop|, 2), sg +1 for a call and -1 for a put.

Pure except `fetch_session_bars` (the network, through wt.data.alpaca.AlpacaREST, feed named sip) and the file
helpers. No clock is read: the caller passes the time.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
BAR_MS = 120_000                      # bars.bar_seconds 120
MINUTE_MS = 60_000
MAX_MISSING_SLOTS = 5                 # bars.max_missing_slots
FETCH_AFTER_CLOSE_MIN = 30            # bars.fetched: at least 30 minutes after the close
FEED = "sip"                          # bars.request.feed; never ALPACA_FEED
Side = Literal["call", "put"]
ExitWhy = Literal["target1", "stopped", "same_bar_conflict", "session_close", "entry_beyond_t1",
                  "entry_beyond_stop"]


def outcome_code_sha256() -> str:
    """The SHA-256 of this module's source bytes: what "frozen" is checked against."""
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


@dataclass(frozen=True)
class Bar:
    """One bar: start in ms since the epoch (UTC), open, high, low, close, volume."""
    t: int
    o: float
    h: float
    low: float
    c: float
    v: float


@dataclass(frozen=True)
class SessionClock:
    day: str
    open_ms: int
    close_ms: int
    slots: int                         # 195, or 105 on a half day


def session_clock(day: str, half_day: bool) -> SessionClock:
    """09:30 to 16:00 New York (13:00 on a half day, as market-calendar.json half_days gives it)."""
    d = date.fromisoformat(day)
    o = datetime.combine(d, time(9, 30), NY)
    c = datetime.combine(d, time(13, 0) if half_day else time(16, 0), NY)
    open_ms, close_ms = int(o.timestamp() * 1000), int(c.timestamp() * 1000)
    return SessionClock(day, open_ms, close_ms, (close_ms - open_ms) // BAR_MS)


# ---- the fetch ------------------------------------------------------------------------------------------------------
def bars_path(root: Path, day: str) -> Path:
    return root / f"{day}.json"


def fetch_session_bars(client: Any, symbols: list[str], day: str, half_day: bool, root: Path, now_ms: int) -> Path:
    """Fetch the session's SIP 1-minute bars for all scored names together and save them once, with their SHA-256.

    `client` is a wt.data.alpaca.AlpacaREST (or a fake with the same `bars`): its `bars` pages to the end and its `get`
    refuses a request that names no feed (require_feed). Refuses before close + 30 minutes, and when a saved fetch
    already exists (the first complete fetch is used and never replaced). Returns the saved file's path."""
    clock = session_clock(day, half_day)
    if now_ms < clock.close_ms + FETCH_AFTER_CLOSE_MIN * MINUTE_MS:
        raise RuntimeError("too early: the bars are fetched at least 30 minutes after the close")
    path = bars_path(root, day)
    if path.exists():
        raise FileExistsError(f"{path} exists: the first complete fetch is never replaced")
    start = datetime.fromtimestamp(clock.open_ms / 1000, NY).isoformat()
    end = datetime.fromtimestamp(clock.close_ms / 1000, NY).isoformat()
    df = client.bars(sorted(set(symbols)), "1Min", start, end, feed=FEED, adjustment="raw")
    rows: dict[str, list[dict[str, Any]]] = {s: [] for s in sorted(set(symbols))}
    for r in df.itertuples(index=False):
        rows.setdefault(str(r.symbol), []).append(
            {"t": int(r.t.value // 1_000_000), "o": float(r.o), "h": float(r.h), "l": float(r.l), "c": float(r.c),
             "v": float(r.v)})
    for s in rows:
        rows[s].sort(key=lambda b: int(b["t"]))
    body = json.dumps({"v": 1, "day": day, "half_day": half_day, "feed": FEED, "timeframe": "1Min",
                       "adjustment": "raw", "bars": rows}, sort_keys=True, separators=(",", ":")).encode()
    root.mkdir(parents=True, exist_ok=True)
    with open(path, "xb") as fh:
        fh.write(body)
    with open(path.with_suffix(".json.sha256"), "x") as fh:
        fh.write(hashlib.sha256(body).hexdigest() + "\n")
    return path


def verify_session_bars(root: Path, day: str) -> str | None:
    """Why a saved fetch cannot be read (missing, SHA-256 mismatch, another feed or day); None when it verifies."""
    path = bars_path(root, day)
    sha = path.with_suffix(".json.sha256")
    if not path.exists() or not sha.exists():
        return "bars file missing"
    body = path.read_bytes()
    if hashlib.sha256(body).hexdigest() != sha.read_text().strip():
        return "bars SHA-256 mismatch"
    try:
        doc = json.loads(body)
    except ValueError:
        return "bars file unreadable"
    if type(doc) is not dict or doc.get("feed") != FEED or doc.get("day") != day:
        return "bars feed or day wrong"
    return None


def load_session_bars(root: Path, day: str) -> dict[str, list[Bar]] | None:
    """A saved fetch, read back only when its SHA-256 matches and it names the SIP feed; None otherwise."""
    path = bars_path(root, day)
    sha = path.with_suffix(".json.sha256")
    if not path.exists() or not sha.exists():
        return None
    body = path.read_bytes()
    if hashlib.sha256(body).hexdigest() != sha.read_text().strip():
        return None
    doc = json.loads(body)
    if doc.get("feed") != FEED or doc.get("day") != day:
        return None
    return {s: [Bar(int(b["t"]), float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]), float(b["v"]))
                for b in rows] for s, rows in doc["bars"].items()}


# ---- the join and the usable test -----------------------------------------------------------------------------------
def kept(bars1: list[Bar], clock: SessionClock) -> list[Bar]:
    """1-minute bars starting at or after 09:30 and before the close; a bar starting at the close is dropped."""
    return sorted((b for b in bars1 if clock.open_ms <= b.t < clock.close_ms), key=lambda b: b.t)


def join_2m(bars1: list[Bar], clock: SessionClock) -> list[Bar]:
    """2-minute bars from 09:30 + 2k minutes: first open, highest high, lowest low, last close, summed volume of the
    1-minute bars starting in it. A slot with no 1-minute bar has no bar."""
    slots: dict[int, list[Bar]] = {}
    for b in kept(bars1, clock):
        slots.setdefault((b.t - clock.open_ms) // BAR_MS, []).append(b)
    out = []
    for k in sorted(slots):
        g = slots[k]
        out.append(Bar(clock.open_ms + k * BAR_MS, g[0].o, max(x.h for x in g), min(x.low for x in g), g[-1].c,
                       sum(x.v for x in g)))
    return out


def usable(bars2: list[Bar], clock: SessionClock) -> bool:
    """The first 2-minute bar starts at 09:30, the last at the close - 2 minutes, at most 5 slots have no bar."""
    if not bars2:
        return False
    return (bars2[0].t == clock.open_ms and bars2[-1].t == clock.close_ms - BAR_MS
            and clock.slots - len(bars2) <= MAX_MISSING_SLOTS)


# ---- entry, exit, R -------------------------------------------------------------------------------------------------
def entry_index(bars2: list[Bar], evaluated_ms: int) -> int | None:
    """The first 2-minute bar that starts at or after the evaluation time; None is no_entry_bar."""
    for i, b in enumerate(bars2):
        if b.t >= evaluated_ms:
            return i
    return None


@dataclass(frozen=True)
class Exit:
    price: float
    why: ExitWhy
    bar: int                           # index of the exit bar in the session's 2-minute bars


def after_fill(bars2: list[Bar], fill: int, side: Side, t1: float, stop: float) -> Exit:
    """EXP-0032 outcome.after_fill: from the fill bar, target1 when the high (call) or low (put) reaches T1, exit at
    T1; stopped when a bar after the fill bar closes strictly through the stop, exit at that close; both on one bar:
    stopped at that close (same_bar_conflict, the stop assumed first); neither by the last bar: session_close at the
    last bar's close. Only bars from the fill bar on are read.

    Fixed before the code is frozen (EXP-0034 README, 2026-11-13): an entry_open already at or beyond T1 exits at
    entry_open (entry_beyond_t1); one already at or beyond the stop exits at entry_open (entry_beyond_stop)."""
    o = bars2[fill].o
    if (o >= t1) if side == "call" else (o <= t1):
        return Exit(o, "entry_beyond_t1", fill)
    if (o <= stop) if side == "call" else (o >= stop):
        return Exit(o, "entry_beyond_stop", fill)
    for i in range(fill, len(bars2)):
        b = bars2[i]
        hit = b.h >= t1 if side == "call" else b.low <= t1
        through = i > fill and (b.c < stop if side == "call" else b.c > stop)
        if through:
            return Exit(b.c, "same_bar_conflict" if hit else "stopped", i)
        if hit:
            return Exit(t1, "target1", i)
    return Exit(bars2[-1].c, "session_close", len(bars2) - 1)


def round2(x: float) -> float:
    """Two decimals, half away from zero, on the shortest decimal form of the float."""
    return float(Decimal(repr(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def r_multiple(side: Side, exit_price: float, entry_open: float, card_entry: float, card_stop: float) -> float:
    """round(sg x (exit - entry_open) / |card entry - card stop|, 2)."""
    risk = abs(card_entry - card_stop)
    if not risk > 0:
        raise ValueError("card entry equals card stop")
    sg = 1 if side == "call" else -1
    return round2(sg * (exit_price - entry_open) / risk)


@dataclass(frozen=True)
class Outcome:
    status: Literal["scored", "bars_incomplete", "no_entry_bar"]
    entry_open: float | None = None
    entry_bar_start: int | None = None
    exit: Exit | None = None
    exit_bar_end: int | None = None
    r: float | None = None


def break_outcome(bars1: list[Bar] | None, clock: SessionClock, evaluated_ms: int, side: Side,
                  card_entry: float, card_stop: float, card_t1: float) -> Outcome:
    """One break's stock outcome from the session's 1-minute SIP bars for its name."""
    if bars1 is None:
        return Outcome("bars_incomplete")
    bars2 = join_2m(bars1, clock)
    if not usable(bars2, clock):
        return Outcome("bars_incomplete")
    i = entry_index(bars2, evaluated_ms)
    if i is None:
        return Outcome("no_entry_bar")
    entry_open = bars2[i].o
    ex = after_fill(bars2, i, side, card_t1, card_stop)
    return Outcome("scored", entry_open, bars2[i].t, ex, bars2[ex.bar].t + BAR_MS,
                   r_multiple(side, ex.price, entry_open, card_entry, card_stop))
