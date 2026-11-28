"""The lab's tape recorder (DEC-0060 section 2; EXP-0041 `recording`).

    python -m wt.lab.recorder            # the job: waits for 09:25 New York, reads the focus list, records to the close

What it does, and nothing else:
- reads the focus list once at 09:25 (`wt.lab.focus`); keeps it only if it is for today, and only desk names, at most
  six; no list, nothing is recorded (DEC-0051 section 5.1);
- from 09:30 every 5 seconds, first: the tier-1 option snapshots (OPRA) and the focus names' SIP stock snapshots;
- every 60 seconds, on a worker thread so the 5-second sweep never waits for it: each name's chain, to add contracts
  to the tiers (add-only; tier 1 capped per name), then the tier-2 snapshots;
- writes a row only when a contract's quote or trade changed; raw fields only, nothing worked out; parts flushed every
  two minutes, so a stop loses at most that;
- counts coverage on the opening tier-1 set, frozen once every name has been selected (or after five minutes, with
  the names still missing written down and the session marked incomplete);
- stays inside its request budget, backs off while Alpaca's remaining-requests header is low (a reading lasts one
  minute), and stops on the off switch (`var/lab/OFF`), on low disk (17 GB) or on its memory limit, writing why;
- survives a restart: its state (names, focus sha256, opening set, counts) is kept in the session folder, and a
  restarted run resumes from the current time without reading the focus list again;
- writes the session's manifest only when the session is over.

Data requests only, every one naming its feed. No order path, no account read, no import of either
(tests/unit/test_lab_boundary.py).
"""
from __future__ import annotations

import collections
import concurrent.futures as cf
import contextlib
import dataclasses
import datetime as dt
import fcntl
import json
import math
import os
import resource
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time
import zoneinfo
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import pyarrow.parquet as pq
import requests

from wt.core.config import ROOT, STATE_DIR
from wt.lab import focus, manifest, tiers
from wt.lab.probe import DATA_HOST, Answer, Get, chain, check_url, desk_names, http_get, pair_headers
from wt.lab.tape import STREAMS, PartWriter, option_fields, quote_fields, ts_ns
from wt.options.chain import parse_occ

NY = zoneinfo.ZoneInfo("America/New_York")
BATCH = 100
MAX_NAMES = 6                                       # config/options_clone.yaml names.max_names
CHANGE_KEY = ("tier", "bid", "ask", "bid_size", "ask_size", "quote_ts", "last", "last_size", "last_ts", "volume")
# greeks and IV are not in the key: on a row they are as of its quote or trade change, never forward-filled as current
STATE = "state.json"
RUNS_KEPT = 200                                     # stale runs kept per name in the state and the manifest
START_GRACE_S = 1.0                                 # a tick is still run when the run starts this late for it
RECORDER_VERSION = 2                                # 2: sample and member streams, freshness by name (DEC-0067)
# Why a stale run happened (diagnostic only: no counting rule reads it). On 2026-11-25 every tier-1 request was answered
# and the stock quotes stayed current while option quotes all but stopped changing, for all names at once, twice; that
# was found by hand from the tape. Each run now carries the same reading, and a cause from it.
CAUSE_BASELINE_TICKS = 60                           # the five minutes before a run: its normal rate of quote changes
CAUSE_ANSWERED_AT_LEAST = 0.9                       # fewer tier-1 batches answered than this share: the requests failed
CAUSE_STOPPED_UNDER = 0.2                           # changes per tick under this share of the baseline: quotes stopped
CAUSES = ("requests_failed", "stock_feed_too", "option_quotes_stopped", "name_only", "unknown")


@dataclass(frozen=True)
class Settings:
    tick_s: float = 5.0
    minute_ticks: int = 12                          # chains and tier 2 every 60 seconds
    budget_per_min: int = 400
    back_off_share: float = 0.30
    reading_lasts_s: float = 60.0
    min_free_gb: float = 17.0
    max_rss_mb: float = 700.0
    timeout_s: float = 3.0
    workers: int = 4
    flush_every_s: float = 120.0
    freeze_by_ticks: int = 60                       # five minutes: freeze the opening set even if a name is missing
    max_errors_in_a_row: int = 20
    max_mid_age_s: float = 30.0
    stale_after_s: float = 30.0                     # a name whose newest tier-1 quote is older than this is stale


class Clock(Protocol):
    def now(self) -> dt.datetime: ...
    def sleep(self, seconds: float) -> None: ...


def ns_of(t: dt.datetime) -> int:
    """Nanoseconds since the epoch of an aware time (exact to the microsecond the clock gives)."""
    d = t - dt.datetime(1970, 1, 1, tzinfo=dt.UTC)
    return (d.days * 86_400 + d.seconds) * 1_000_000_000 + d.microseconds * 1_000


class WallClock:
    def now(self) -> dt.datetime:
        return dt.datetime.now(dt.UTC)

    def sleep(self, seconds: float) -> None:
        time.sleep(max(0.0, seconds))


class Stop(Exception):
    """Raised inside a request when the session must stop or the budget is spent."""


TERM = threading.Event()                            # set by SIGTERM: stop at the next check, flush, exit 143


def rss_mb() -> float:
    """Current resident memory (not the high-water mark) where /proc exists; the high-water mark elsewhere."""
    try:
        pages = int(Path("/proc/self/statm").read_text().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024)
    except (OSError, ValueError, IndexError):
        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024


@dataclass
class Recorder:
    get: Get
    headers: Mapping[str, str]
    names: Sequence[str]
    day: dt.date
    folder: Path
    clock: Clock
    settings: Settings = field(default_factory=Settings)
    rules: tiers.Rules = tiers.RULES
    cal: Sequence[str] | None = None
    off_file: Path = STATE_DIR / "lab" / "OFF"
    free_gb: Callable[[], float] | None = None
    memory_mb: Callable[[], float] | None = None    # None: rss_mb, looked up when called
    clock_offset: Callable[[], float | None] | None = None   # None: clock_offset_ms (chrony), looked up when called
    inline_minute: bool = False                     # tests: run the minute's work on the main thread

    def __post_init__(self) -> None:
        self.names = list(self.names)[:MAX_NAMES]
        self.lock = threading.RLock()
        self.option = PartWriter(self.folder, "option")
        self.stock = PartWriter(self.folder, "stock")
        self.gap = PartWriter(self.folder, "gap")
        self.sample = PartWriter(self.folder, "sample")
        self.member = PartWriter(self.folder, "member")
        self.refused: set[str] = set()                            # tier-1 candidates the cap kept out (noted once)
        self.start: dt.datetime | None = None                     # 09:30: tick 0
        self.last_tick: int | None = None                         # the newest tick run, across restarts
        self.stale_from: dict[str, int] = {}                     # name: the first tick of its current stale run
        self.name_newest: dict[str, int] = {}                     # name: the newest tier-1 quote time answered
        self.first_fresh: dict[str, int] = {}                     # name: the first tick its quotes were fresh
        self.stale_by_name: dict[str, int] = {}                   # name: stale ticks after the freeze
        self.stale_runs: dict[str, list[list[int]]] = {}         # name: closed stale runs [first tick, ticks]
        self.stale_causes: dict[str, list[dict[str, Any]]] = {}  # name: the cause of each kept run, in the same order
        self.run_acc: dict[str, dict[str, Any]] = {}             # name: what its open stale run has seen so far
        self.tick_t1 = {"batches": 0, "answered": 0, "changed": 0}  # this tick's tier-1 sweep, every name
        self.stock_age: dict[str, float] = {}                    # name: this tick's SIP quote age at receipt (s)
        self.recent_changed: collections.deque[int] = collections.deque(maxlen=CAUSE_BASELINE_TICKS)
        self.batch_syms: dict[tuple[int, int], tuple[str, ...]] = {}   # (tier, batch): the symbols last written
        self.tail_counted = False
        self.offsets: list[float] = []                 # the host clock's offset (ms), read every 30 minutes
        self.tier1: dict[str, list[str]] = {n: [] for n in self.names}
        self.tier2: set[str] = set()
        self.selected: set[str] = set()
        self.opening: frozenset[str] | None = None
        self.opening_missing: list[str] = []
        self.freeze_tick: int | None = None
        self.mids: dict[str, tuple[float, float]] = {}            # name: (mid, clock seconds)
        self.last: dict[str, tuple[Any, ...]] = {}
        self.sent: collections.deque[float] = collections.deque()
        self.reading: tuple[float, float] | None = None           # (remaining share, clock seconds)
        self.counts = {"requests": 0, "taken": 0, "taken_fresh": 0, "expected": 0, "ticks_run": 0, "restarts": 0,
                       "errors": 0, "stale_ticks": 0, "longest_stale_ticks": 0, "ticks_down": 0,
                       "stale_slow_start": 0, "stale_mid_session": 0, "stale_runs": 0,
                       "tier1_rows": 0, "tier1_crossed_rows": 0, "low_readings": 0, "refused_429": 0,
                       "budget_refused": 0}
        self.min_share: float | None = None                        # lowest remaining-requests share Alpaca reported
        self.stopped: str | None = None
        self.errors_in_a_row = 0
        self.minute: cf.Future[None] | None = None
        self.last_minute = -1
        self.busy_noted = -1
        self.last_flush = 0.0
        self.scheduled = 0
        self.first_tick: int | None = None             # this run's first tick
        self.minutes_done = 0                          # minute jobs finished in this run
        self.load()

    # ------------------------------------------------------------ state kept across restarts
    def load(self) -> None:
        p = self.folder / STATE
        if not p.exists():
            return
        try:
            s = json.loads(p.read_text())
            if not isinstance(s, dict) or not isinstance(s.get("tier1"), dict):
                raise ValueError("not a state")
        except ValueError:
            os.replace(p, p.with_name(STATE + ".bad"))    # kept for a look; this run starts its state again
            self.counts["restarts"] += 1
            return
        self.tier1 = {n: list(s["tier1"].get(n, [])) for n in self.names}
        self.tier2 = set(s.get("tier2", []))
        self.selected = set(s.get("selected", []))
        if s.get("opening") is not None:
            self.opening = frozenset(s["opening"])
        self.opening_missing = list(s.get("opening_missing", []))
        self.freeze_tick = s.get("freeze_tick")
        self.last_tick = s.get("last_tick")
        self.refused = set(s.get("refused", []))
        self.stale_from = {str(k): int(v) for k, v in (s.get("stale_from") or {}).items()}
        self.stale_by_name = {str(k): int(v) for k, v in (s.get("stale_by_name") or {}).items()}
        self.first_fresh = {str(k): int(v) for k, v in (s.get("first_fresh") or {}).items()}
        self.stale_runs = {str(k): [[int(a), int(b)] for a, b in v] for k, v in (s.get("stale_runs") or {}).items()}
        self.name_newest = {str(k): int(v) for k, v in (s.get("name_newest") or {}).items()}
        self.stale_causes = {str(k): [dict(c) for c in v] for k, v in (s.get("stale_causes") or {}).items()}
        for n, runs in self.stale_runs.items():           # a state from before causes: its kept runs are unknown
            have = self.stale_causes.setdefault(n, [])[:len(runs)]
            self.stale_causes[n] = have + [{"cause": "unknown"}] * (len(runs) - len(have))
        self.run_acc = {str(k): dict(v) for k, v in (s.get("run_acc") or {}).items()}
        ms = s.get("min_share")
        self.min_share = float(ms) if isinstance(ms, (int, float)) and not isinstance(ms, bool) else None
        self.counts.update({k: int(v) for k, v in (s.get("counts") or {}).items() if k in self.counts})
        self.counts["restarts"] += 1

    def save(self) -> None:
        with self.lock:
            doc = {"names": list(self.names), "tier1": self.tier1, "tier2": sorted(self.tier2),
                   "selected": sorted(self.selected),
                   "opening": sorted(self.opening) if self.opening is not None else None,
                   "opening_missing": self.opening_missing, "freeze_tick": self.freeze_tick, "counts": self.counts,
                   "last_tick": self.last_tick, "refused": sorted(self.refused), "scheduled": self.scheduled,
                   "stale_from": self.stale_from, "stale_by_name": self.stale_by_name, "first_fresh": self.first_fresh,
                   "stale_runs": self.stale_runs, "name_newest": self.name_newest, "min_share": self.min_share,
                   "stale_causes": self.stale_causes, "run_acc": self.run_acc}
            manifest.atomic(self.folder / STATE, json.dumps(doc))

    # ------------------------------------------------------------ requests, within the budget
    def _t(self) -> float:
        return self.clock.now().timestamp()

    def _ns(self) -> int:
        return ns_of(self.clock.now())

    def tick_now(self) -> int:
        """The tick the clock is in now (tier-2 rows and membership carry the tick they happened in)."""
        if self.start is None:
            return -1
        return max(0, int((self.clock.now() - self.start).total_seconds() // self.settings.tick_s))

    def room(self, n: int = 1) -> bool:
        with self.lock:
            t = self._t()
            while self.sent and t - self.sent[0] >= 60:
                self.sent.popleft()
            low = (self.reading is not None and t - self.reading[1] < self.settings.reading_lasts_s
                   and self.reading[0] < self.settings.back_off_share)
            return not low and len(self.sent) + n <= self.settings.budget_per_min

    def claim(self, n: int = 1, keep: int = 0) -> bool:
        """Take `n` requests of the minute's budget, leaving `keep` for others, in one step under the lock: the
        tick loop and the minute's worker thread can never both see room for the same slot."""
        with self.lock:
            if not self.room(n + keep):
                return False
            t = self._t()
            self.sent.extend([t] * n)
            return True

    def send(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float,
             claimed: bool = False) -> Answer:
        """One request. `claimed`: its slot was taken by `claim`; otherwise it is taken here, unchecked."""
        check_url(url)                                  # whatever `get` is, the lab never calls another URL
        with self.lock:
            if not claimed:
                self.sent.append(self._t())
            self.counts["requests"] += 1
        a = self.get(url, params, headers, timeout)
        hl = {k.lower(): v for k, v in a.headers.items()}
        if a.status == 429:
            with self.lock:
                self.counts["refused_429"] += 1
        try:
            share = int(hl["x-ratelimit-remaining"]) / max(1, int(hl["x-ratelimit-limit"]))
            with self.lock:
                self.reading = (share, self._t())
                self.min_share = share if self.min_share is None else min(self.min_share, share)
                if share < self.settings.back_off_share:
                    self.counts["low_readings"] += 1
        except (KeyError, ValueError):
            pass
        return a

    def guarded(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
        """`send`, but refusing when the session must stop or the budget is spent (used page by page)."""
        if self.should_stop() is not None or not self.claim(1):
            raise Stop("budget or stop")
        return self.send(url, params, headers, timeout, claimed=True)

    def paced(self, deadline: float) -> Get:
        """A sender that waits for room in the budget (and for a low remaining-requests reading to pass) instead of
        refusing; past `deadline` (time.monotonic) it answers status 0 without sending."""
        def get(url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
            while not self.claim(1):
                if time.monotonic() > deadline or self.should_stop() is not None:
                    return Answer(0, {}, None, 0.0)
                self.clock.sleep(0.25)
            return self.send(url, params, headers, timeout, claimed=True)
        return get

    def _gap(self, tick: int, stream: str, reason: str) -> None:
        with self.lock:
            self.gap.add({"recv_ns": self._ns(), "tick": tick, "stream": stream, "reason": reason[:200]})

    def _sample(self, tick: int, tier: int, batch: int, syms: Sequence[str], answered: int, changed: int,
                status: int, newest: int | None, result: str, missing: Sequence[str]) -> None:
        with self.lock:
            if result == "budget":
                self.counts["budget_refused"] += 1
            key, now = (tier, batch), tuple(syms)
            listed = None if self.batch_syms.get(key) == now else ",".join(now)
            self.batch_syms[key] = now
            self.sample.add({"recv_ns": self._ns(), "tick": tick, "tier": tier, "batch": batch, "asked": len(syms),
                             "symbols": listed,
                             "answered": answered, "changed": changed, "status": status, "newest_quote_ns": newest,
                             "result": result, "missing": ",".join(missing) or None,
                             "first": syms[0] if syms else None, "last": syms[-1] if syms else None})

    # ------------------------------------------------------------ writing
    def _write(self, writer: PartWriter, key: str, row: Mapping[str, Any]) -> bool:
        k = tuple(row.get(c) for c in CHANGE_KEY)
        with self.lock:
            if self.last.get(key) == k:
                return False
            self.last[key] = k
            writer.add(row)
            return True

    def stocks(self, tick: int) -> None:
        names = list(self.names)
        if not self.claim(1):
            self._gap(tick, "stock", "budget")
            self._sample(tick, 0, 0, names, 0, 0, 0, None, "budget", names)
            return
        a = self.send(f"{DATA_HOST}/v2/stocks/snapshots", {"symbols": ",".join(self.names), "feed": "sip"},
                      self.headers, self.settings.timeout_s, claimed=True)
        if a.status != 200 or not isinstance(a.body, dict):
            self._gap(tick, "stock", f"status {a.status}")
            self._sample(tick, 0, 0, names, 0, 0, a.status, None, "failed", names)
            return
        now, t = self._ns(), self._t()
        got, changed, newest = set(), 0, None
        for name, snap in a.body.items():
            if name not in self.tier1 or not isinstance(snap, Mapping):
                continue
            got.add(name)
            row = quote_fields(snap)
            q = ts_ns(row["quote_ts"])
            newest = q if newest is None or (q is not None and q > newest) else newest
            if q is not None:
                with self.lock:
                    self.stock_age[name] = (now - q) / 1e9
            bid, ask, last = row["bid"], row["ask"], row["last"]
            if isinstance(bid, float) and isinstance(ask, float) and 0 < bid <= ask:
                self.mids[name] = ((bid + ask) / 2, t)
            elif isinstance(last, float) and last > 0:
                self.mids[name] = (last, t)
            changed += self._write(self.stock, f"stock:{name}", {"recv_ns": now, "tick": tick, "symbol": name, **row})
        self._sample(tick, 0, 0, names, len(got), changed, a.status, newest, "ok",
                     [n for n in names if n not in got])

    def select(self, tick: int) -> None:
        """Add contracts to the tiers from each name's chain; never remove one within the session."""
        for name in self.names:
            got = self.mids.get(name)
            if got is None or self._t() - got[1] > self.settings.max_mid_age_s:
                self._gap(tick, "select", f"no fresh mid {name}")
                continue
            mid = got[0]
            try:
                c = chain(self.guarded, self.headers, name, mid, self.day, self.rules)
            except Stop:
                with self.lock:
                    self.counts["budget_refused"] += 1
                self._gap(tick, "select", f"budget {name}")
                continue
            if c["status"] != 200:
                self._gap(tick, "select", f"status {c['status']} {name}")
                continue
            asks = {s: a for s, a in c["asks"].items() if (o := parse_occ(s)) is not None and o.root == name}
            with self.lock:
                have = set(self.tier1[name])
            new1 = [(s, occ.strike) for s, ask in asks.items() if s not in have
                    and tiers.tier(s, ask, mid, self.day, self.rules, self.cal) == 1 and (occ := parse_occ(s)) is not None]
            now, at = self._ns(), self.tick_now()
            with self.lock:
                room = self.rules.t1_max_per_name - len(self.tier1[name])
                ranked = tiers.cap_tier1(new1, mid, dataclasses.replace(self.rules, t1_max_per_name=10**6))
                joined, kept_out = ranked[:max(0, room)], ranked[max(0, room):]
                self.tier1[name] += joined
                in1 = set(self.tier1[name])
                new2 = {s for s, ask in asks.items() if s not in in1 and s not in self.tier2
                        and tiers.tier(s, ask, mid, self.day, self.rules, self.cal) in (1, 2)}
                for sym in joined:
                    self.member.add({"recv_ns": now, "tick": at, "symbol": sym, "tier": 1,
                                     "event": "promoted" if sym in self.tier2 else "joined", "stock_mid": mid})
                for sym in sorted(new2):
                    self.member.add({"recv_ns": now, "tick": at, "symbol": sym, "tier": 2, "event": "joined",
                                     "stock_mid": mid})
                for sym in kept_out:
                    if sym not in self.refused:
                        self.refused.add(sym)
                        self.member.add({"recv_ns": now, "tick": at, "symbol": sym, "tier": 0, "event": "cap",
                                         "stock_mid": mid})
                self.tier2 |= new2
                self.tier2 -= in1
                self.selected.add(name)

    def freeze(self, tick: int) -> None:
        """Freeze the opening set once this run has finished a minute's work and every name has been selected, or
        `freeze_by_ticks` after this run's first tick with the names still missing written down."""
        if self.opening is not None or self.minutes_done == 0:
            return
        done = all(n in self.selected for n in self.names)
        if not done and tick - (self.first_tick or 0) < self.settings.freeze_by_ticks:
            return
        with self.lock:
            self.opening = frozenset(s for v in self.tier1.values() for s in v)
            self.opening_missing = [n for n in self.names if n not in self.selected]
            self.freeze_tick = tick
        self.save()

    def sweep(self, symbols: Iterable[str], tier: int, tick: int,
              reserve: int = 0) -> tuple[dict[str, int], dict[str, int], dict[str, int]]:
        """One sweep in batches of 100, each budgeted on its own; `reserve` requests are left for tier 1. Every batch
        leaves a sample row, sent or not. Returns, by name (the contract's root): opening-set samples answered, the
        newest quote time answered, and opening-set samples whose own quote is from this session."""
        syms = sorted(symbols)
        batches = [syms[i:i + BATCH] for i in range(0, len(syms), BATCH)]
        go: list[tuple[int, list[str]]] = []
        for i, b in enumerate(batches):
            if self.should_stop() is None and self.claim(1, keep=reserve):
                go.append((i, b))
            else:
                self._sample(tick, tier, i, b, 0, 0, 0, None, "budget", b)
                self._tally(tier, answered=False)
        if len(go) < len(batches):
            self._gap(tick, f"tier{tier}", f"budget {len(batches) - len(go)} batches")

        def one(ib: tuple[int, list[str]]) -> tuple[int, list[str], Answer, int]:
            i, b = ib
            a = self.send(f"{DATA_HOST}/v1beta1/options/snapshots", {"symbols": ",".join(b), "feed": "opra"},
                          self.headers, self.settings.timeout_s, claimed=True)
            return i, b, a, self._ns()

        with cf.ThreadPoolExecutor(max_workers=self.settings.workers) as pool:
            answers = list(pool.map(one, go))
        missing = 0
        taken: dict[str, int] = {}
        current: dict[str, int] = {}                     # of those, quoted since the open (a pre-open quote is old)
        newest: dict[str, int] = {}
        open_ns = ns_of(self.start) if self.start is not None else 0
        for i, b, a, recv in answers:
            snaps = a.body.get("snapshots") if a.status == 200 and isinstance(a.body, dict) else None
            if not isinstance(snaps, Mapping):
                self._gap(tick, f"tier{tier}", f"status {a.status} batch {i}")
                self._sample(tick, tier, i, b, 0, 0, a.status, None, "failed", b)
                self._tally(tier, answered=False)
                continue
            lost, changed, bnew = [], 0, None
            for sym in b:
                snap = snaps.get(sym)
                if not isinstance(snap, Mapping):
                    lost.append(sym)
                    continue
                root = sym[:-15]                       # an OCC symbol: root, then 15 characters
                row = {"recv_ns": recv, "tick": tick, "tier": tier, "symbol": sym, **option_fields(snap)}
                q = ts_ns(row["quote_ts"])
                if tier == 1 and self.opening is not None and sym in self.opening:
                    taken[root] = taken.get(root, 0) + 1
                    if q is not None and q >= open_ns:
                        current[root] = current.get(root, 0) + 1
                bnew = q if bnew is None or (q is not None and q > bnew) else bnew
                if q is not None and q > newest.get(root, 0):
                    newest[root] = q
                wrote = self._write(self.option, sym, row)
                changed += wrote
                if wrote and tier == 1:
                    b_, a_ = row["bid"], row["ask"]
                    with self.lock:
                        self.counts["tier1_rows"] += 1
                        self.counts["tier1_crossed_rows"] += int(isinstance(b_, float) and isinstance(a_, float)
                                                                 and a_ > 0 and b_ > a_)
            missing += len(lost)
            self._sample(tick, tier, i, b, len(b) - len(lost), changed, a.status, bnew, "ok", lost)
            self._tally(tier, answered=True, changed=changed)
        if missing:
            self._gap(tick, f"tier{tier}", f"missing {missing}")
        return taken, newest, current

    def _tally(self, tier: int, answered: bool, changed: int = 0) -> None:
        """This tick's tier-1 batches, answered batches and changed quotes, over every name (cause diagnostics)."""
        if tier != 1:
            return
        with self.lock:
            self.tick_t1["batches"] += 1
            self.tick_t1["answered"] += int(answered)
            self.tick_t1["changed"] += changed

    def tier1_now(self) -> set[str]:
        with self.lock:
            return {s for v in self.tier1.values() for s in v}

    CLOCK_EVERY_MIN = 30

    def minute_work(self, tick: int) -> None:
        if (tick // self.settings.minute_ticks) % self.CLOCK_EVERY_MIN == 0:
            try:
                off = (self.clock_offset or clock_offset_ms)()
            except Exception:  # noqa: BLE001 (a clock reading never stops the session)
                off = None
            if off is not None:
                with self.lock:
                    self.offsets.append(off)
        try:
            self.select(tick)
            with self.lock:
                t2 = set(self.tier2)
            reserve = 2 * math.ceil(len(self.tier1_now()) / BATCH) + 1        # the next tier-1 sweep and stocks
            self.sweep(t2, 2, self.tick_now(), reserve)
        except Exception as e:  # noqa: BLE001 (the minute's work never ends the session)
            self._gap(tick, "minute", f"error {e.__class__.__name__}")
        finally:
            with self.lock:
                self.minutes_done += 1

    # ------------------------------------------------------------ the session
    def should_stop(self) -> str | None:
        if TERM.is_set():
            return "sigterm"
        if self.off_file.exists():
            return "off switch"
        free = self.free_gb() if self.free_gb else shutil.disk_usage(self.folder).free / 1e9
        if free < self.settings.min_free_gb:
            return f"free disk under {self.settings.min_free_gb:g} GB"
        if (self.memory_mb or rss_mb)() > self.settings.max_rss_mb:
            return "memory limit"
        return None

    def flush(self) -> None:
        with self.lock:
            for w in (self.option, self.stock, self.gap, self.sample, self.member):
                w.flush()
        self.save()
        self.last_flush = self._t()

    def one_tick(self, tick: int, pool: cf.ThreadPoolExecutor) -> None:
        ok = True
        with self.lock:
            self.tick_t1 = {"batches": 0, "answered": 0, "changed": 0}
            self.stock_age = {}
        got: tuple[dict[str, int], dict[str, int], dict[str, int]] = ({}, {}, {})
        try:
            got = self.sweep(self.tier1_now(), 1, tick)
        except Exception as e:  # noqa: BLE001 (one bad answer costs one tick, not the session)
            ok = False
            self._gap(tick, "tick", f"error {e.__class__.__name__}")
        try:
            self.stocks(tick)
        except Exception as e:  # noqa: BLE001
            ok = False
            self._gap(tick, "tick", f"error {e.__class__.__name__}")
        self.freshness(tick, *got)
        self.counts["errors"] += 0 if ok else 1
        self.errors_in_a_row = 0 if ok else self.errors_in_a_row + 1
        minute = tick // self.settings.minute_ticks
        if minute > self.last_minute:
            if self.minute is not None and not self.minute.done():
                if self.busy_noted != minute:
                    self.busy_noted = minute
                    self._gap(tick, "minute", "previous minute still running")
            else:
                self.last_minute = minute
                if self.inline_minute:
                    self.minute_work(tick)
                else:
                    self.minute = pool.submit(self.minute_work, tick)
        self.freeze(tick)

    def _close_run(self, name: str, began: int, ticks: int) -> None:
        """Keeps a closed stale run (diagnostic only: no counting rule reads it). Every run is counted; the first
        RUNS_KEPT of each name are kept, so a name that flaps all day cannot swell the state or the manifest."""
        self.counts["stale_runs"] += 1
        runs = self.stale_runs.setdefault(name, [])
        acc = self.run_acc.pop(name, None)
        if len(runs) < RUNS_KEPT:
            runs.append([began, ticks])
            self.stale_causes.setdefault(name, []).append(self.cause_of(acc))

    def cause_of(self, acc: Mapping[str, Any] | None) -> dict[str, Any]:
        """What a stale run saw, and its cause, first that applies: tier-1 batches went unanswered (requests_failed);
        this name's SIP stock quote was old or missing too (stock_feed_too); option quotes across every name changed
        at under a fifth of their rate in the five minutes before (option_quotes_stopped, as on 2026-11-25); else
        only this name went quiet (name_only). A run with no reading, or no baseline, is unknown."""
        if not acc or not acc.get("ticks"):
            return {"cause": "unknown"}
        ticks, batches = int(acc["ticks"]), int(acc.get("batches", 0))
        answered = round(acc.get("answered", 0) / batches, 4) if batches else None
        per_tick = round(acc.get("changed", 0) / ticks, 1)
        before = acc.get("baseline")
        age = acc.get("stock_age_max")
        no_stock = int(acc.get("stock_missing", 0))
        if answered is None or answered < CAUSE_ANSWERED_AT_LEAST:
            cause = "requests_failed"
        elif no_stock * 2 > ticks or (age is not None and age > self.settings.stale_after_s):
            cause = "stock_feed_too"
        elif before is None:
            cause = "unknown"
        elif per_tick <= CAUSE_STOPPED_UNDER * before:
            cause = "option_quotes_stopped"
        else:
            cause = "name_only"
        return {"cause": cause, "tier1_answered_share": answered, "tier1_changed_per_tick": per_tick,
                "tier1_changed_per_tick_before": before, "stock_quote_age_s_max": None if age is None else round(age, 1),
                "stock_missing_ticks": no_stock}

    def _see(self, name: str, tick: int) -> None:
        """Adds this tick's reading to the name's open stale run (under the lock). The baseline is the median of the
        ticks before the run opened; a run whose start this run did not see (a restart) has none."""
        acc = self.run_acc.get(name)
        if acc is None:
            opening = tick == self.stale_from.get(name)
            base = statistics.median(self.recent_changed) if opening and self.recent_changed else None
            acc = self.run_acc[name] = {"ticks": 0, "batches": 0, "answered": 0, "changed": 0,
                                        "baseline": None if base is None else round(float(base), 1),
                                        "stock_age_max": None, "stock_missing": 0}
        t = self.tick_t1
        acc["ticks"] += 1
        acc["batches"] += t["batches"]
        acc["answered"] += t["answered"]
        acc["changed"] += t["changed"]
        age = self.stock_age.get(name)
        if age is None:
            acc["stock_missing"] += 1
        else:
            acc["stock_age_max"] = age if acc["stock_age_max"] is None else max(acc["stock_age_max"], age)

    def stale_causes_now(self) -> dict[str, list[dict[str, Any]]]:
        """The causes of the runs in `stale_runs_now`, in the same order, an open run read as it stands."""
        out = {n: [dict(c) for c in v] for n, v in self.stale_causes.items()}
        last = self.last_tick
        for n, began in self.stale_from.items():
            if last is not None and last >= began and len(self.stale_runs.get(n, [])) < RUNS_KEPT:
                out.setdefault(n, []).append(self.cause_of(self.run_acc.get(n)))
        return dict(sorted(out.items()))

    def stale_runs_now(self) -> dict[str, list[list[int]]]:
        """The closed stale runs by name, with any run still open counted to the newest tick run."""
        out = {n: [list(r) for r in v] for n, v in self.stale_runs.items()}
        last = self.last_tick
        for n, began in self.stale_from.items():
            if last is not None and last >= began and len(out.get(n, [])) < RUNS_KEPT:
                out.setdefault(n, []).append([began, last - began + 1])
        return dict(sorted(out.items()))

    def freshness(self, tick: int, taken: Mapping[str, int], newest: Mapping[str, int],
                  current: Mapping[str, int] | None = None) -> None:
        """Freshness is judged name by name: a name is fresh at a tick when the newest tier-1 quote ever answered for
        it is at most `stale_after_s` old. On 2026-11-19 three of four names were answered with the previous day's
        quotes for the first hour while one name moved, so a test over the whole sweep would have called every one
        of those ticks fresh. A quote stamped before the open is old by construction. Opening-set samples count as
        fresh only for a name fresh at that tick; each name's stale run is written as two gap rows."""
        now = self._ns()
        with self.lock:
            for n, q in newest.items():
                if q > self.name_newest.get(n, 0):
                    self.name_newest[n] = q
            names = sorted(set(self.names))             # every name, with tier-1 contracts or not
            stale_names = []
            with_t1 = {s[:-15] for s in self.tier1_now()}
            for n in names:
                if n not in with_t1:
                    continue                             # no tier-1 contract yet: listed in the manifest instead
                seen = self.name_newest.get(n)
                age = None if seen is None else (now - seen) / 1e9
                fresh = age is not None and age <= self.settings.stale_after_s
                if fresh and n not in self.first_fresh:
                    self.first_fresh[n] = tick
                if self.opening is None:
                    continue
                if fresh:
                    if n in self.stale_from:
                        began = self.stale_from.pop(n)
                        self._close_run(n, began, tick - began)
                        self._gap(tick, "feed", f"{n} fresh again after {tick - began} stale ticks")
                    continue
                stale_names.append(n)
                self.stale_by_name[n] = self.stale_by_name.get(n, 0) + 1
                self.counts["stale_mid_session" if n in self.first_fresh else "stale_slow_start"] += 1
                if n not in self.stale_from:
                    self.stale_from[n] = tick
                    self.run_acc.pop(n, None)
                    self._gap(tick, "feed", f"{n} stale: newest tier-1 quote "
                              + ("missing" if age is None else f"{age:.0f} s old"))
                self._see(n, tick)
                self.counts["longest_stale_ticks"] = max(self.counts["longest_stale_ticks"],
                                                         tick - self.stale_from[n] + 1)
            self.counts["taken"] += sum(taken.values())
            cur = current if current is not None else taken
            self.counts["taken_fresh"] += sum(cur.get(n, 0) for n in taken if n not in stale_names)
            if stale_names:
                self.counts["stale_ticks"] += 1
            self.recent_changed.append(self.tick_t1["changed"])

    def run(self, start: dt.datetime, end: dt.datetime) -> None:
        tick_s = self.settings.tick_s
        scheduled = max(0, math.ceil((end - start).total_seconds() / tick_s))
        self.clock.sleep((start - self.clock.now()).total_seconds())
        # resume: from now. A run that wakes just after a tick is due (the sleep to 09:30 returns a few ms late) runs
        # that tick, not the next: on 2026-11-20 tick 0 was skipped as "a late start" by 3 ms
        late = (self.clock.now() - start).total_seconds()
        tick = max(0, math.ceil(late / tick_s - START_GRACE_S / tick_s))
        self.scheduled, self.first_tick, self.start = scheduled, tick, start
        since = -1 if self.last_tick is None else self.last_tick
        if tick > since + 1 and since + 1 < scheduled:                     # ticks nobody ran: said, never hidden
            down = min(tick, scheduled) - since - 1
            self.counts["ticks_down"] += down
            self._gap(since + 1, "session", f"not running: {down} ticks from tick {since + 1}"
                      + (" (a restart)" if self.last_tick is not None else " (a late start)"))
        self.last_flush = self._t()
        with cf.ThreadPoolExecutor(max_workers=1) as minute_pool:
            while tick < scheduled:
                if (why := self.should_stop()) is not None:
                    self.stopped = why
                    self._gap(tick, "session", why)
                    break
                if self.errors_in_a_row >= self.settings.max_errors_in_a_row:
                    self.stopped = f"{self.errors_in_a_row} errors in a row"
                    self._gap(tick, "session", self.stopped)
                    break
                self.one_tick(tick, minute_pool)
                self.counts["ticks_run"] += 1
                self.last_tick = tick
                if self._t() - self.last_flush >= self.settings.flush_every_s:
                    self.flush()
                due = start + dt.timedelta(seconds=(tick + 1) * tick_s)
                behind = (self.clock.now() - due).total_seconds()
                skipped = int(behind // tick_s) if behind > 0 else 0
                if skipped:
                    self._gap(tick, "session", f"late, {skipped} ticks skipped")
                    self.counts["ticks_down"] += min(skipped, max(0, scheduled - tick - 1))
                    self.last_tick = tick + skipped
                tick += 1 + skipped
                self.clock.sleep((start + dt.timedelta(seconds=tick * tick_s) - self.clock.now()).total_seconds())
            if self.minute is not None:
                self.minute.result()
        self.flush()

    def expected(self, strict: bool = False) -> int:
        """Samples due: the opening set at every tick after the freeze up to the close, whether or not it ran (a
        stop, an outage or a restart is missed coverage, never a smaller denominator)."""
        if self.opening is None or self.freeze_tick is None:
            return 0
        # EXP-0041 as frozen: from the freeze. `strict` (proposed in DEC-0067): from the freeze or from where it is due
        # (five minutes in), whichever is earlier, so a late start or a crash before the freeze cannot shrink it.
        since = min(self.freeze_tick, self.settings.freeze_by_ticks) if strict else self.freeze_tick
        return len(self.opening) * max(0, self.scheduled - since - 1)

    def headroom(self) -> dict[str, Any]:
        """Rate-limit headroom over the session (DEC-0060 data checks), read at the close so the after-close pull is
        not in it: the lowest share of Alpaca's minute left, how often it fell under the back-off share, answers
        refused with 429, and chain reads or sweep batches the lab's own budget skipped."""
        with self.lock:
            c = self.counts
            return {"rate_limit_min_remaining_share": None if self.min_share is None else round(self.min_share, 4),
                    "rate_limit_low_readings": c["low_readings"], "rate_limit_429": c["refused_429"],
                    "budget_refused_batches": c["budget_refused"]}

    def finish(self, info: Mapping[str, Any]) -> dict[str, Any]:
        tail = self.scheduled - 1 - (self.last_tick if self.last_tick is not None else -1)
        if tail > 0 and not self.tail_counted:          # a stop, a crash past the close, a day never finished
            self.counts["ticks_down"] += tail
            self.tail_counted = True
        self.flush()
        c = {**self.counts, "expected": self.expected(), "strict": self.expected(strict=True)}
        rows = {st: sum(pq.ParquetFile(f).metadata.num_rows for f in self.folder.glob(f"{st}-*.parquet"))
                for st in STREAMS}                         # from the files: every run's rows, restarts included
        return manifest.write(self.folder, {
            **info, "recorded": True, "names": list(self.names), "opening_tier1": sorted(self.opening or ()),
            "opening_missing": self.opening_missing,
            "opening_complete": self.opening is not None and not self.opening_missing,
            "freeze_tick": self.freeze_tick, "tier1_final": sum(len(v) for v in self.tier1.values()),
            "tier2_final": len(self.tier2), "ticks_run": c["ticks_run"], "samples_expected": c["expected"],
            "samples_taken": c["taken"], "coverage": round(c["taken"] / c["expected"], 6) if c["expected"] else 0.0,
            "samples_taken_fresh": c["taken_fresh"],
            "coverage_fresh": round(c["taken_fresh"] / c["expected"], 6) if c["expected"] else 0.0,
            "samples_expected_strict": c["strict"],
            "coverage_fresh_strict": round(c["taken_fresh"] / c["strict"], 6) if c["strict"] else 0.0,
            "stale_ticks": c["stale_ticks"], "longest_stale_s": c["longest_stale_ticks"] * self.settings.tick_s,
            "ticks_down": c["ticks_down"], "ticks_scheduled": self.scheduled,
            "rules": dataclasses.asdict(self.rules), "settings": dataclasses.asdict(self.settings),
            "tier1_refused_by_cap": len(self.refused),
            "stale_ticks_by_name": dict(sorted(self.stale_by_name.items())),
            "names_without_tier1": sorted(n for n in self.names if not self.tier1.get(n)),
            "first_fresh_tick_by_name": dict(sorted(self.first_fresh.items())),
            "stale_ticks_slow_start": c["stale_slow_start"], "stale_ticks_mid_session": c["stale_mid_session"],
            "stale_runs_by_name": self.stale_runs_now(),
            "stale_run_causes_by_name": (causes := self.stale_causes_now()),
            "stale_run_causes": {k: n for k in CAUSES if (n := sum(c["cause"] == k for v in causes.values() for c in v))},
            "stale_runs": c["stale_runs"] + sum(1 for n, b in self.stale_from.items()
                                                if self.last_tick is not None and self.last_tick >= b),
            "tier1_crossed_share": round(c["tier1_crossed_rows"] / c["tier1_rows"], 6) if c["tier1_rows"] else 0.0,
            "clock_offset_ms_max_abs": max((abs(x) for x in self.offsets), default=None),
            "clock_offset_readings": len(self.offsets),
            "requests": c["requests"], "restarts": c["restarts"], "tick_errors": c["errors"],
            "stopped": self.stopped,
            "rows": rows,
        })


AFTER_CLOSE_MIN = 90                                # DEC-0060 section 2.4: stop by close plus 90 minutes
PRINTS_AFTER_CLOSE_MIN = 15                         # index and ETF options trade to 16:15: their prints are the day's
AFTER_CLOSE = "after_close.json"                    # written once the pull is over: a restart never pulls twice


def after_close(rec: Recorder, get: Get, headers: Mapping[str, str], start: dt.datetime, close: dt.datetime,
                clock: Clock) -> dict[str, Any]:
    """The day's prints for every tier-1 contract and the open interest of every recorded contract, into the session
    folder, by close plus 90 minutes. Requests go through the recorder's budget. Done once: a pull that a stop
    interrupted is removed and redone whole, never appended to. It never raises: what failed is in its answer."""
    from wt.lab import afterclose
    done = rec.folder / AFTER_CLOSE
    if done.exists():
        try:
            prev = json.loads(done.read_text())
            if isinstance(prev, dict):
                return prev
        except ValueError:
            pass
    pw, ow = PartWriter(rec.folder, "print"), PartWriter(rec.folder, "open_interest")
    out: dict[str, Any] = {}
    redone = pw.discard() + ow.discard()                # an interrupted pull is never kept, whatever comes next
    if redone:
        out["redone_parts_removed"] = redone
        rec._gap(-1, "after_close", f"an interrupted pull removed: {redone} parts")
    left = (close + dt.timedelta(minutes=AFTER_CLOSE_MIN) - clock.now()).total_seconds()
    if left <= 0:
        return {**out, "skipped": "past close plus 90 minutes"}
    deadline = time.monotonic() + left
    with rec.lock:
        t1 = sorted({s for v in rec.tier1.values() for s in v})
        every = set(t1) | set(rec.tier2)
    paced = rec.paced(deadline)
    try:
        expiries = [o.expiry for s in every if (o := parse_occ(s)) is not None]
        if expiries:                                 # open interest first: it does not wait for late prints
            out["open_interest"] = afterclose.open_interest(paced, headers, list(rec.names), min(expiries),
                                                            max(expiries), every, ow, rec.gap, deadline,
                                                            session=rec.day, tier1=set(t1))
        ow.flush()
        late = close + dt.timedelta(minutes=PRINTS_AFTER_CLOSE_MIN + 1)
        if rec.stopped is None and clock.now() < late:   # a full day: wait for the prints of the last fifteen minutes
            clock.sleep((late - clock.now()).total_seconds())
        end = min(close + dt.timedelta(minutes=PRINTS_AFTER_CLOSE_MIN), clock.now())
        out["prints_end"] = end.isoformat()
        out["prints"] = afterclose.prints(paced, headers, t1, start, end, pw, rec.gap, deadline)
        pw.flush()
    except Exception as e:  # noqa: BLE001 (the session's manifest is written whatever happens here)
        out["error"] = e.__class__.__name__
        rec._gap(-1, "after_close", f"error {e.__class__.__name__}")
        try:
            pw.flush()
            ow.flush()
        except Exception:  # noqa: BLE001
            pass
        return out                                   # the manifest records the error; the pull is not redone
    manifest.atomic(done, json.dumps(out, sort_keys=True))
    return out


def clock_offset_ms() -> float | None:
    """The host clock's offset from chrony, in milliseconds, or None when chrony cannot be read."""
    try:
        out = subprocess.run(["chronyc", "-c", "tracking"], capture_output=True, text=True, timeout=5, check=False)
        # field 5 of `chronyc -c tracking` is "System time": seconds the clock is off, signed (kept, not abs())
        return round(float(out.stdout.split(",")[4]) * 1000, 3) if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return None


def tape_root(env: Mapping[str, str]) -> Path:
    """`WT_LAB_TAPE`, or `lab-tape` beside the checkout. Never inside the repository: the tape is PRIVATE."""
    p = Path(env.get("WT_LAB_TAPE") or ROOT.parent / "lab-tape").resolve()
    if p == ROOT.resolve() or ROOT.resolve() in p.parents:
        raise ValueError(f"the tape may not live inside the repository: {p}")
    return p


@contextlib.contextmanager
def single(root: Path) -> Iterator[bool]:
    """True when this process holds the recorder's lock (one recorder at a time)."""
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".lock").open("w") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        yield True


def _sigterm(signum: int, frame: object) -> None:
    TERM.set()


RECORD = ROOT / "research" / "decisions" / "DEC-0060-options-lab-tape-and-execution-measurements.md"


def accepted(path: Path = RECORD) -> bool:
    """DEC-0060 says recording starts only after the record is accepted (its "Order of the work" 5): its status line
    must read ACCEPTED. Until the acceptance pull request reaches the host, the job records nothing."""
    try:
        return "**Status: ACCEPTED" in path.read_text()
    except OSError:
        return False


def close_unfinished(root: Path, today: dt.date, clock: Clock) -> list[str]:
    """Earlier session folders a stop left with no manifest (a crash after the restarts ran out, or the job never
    started again that day): each gets its manifest from its saved state, marked as never finished, so it is
    archived and its loss is counted rather than left behind. Today's folder is the run's own."""
    done = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []:
        if folder.name >= today.isoformat() or (folder / manifest.NAME).exists():
            continue
        try:
            day = dt.date.fromisoformat(folder.name)
            meta = json.loads((folder / "focus.json").read_text()) if (folder / "focus.json").exists() else {}
        except ValueError:
            continue
        names = list(meta.get("names") or [])
        if not names:
            continue
        rec = Recorder(lambda *a: Answer(0, {}, None, 0.0), {}, names, day, folder, clock)
        span = (dt.datetime.combine(day, tiers.close_time(day), NY) - dt.datetime.combine(day, dt.time(9, 30), NY))
        rec.scheduled = math.ceil(span.total_seconds() / rec.settings.tick_s)   # the whole day was due
        rec.stopped = f"never finished: closed by the run of {today.isoformat()}"
        gone = 0 if (folder / AFTER_CLOSE).exists() else \
            PartWriter(folder, "print").discard() + PartWriter(folder, "open_interest").discard()
        rec.finish({**meta, "after_close": {"skipped": "the day was over", "partial_parts_removed": gone}})
        done.append(folder.name)
    return done


def main(argv: Sequence[str] | None = None, clock: Clock | None = None, get: Get | None = None,
         env: Mapping[str, str] | None = None, inline_minute: bool = False, record: Path = RECORD) -> int:
    e = dict(os.environ) if env is None else dict(env)
    ck = clock or WallClock()
    today = ck.now().astimezone(NY).date()
    if not accepted(record):
        print(f"{today}: DEC-0060 is not accepted yet; nothing recorded")
        return 0
    root = tape_root(e)
    rc = _record(e, ck, today, root, get, inline_minute)
    if rc == 0:                              # whatever the day was, finished sessions go to the bucket; a stop exits
        until = None
        if today.isoformat() in tiers.sessions():
            until = dt.datetime.combine(today, tiers.close_time(today), NY).astimezone(dt.UTC) \
                + dt.timedelta(minutes=UPLOAD_DONE_MIN)
        print(f"archive: {archive_today(root, e, ck, until)}")
    return rc


def _record(e: Mapping[str, str], ck: Clock, today: dt.date, root: Path, get: Get | None,
            inline_minute: bool) -> int:
    if today.isoformat() not in tiers.sessions():
        with single(root) as mine:
            if mine:
                for d in close_unfinished(root, today, ck):
                    print(f"{d}: closed, never finished")
        print(f"{today}: not a session")
        return 0

    def at(t: dt.time) -> dt.datetime:
        return dt.datetime.combine(today, t, NY).astimezone(dt.UTC)

    folder = root / today.isoformat()
    close = at(tiers.close_time(today))
    with single(root) as mine:
        if not mine:
            print("another recorder is running", file=sys.stderr)
            return 3
        for d in close_unfinished(root, today, ck):
            print(f"{d}: closed, never finished")
        if (folder / manifest.NAME).exists():
            print(f"{today}: already recorded")
            return 0
        meta = None
        if (folder / "focus.json").exists():                                # a restart: the morning's list
            try:
                meta = json.loads((folder / "focus.json").read_text())
            except ValueError:
                meta = None
        if not isinstance(meta, dict) or not meta.get("names"):
            ck.sleep((at(dt.time(9, 25)) - ck.now()).total_seconds())
            f = focus.read(e)
            desk = desk_names()
            names = [n for n in (f.names if f else ()) if n in desk][:MAX_NAMES]
            meta = {"focus_session": f.session if f else None, "focus_sha256": f.sha256 if f else None,
                    "names": names, "key_pair": e.get("WT_LAB_KEY_PREFIX", "APCA_CLONE"),
                    "focus_read_late": ck.now() > at(dt.time(9, 30))}
            folder.mkdir(parents=True, exist_ok=True)
            if f is None or f.session != today.isoformat() or not names:
                manifest.write(folder, {**meta, "recorded": False, "reason": "no focus list for today"})
                print(f"{today}: no focus list for today; nothing recorded")
                return 0
            manifest.atomic(folder / "focus.json", json.dumps(meta))
        headers = pair_headers(e, str(meta["key_pair"]))
        if headers is None:
            print(f"{meta['key_pair']}: no keys", file=sys.stderr)
            return 2
        limit = int(e.get("WT_LAB_RATE_LIMIT", "1000"))                      # the probe's measured limit
        budget = min(int(e.get("WT_LAB_BUDGET_PER_MIN", str(int(limit * 0.4)))), int(limit * 0.4))
        info = {**meta, "recorder": RECORDER_VERSION, "clock_offset_ms": clock_offset_ms(), "budget_per_min": budget,
                "code": code_version(), "close": close.isoformat()}
        main_thread = threading.current_thread() is threading.main_thread()
        old = signal.signal(signal.SIGTERM, _sigterm) if main_thread else None
        try:
            with requests.Session() as s:
                rec = Recorder(get or http_get(s), headers, list(meta["names"]), today, folder, ck,
                               Settings(budget_per_min=budget), inline_minute=inline_minute)
                rec.save()
                try:
                    rec.run(at(dt.time(9, 30)), close)
                    if rec.stopped == "sigterm" and ck.now() < close:
                        print(f"{today}: stopped from outside; state kept, a restart resumes", file=sys.stderr)
                        return 143                    # no manifest: the session is not over
                except KeyboardInterrupt:
                    rec.flush()
                    raise
                except Exception as ex:  # noqa: BLE001
                    rec.stopped = f"error {ex.__class__.__name__}"
                    rec.flush()
                    if ck.now() < close:
                        raise                         # systemd restarts it and it resumes
                info.update(rec.headroom())           # the session's, before the after-close pull adds to it
                info["after_close"] = after_close(rec, get or http_get(s), headers, at(dt.time(9, 30)), close, ck)
                info["clock_offset_ms_end"] = clock_offset_ms()
                doc = rec.finish(info)
        finally:
            if old is not None:
                signal.signal(signal.SIGTERM, old)
    print(f"{today}: coverage {doc['coverage']:.4f} (fresh {doc['coverage_fresh']:.4f}, {doc['stale_ticks']} stale "
          f"ticks, longest {doc['longest_stale_s']:.0f} s), rows {doc['rows']}, stopped {doc['stopped']}")
    return 0


UPLOAD_MIN = 20                                     # a run on a day without a session
UPLOAD_DONE_MIN = 110                               # DEC-0060 section 2.4: the upload is finished by close plus 110


def archive_today(root: Path, env: Mapping[str, str], clock: Clock, until: dt.datetime | None = None) -> str:
    """Upload every finished session not yet uploaded, then prune verified ones; never fails the recording. On a
    session day it is done by `until` (close plus 110 minutes, inside the deploy gate's blackout); otherwise it has
    `UPLOAD_MIN` minutes."""
    from wt.lab import archive
    store = archive.store_from_env(env)
    if store is None:
        return "no lab bucket credentials: nothing uploaded"
    minutes = UPLOAD_MIN if until is None else min(UPLOAD_MIN + 90.0, (until - clock.now()).total_seconds() / 60)
    if minutes <= 0:
        return "past close plus 110 minutes: the next run uploads"
    try:
        with archive.locked(root):
            bucket, acct = archive.bucket_of(env), env.get("R2_ACCOUNT_ID")
            res = archive.upload_all(root, store, bucket, time.monotonic() + minutes * 60, acct)
            gone = archive.prune(root, store, bucket, keep=10, account=acct)
    except Exception as e:  # noqa: BLE001 (a failed upload is retried by the next run)
        return f"error {e.__class__.__name__}"
    bad = [r["session"] for r in res if not r["verified"]]
    return f"{len(res) - len(bad)} uploaded, {len(bad)} not ({', '.join(bad) or 'none'}), {len(gone)} pruned"


def code_version() -> str | None:
    """The commit the recorder runs from, so a session says which code wrote it."""
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5,
                             check=False)
        return out.stdout.strip() or None if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


if __name__ == "__main__":
    sys.exit(main())
