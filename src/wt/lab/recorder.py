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
import datetime as dt
import fcntl
import json
import math
import os
import resource
import shutil
import signal
import subprocess
import sys
import threading
import time
import zoneinfo
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import requests

from wt.core.config import ROOT, STATE_DIR
from wt.lab import focus, manifest, tiers
from wt.lab.probe import DATA_HOST, Answer, Get, chain, desk_names, http_get, pair_headers
from wt.lab.tape import PartWriter, option_fields, quote_fields
from wt.options.chain import parse_occ

NY = zoneinfo.ZoneInfo("America/New_York")
BATCH = 100
MAX_NAMES = 6                                       # config/options_clone.yaml names.max_names
CHANGE_KEY = ("bid", "ask", "bid_size", "ask_size", "quote_ts", "last", "last_size", "last_ts", "volume")
STATE = "state.json"


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


class Clock(Protocol):
    def now(self) -> dt.datetime: ...
    def sleep(self, seconds: float) -> None: ...


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
    inline_minute: bool = False                     # tests: run the minute's work on the main thread

    def __post_init__(self) -> None:
        self.names = list(self.names)[:MAX_NAMES]
        self.lock = threading.RLock()
        self.option = PartWriter(self.folder, "option")
        self.stock = PartWriter(self.folder, "stock")
        self.gap = PartWriter(self.folder, "gap")
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
        self.counts = {"requests": 0, "taken": 0, "expected": 0, "ticks_run": 0, "restarts": 0, "errors": 0}
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
        self.counts.update({k: int(v) for k, v in (s.get("counts") or {}).items() if k in self.counts})
        self.counts["restarts"] += 1

    def save(self) -> None:
        with self.lock:
            doc = {"names": list(self.names), "tier1": self.tier1, "tier2": sorted(self.tier2),
                   "selected": sorted(self.selected),
                   "opening": sorted(self.opening) if self.opening is not None else None,
                   "opening_missing": self.opening_missing, "freeze_tick": self.freeze_tick, "counts": self.counts}
            manifest.atomic(self.folder / STATE, json.dumps(doc))

    # ------------------------------------------------------------ requests, within the budget
    def _t(self) -> float:
        return self.clock.now().timestamp()

    def room(self, n: int = 1) -> bool:
        with self.lock:
            t = self._t()
            while self.sent and t - self.sent[0] >= 60:
                self.sent.popleft()
            low = (self.reading is not None and t - self.reading[1] < self.settings.reading_lasts_s
                   and self.reading[0] < self.settings.back_off_share)
            return not low and len(self.sent) + n <= self.settings.budget_per_min

    def send(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
        with self.lock:
            self.sent.append(self._t())
            self.counts["requests"] += 1
        a = self.get(url, params, headers, timeout)
        hl = {k.lower(): v for k, v in a.headers.items()}
        try:
            share = int(hl["x-ratelimit-remaining"]) / max(1, int(hl["x-ratelimit-limit"]))
            with self.lock:
                self.reading = (share, self._t())
        except (KeyError, ValueError):
            pass
        return a

    def guarded(self, url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> Answer:
        """`send`, but refusing when the session must stop or the budget is spent (used page by page)."""
        if self.should_stop() is not None or not self.room(1):
            raise Stop("budget or stop")
        return self.send(url, params, headers, timeout)

    def _gap(self, tick: int, stream: str, reason: str) -> None:
        with self.lock:
            self.gap.add({"recv_ns": time.time_ns(), "tick": tick, "stream": stream, "reason": reason[:80]})

    # ------------------------------------------------------------ writing
    def _write(self, writer: PartWriter, key: str, row: Mapping[str, Any]) -> None:
        k = tuple(row.get(c) for c in CHANGE_KEY)
        with self.lock:
            if self.last.get(key) == k:
                return
            self.last[key] = k
            writer.add(row)

    def stocks(self, tick: int) -> None:
        if not self.room(1):
            self._gap(tick, "stock", "budget")
            return
        a = self.send(f"{DATA_HOST}/v2/stocks/snapshots", {"symbols": ",".join(self.names), "feed": "sip"},
                      self.headers, self.settings.timeout_s)
        if a.status != 200 or not isinstance(a.body, dict):
            self._gap(tick, "stock", f"status {a.status}")
            return
        now, t = time.time_ns(), self._t()
        for name, snap in a.body.items():
            if name not in self.tier1 or not isinstance(snap, Mapping):
                continue
            row = quote_fields(snap)
            bid, ask, last = row["bid"], row["ask"], row["last"]
            if isinstance(bid, float) and isinstance(ask, float) and 0 < bid <= ask:
                self.mids[name] = ((bid + ask) / 2, t)
            elif isinstance(last, float) and last > 0:
                self.mids[name] = (last, t)
            self._write(self.stock, f"stock:{name}", {"recv_ns": now, "tick": tick, "symbol": name, **row})

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
            with self.lock:
                room = self.rules.t1_max_per_name - len(self.tier1[name])
                self.tier1[name] += tiers.cap_tier1(new1, mid, self.rules)[:max(0, room)]
                in1 = set(self.tier1[name])
                self.tier2 |= {s for s, ask in asks.items() if s not in in1
                               and tiers.tier(s, ask, mid, self.day, self.rules, self.cal) in (1, 2)}
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

    def sweep(self, symbols: Iterable[str], tier: int, tick: int, reserve: int = 0) -> None:
        """One sweep in batches of 100, each budgeted on its own; `reserve` requests are left for tier 1."""
        syms = sorted(symbols)
        batches = [syms[i:i + BATCH] for i in range(0, len(syms), BATCH)]
        go: list[list[str]] = []
        for b in batches:
            if self.should_stop() is None and self.room(len(go) + 1 + reserve):
                go.append(b)
        if len(go) < len(batches):
            self._gap(tick, f"tier{tier}", f"budget {len(batches) - len(go)} batches")

        def one(b: list[str]) -> tuple[list[str], Answer, int]:
            a = self.send(f"{DATA_HOST}/v1beta1/options/snapshots", {"symbols": ",".join(b), "feed": "opra"},
                          self.headers, self.settings.timeout_s)
            return b, a, time.time_ns()

        with cf.ThreadPoolExecutor(max_workers=self.settings.workers) as pool:
            answers = list(pool.map(one, go))
        missing = 0
        for b, a, recv in answers:
            snaps = a.body.get("snapshots") if a.status == 200 and isinstance(a.body, dict) else None
            if not isinstance(snaps, Mapping):
                self._gap(tick, f"tier{tier}", f"status {a.status}")
                continue
            for sym in b:
                snap = snaps.get(sym)
                if not isinstance(snap, Mapping):
                    missing += 1
                    continue
                if tier == 1 and self.opening is not None and sym in self.opening:
                    with self.lock:
                        self.counts["taken"] += 1
                self._write(self.option, sym, {"recv_ns": recv, "tick": tick, "tier": tier, "symbol": sym,
                                               **option_fields(snap)})
        if missing:
            self._gap(tick, f"tier{tier}", f"missing {missing}")

    def tier1_now(self) -> set[str]:
        with self.lock:
            return {s for v in self.tier1.values() for s in v}

    def minute_work(self, tick: int) -> None:
        try:
            self.select(tick)
            with self.lock:
                t2 = set(self.tier2)
            reserve = 2 * math.ceil(len(self.tier1_now()) / BATCH) + 1        # the next tier-1 sweep and stocks
            self.sweep(t2, 2, tick, reserve)
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
            for w in (self.option, self.stock, self.gap):
                w.flush()
        self.save()
        self.last_flush = self._t()

    def one_tick(self, tick: int, pool: cf.ThreadPoolExecutor) -> None:
        ok = True
        steps: tuple[Callable[[], None], ...] = (
            lambda: self.sweep(self.tier1_now(), 1, tick),
            lambda: self.stocks(tick))
        for step in steps:
            try:
                step()
            except Exception as e:  # noqa: BLE001 (one bad answer costs one tick, not the session)
                ok = False
                self._gap(tick, "tick", f"error {e.__class__.__name__}")
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

    def run(self, start: dt.datetime, end: dt.datetime) -> None:
        tick_s = self.settings.tick_s
        scheduled = max(0, math.ceil((end - start).total_seconds() / tick_s))
        self.clock.sleep((start - self.clock.now()).total_seconds())
        tick = max(0, math.ceil((self.clock.now() - start).total_seconds() / tick_s))   # resume: from now
        self.scheduled, self.first_tick = scheduled, tick
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
                if self._t() - self.last_flush >= self.settings.flush_every_s:
                    self.flush()
                due = start + dt.timedelta(seconds=(tick + 1) * tick_s)
                behind = (self.clock.now() - due).total_seconds()
                skipped = int(behind // tick_s) if behind > 0 else 0
                if skipped:
                    self._gap(tick, "session", f"late, {skipped} ticks skipped")
                tick += 1 + skipped
                self.clock.sleep((start + dt.timedelta(seconds=tick * tick_s) - self.clock.now()).total_seconds())
            if self.minute is not None:
                self.minute.result()
        self.flush()

    def expected(self) -> int:
        """Samples due: the opening set at every tick after the freeze up to the close, whether or not it ran (a
        stop, an outage or a restart is missed coverage, never a smaller denominator)."""
        if self.opening is None or self.freeze_tick is None:
            return 0
        return len(self.opening) * max(0, self.scheduled - self.freeze_tick - 1)

    def finish(self, info: Mapping[str, Any]) -> dict[str, Any]:
        self.flush()
        c = {**self.counts, "expected": self.expected()}
        return manifest.write(self.folder, {
            **info, "recorded": True, "names": list(self.names), "opening_tier1": sorted(self.opening or ()),
            "opening_missing": self.opening_missing,
            "opening_complete": self.opening is not None and not self.opening_missing,
            "freeze_tick": self.freeze_tick, "tier1_final": sum(len(v) for v in self.tier1.values()),
            "tier2_final": len(self.tier2), "ticks_run": c["ticks_run"], "samples_expected": c["expected"],
            "samples_taken": c["taken"], "coverage": round(c["taken"] / c["expected"], 6) if c["expected"] else 0.0,
            "requests": c["requests"], "restarts": c["restarts"], "tick_errors": c["errors"],
            "stopped": self.stopped,
            "rows": {"option": self.option.written, "stock": self.stock.written, "gap": self.gap.written},
        })


AFTER_CLOSE_MIN = 90                                # DEC-0060 section 2.4: stop by close plus 90 minutes


def after_close(rec: Recorder, get: Get, headers: Mapping[str, str], start: dt.datetime, close: dt.datetime,
                clock: Clock) -> dict[str, Any]:
    """The day's prints for every tier-1 contract and the open interest of every recorded contract, into the session
    folder, by close plus 90 minutes."""
    from wt.lab import afterclose
    left = (close + dt.timedelta(minutes=AFTER_CLOSE_MIN) - clock.now()).total_seconds()
    if left <= 0:
        return {"skipped": "past close plus 90 minutes"}
    deadline = time.monotonic() + left
    with rec.lock:
        t1 = sorted({s for v in rec.tier1.values() for s in v})
        every = set(t1) | set(rec.tier2)
    pw, ow = PartWriter(rec.folder, "print"), PartWriter(rec.folder, "open_interest")
    end = min(close, clock.now())                    # a session stopped early asks only for what has happened
    out: dict[str, Any] = {"prints": afterclose.prints(get, headers, t1, start, end, pw, rec.gap, deadline)}
    expiries = [o.expiry for s in every if (o := parse_occ(s)) is not None]
    if expiries:
        out["open_interest"] = afterclose.open_interest(get, headers, list(rec.names), min(expiries), max(expiries),
                                                        every, ow, rec.gap, deadline)
    pw.flush()
    ow.flush()
    return out


def clock_offset_ms() -> float | None:
    """The host clock's offset from chrony, in milliseconds, or None when chrony cannot be read."""
    try:
        out = subprocess.run(["chronyc", "-c", "tracking"], capture_output=True, text=True, timeout=5, check=False)
        return round(abs(float(out.stdout.split(",")[4])) * 1000, 3) if out.returncode == 0 else None
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


def main(argv: Sequence[str] | None = None, clock: Clock | None = None, get: Get | None = None,
         env: Mapping[str, str] | None = None, inline_minute: bool = False, record: Path = RECORD) -> int:
    e = dict(os.environ) if env is None else dict(env)
    ck = clock or WallClock()
    today = ck.now().astimezone(NY).date()
    if not accepted(record):
        print(f"{today}: DEC-0060 is not accepted yet; nothing recorded")
        return 0
    if today.isoformat() not in tiers.sessions():
        print(f"{today}: not a session")
        return 0

    def at(t: dt.time) -> dt.datetime:
        return dt.datetime.combine(today, t, NY).astimezone(dt.UTC)

    root = tape_root(e)
    folder = root / today.isoformat()
    close = at(tiers.close_time(today))
    with single(root) as mine:
        if not mine:
            print("another recorder is running", file=sys.stderr)
            return 3
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
        info = {**meta, "clock_offset_ms": clock_offset_ms(), "budget_per_min": budget}
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
                info["after_close"] = after_close(rec, get or http_get(s), headers, at(dt.time(9, 30)), close, ck)
                doc = rec.finish(info)
        finally:
            if old is not None:
                signal.signal(signal.SIGTERM, old)
    print(f"{today}: coverage {doc['coverage']:.4f}, rows {doc['rows']}, stopped {doc['stopped']}")
    print(f"archive: {archive_today(root, e, close, ck)}")
    return 0


UPLOAD_DONE_MIN = 110                               # DEC-0060 section 2.4: the upload is finished by close plus 110


def archive_today(root: Path, env: Mapping[str, str], close: dt.datetime, clock: Clock) -> str:
    """Upload every finished session not yet uploaded, then prune verified ones; never fails the recording."""
    from wt.lab import archive
    store = archive.store_from_env(env)
    if store is None:
        return "no lab bucket credentials: nothing uploaded"
    left = (close + dt.timedelta(minutes=UPLOAD_DONE_MIN) - clock.now()).total_seconds()
    if left <= 0:
        return "past close plus 110 minutes: the next run uploads"
    try:
        res = archive.upload_all(root, store, env.get("WT_LAB_BUCKET", "wt-lab-tape"), time.monotonic() + left)
        gone = archive.prune(root, keep=10)
    except Exception as e:  # noqa: BLE001 (a failed upload is retried by the next run)
        return f"error {e.__class__.__name__}"
    bad = [r["session"] for r in res if not r["verified"]]
    return f"{len(res) - len(bad)} uploaded, {len(bad)} not ({', '.join(bad) or 'none'}), {len(gone)} pruned"


if __name__ == "__main__":
    sys.exit(main())
