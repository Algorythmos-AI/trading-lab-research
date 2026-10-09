"""Paper runner for strategy B (intraday momentum): signals on QQQ, orders on QQQM. MODE must be 'paper'.

Safety set (plan rev 7 Step 4, plus the September 2026 audit fixes):
  * paper-only lock (wt.core.safety), asserted by the broker adapter at construction and before every order;
  * a server-side GTC stop at the first fill (OMS); reconcile at startup and on every loop, never touching other
    strategies' orders;
  * the plan is persisted on every transition, so a restart resumes it instead of re-entering (audit C4);
  * the pre-trade guard inside the OMS: allowlist, hard caps, one entry a day, kill file, latch, market hours,
    sell <= position;
  * the virtual US$600 account counts the trade on its first fill and books the close idempotently with the real
    fill price (audit C1). The loss latch survives restarts and file deletion;
  * end of day: marketable limit exit at T-10, *market* exit at T-5 regardless of the quote, flat check at T-2
    (if not flat: GTC stop plus END_OF_DAY_NOT_FLAT for the job runner to alert on) (audit H1);
  * data calls run under a deadline, so a hung request can't stall the exit path;
  * a refusal turns *entries* off, never exit management (phase-2 L1). Disk floor, untrusted virtual account,
    stale macro calendar, blocked or unreadable account, unreadable market calendar or signal inputs, exits-only
    launch: each is journaled as refuse_to_arm (exits_only) and the runner still reconciles, protects and flattens.
    Only a non-paper account stops it outright;
  * a position with no plan today is adopted and exited at the open: a previous session's plan resumes, and a
    position nobody placed becomes an `orphan` plan (never booked to the virtual account) (L1b);
  * a close is booked into the virtual account and journaled as trade_closed exactly once each, whatever crashes
    in between (L2); a close found later (an earlier day's unrecorded plan) is booked at arm;
  * a short is never covered automatically: it pages, and this strategy's sells are cancelled (L5);
  * trading-critical alerts go out during the session through a non-blocking pager (L4);
  * before an entry the local clock is compared with the broker's; a skew over 2 s, or no reading, blocks it.
"""
from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import json
import math
import shutil
import sys
import time
from collections.abc import Callable
from dataclasses import asdict
from typing import Any, TypeVar

import numpy as np
import pandas as pd

from wt.backtest.engine import size_position
from wt.core import ledger
from wt.core.clock import ET, et, to_utc_iso
from wt.core.config import DATA_DIR, ROOT, STATE_DIR, env
from wt.data.alpaca import DATA, AlpacaREST
from wt.oms.manager import ACTIVE_POSITION, OMS, PlanStore, TradePlan
from wt.ops import hc, locks
from wt.ops.alerts import Alerts, Pager
from wt.risk import events
from wt.risk.mandate import out_of_mandate
from wt.risk.pretrade import Context, PreTradeGuard, load_limits
from wt.risk.virtual_account import StateError, VirtualAccount
from wt.signals import setups

SIG, TRADE, STRATEGY = "QQQ", "QQQM", "B"
LIVE = DATA_DIR / "live"
KILL = ROOT / "KILL"
# The earliest the runner arms. The Mac's 22:30 Sydney start is exactly 3 h before the open from 2026-11-01 (AEDT +
# EST); the 15 minutes keep that start from being refused as too early by a few seconds of startup.
ARM_LEAD = dt.timedelta(hours=3, minutes=15)          # while this file exists: no new entries (exits and stops keep being managed)
RISK_PCT, MAX_SPREAD_PCT, STALE_S = 1.0, 0.10, 150
DATA_DEADLINE_S = 15.0        # any single market-data call
MIN_FREE_GB = 3.0
FALLBACK_STOP_PCT = 1.0       # protective stop for a position with no plan on record (then alert)
SKEW_MAX_S = 2.0              # local clock vs broker clock, checked before every entry
CLOCK_MAX_RTT_S = 1.0         # a clock reading that took longer than this says nothing about skew
HELD_EXIT_RETRY_S = 300       # an adopted position that failed to exit is retried at most every 5 minutes
CONNECT_TRIES, CONNECT_WAIT_S = 5, 60.0
RUNNER_LOCK_WAIT_S = 10.0     # how long a starting runner waits for its own process lock
T = TypeVar("T")
_pool = cf.ThreadPoolExecutor(max_workers=4, thread_name_prefix="data")


def log(event: str, **kw: Any) -> bool:
    """Append to the journal, hash-chained and fsynced (wt.core.ledger; plan R3). Every event is fsynced: G2's
    incident rules read many of them, and a session has only tens. Events tied to a plan or trade carry `idem`,
    <id>:<event>, so a reader can drop a replay. Returns whether the line is on disk. Never raises: a full disk must
    not kill a runner that holds a position (H4)."""
    rec: dict[str, Any] = {"ts": dt.datetime.now(dt.UTC).isoformat(), "event": event, **kw}
    ident = kw.get("trade_id") or kw.get("plan_id")
    if ident and "idem" not in rec:
        rec["idem"] = f"{ident}:{event}"
    ok = True
    try:
        line = ledger.append(LIVE / "journal.jsonl", rec, fsync=True)
    except Exception as e:  # noqa: BLE001 — H4: the journal must never take the runner down
        ok = False
        try:
            line = json.dumps(rec, default=str, skipkeys=True)
        except Exception:  # noqa: BLE001 — a circular or odd value: the event name must still reach the log
            line = repr(rec)[:2000]
        _echo(f"JOURNAL WRITE FAILED ({e.__class__.__name__}): {line}", sys.stderr)
    _echo(line, sys.stdout)
    return ok


def _echo(text: str, stream: Any) -> None:
    """Print to the job log, which sits on the same disk: a full disk must not turn a print into a crash (H4)."""
    try:
        print(text, file=stream, flush=True)
    except (OSError, ValueError):
        pass


def with_deadline(fn: Callable[..., T], *args: Any, deadline_s: float = DATA_DEADLINE_S) -> T:
    """Run a data call with a hard deadline. On timeout the caller gets TimeoutError; the loop carries on."""
    return _pool.submit(fn, *args).result(timeout=deadline_s)


class LiveData:
    def __init__(self, a: AlpacaREST):
        self.a = a

    def bars_today(self, sym: str, day: dt.date, feed: str = "iex") -> pd.DataFrame:
        j = self.a.get(f"{DATA}/v2/stocks/bars", {"symbols": sym, "timeframe": "1Min", "feed": feed, "limit": 10000,
                                                  "start": to_utc_iso(et(day, "09:30")), "end": to_utc_iso(dt.datetime.now(ET))})
        df = pd.DataFrame((j.get("bars") or {}).get(sym, []))
        if len(df):
            df["t"] = pd.to_datetime(df.t, utc=True)
        return df

    def quote(self, sym: str) -> tuple[float, float, pd.Timestamp] | None:
        j = self.a.get(f"{DATA}/v2/stocks/quotes/latest", {"symbols": sym, "feed": "iex"})
        q = (j.get("quotes") or {}).get(sym)
        if not q or not q.get("bp") or not q.get("ap"):
            return None                                   # a zero bid/ask is no quote (it once priced an exit at -0.05)
        return (q["bp"], q["ap"], pd.Timestamp(q["t"]))

    def sigma_and_prev_close(self, day: dt.date, sessions: list[dt.date]) -> tuple[float, float | None]:
        """sigma = mean over prior 14 sessions of mean |close(:59/:29 marks)/open - 1| (same as backtest); SIP history.

        A prior session without its bars is left out, so sigma can rest on fewer than 14. `sigma_sessions` keeps
        how many it used, for the journal (DEC-0024, decision 3); the calculation is unchanged."""
        prior = [d for d in sessions if d < day][-14:]
        vals, prev_close = [], None
        self.sigma_sessions = None
        for d in prior:
            b = self.a.bars([SIG], "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, "15:59")), feed="sip")
            if len(b) > 60:
                vals.append(float(np.mean(np.abs(b.c.iloc[29::30].to_numpy() / b.o.iloc[0] - 1))))
                prev_close = float(b.c.iloc[-1])
        if not vals:                                       # no prior session had its bars: np.mean([]) would be NaN
            raise ValueError("no prior session with a full set of bars")
        self.sigma_sessions = len(vals)
        return float(np.mean(vals)), prev_close


def journaled_closes() -> set[str]:
    """Trade ids already journaled as trade_closed (so a restart never journals a close twice)."""
    out: set[str] = set()
    try:
        with open(LIVE / "journal.jsonl") as fh:
            for line in fh:
                if '"trade_closed"' not in line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("event") == "trade_closed" and r.get("trade_id"):
                    out.add(str(r["trade_id"]))
    except OSError:
        pass
    return out


class SafeStore:
    """PlanStore whose failure (a full disk) never stops an order: the plan lives on in memory, and the runner
    turns entries off because a restart could no longer resume it."""

    def __init__(self, store: PlanStore) -> None:
        self.store, self.broken = store, False

    def save(self, p: TradePlan) -> None:
        try:
            self.store.save(p)
        except OSError as e:
            if not self.broken:
                log("persist_failed", file=self.store.path.name, error=e.__class__.__name__)
            self.broken = True


class Books:
    """Books each closed plan into the virtual account and the journal exactly once (audit C1, phase-2 L2).

    Order matters: the account is booked (idempotent by trade id) and saved, then trade_closed is journaled if it
    is missing, then the plan is marked recorded. A crash anywhere in between is repaired by the next call. A failed
    account save or journal write (a full disk) leaves the plan unrecorded, so every later call retries it; while
    the account is unsaved, `flush()` is False and the runner opens nothing (a latch must reach the disk).
    A read-only account (its state could not be trusted) is never booked or saved; the plan stays unrecorded so a
    later, trusted session books it. An orphan's close is journaled but never booked: B did not open it."""

    def __init__(self, va: VirtualAccount, va_path: Any, readonly: bool) -> None:
        self.va, self.va_path, self.readonly = va, va_path, readonly
        self.journaled = journaled_closes()
        self.unsaved = False
        self._save_failing = False
        self._journal_failed = False

    def flush(self) -> bool:
        """Save the account if a booking hasn't reached the disk yet. True when nothing is pending."""
        if self.readonly or not self.unsaved:
            return True
        try:
            self.va.save(self.va_path)
        except OSError as e:
            first = not self._save_failing
            self._save_failing = True
            if first:
                log("account_save_failed", error=e.__class__.__name__)
            return False
        self.unsaved = self._save_failing = False
        return True

    def close(self, plan: TradePlan, oms: OMS, day: dt.date, nxt: dt.date,
              persist: Callable[[TradePlan], None]) -> None:
        if plan.state != "closed" or plan.recorded or not plan.filled_qty:
            return
        px = plan.exit_fill_price
        if px is None:
            try:
                px = plan.exit_fill_price = oms.exit_fill(plan)
            except Exception:  # noqa: BLE001 — retried next loop; the stop price is only a last resort
                px = None
        estimated = px is None
        px = px if px is not None else plan.stop
        entry = plan.avg_entry or 0.0
        attributed = plan.origin == "entry"
        if attributed and not self.readonly:
            if self.va.record_round_trip(day, nxt, cost=plan.filled_qty * entry, proceeds=plan.filled_qty * px,
                                         trade_id=plan.trade_id):
                self.unsaved = True
        saved = self.flush()
        if plan.trade_id not in self.journaled and self._journal_failed:
            self.journaled = journaled_closes()               # a failed write may still have landed: never twice
        if plan.trade_id not in self.journaled:
            r_mult = (px - entry) / (entry - plan.stop) if attributed and entry > plan.stop else None
            written = log("trade_closed", day=day, symbol=plan.symbol, entry=entry, exit=px,
                          exit_price_estimated=estimated, stop=plan.stop, qty=plan.filled_qty, R=r_mult,
                          reason=plan.exit_reason, trade_id=plan.trade_id, origin=plan.origin,
                          booked=attributed and not self.readonly, virtual=None if self.readonly else asdict(self.va))
            if written is not False:                           # only an explicit failure is retried
                self.journaled.add(plan.trade_id)
            else:
                self._journal_failed = True
        if not self.readonly and saved and plan.trade_id in self.journaled:
            plan.recorded = True
            persist(plan)


def measure_skew(broker: Any, clock: Callable[[], dt.datetime], samples: int = 3) -> float | None:
    """Seconds the local clock is ahead of the broker's (negative: behind). Each reading is bracketed by two local
    reads and taken at their midpoint; readings with a round trip over 1 s are discarded; the smallest wins.
    None when no usable reading was possible."""
    best: float | None = None
    for _ in range(samples):
        t0 = clock()
        try:
            c = broker.clock()
        except Exception:  # noqa: BLE001 — an unreadable clock is "unknown", decided by the caller
            continue
        t1 = clock()
        if (t1 - t0).total_seconds() > CLOCK_MAX_RTT_S:
            continue
        skew = ((t0 + (t1 - t0) / 2) - c.timestamp).total_seconds()
        if best is None or abs(skew) < abs(best):
            best = skew
    return best


def times_from_clock(broker: Any, day: dt.date) -> tuple[dt.datetime, dt.datetime] | None:
    """Fallback session open/close from the broker's clock when the market calendar can't be read."""
    try:
        c = broker.clock()
    except Exception:  # noqa: BLE001
        return None
    nxt_close = c.next_close.astimezone(ET)
    if nxt_close.date() != day:
        return None
    if c.is_open:
        return et(day, "09:30"), nxt_close
    nxt_open = c.next_open.astimezone(ET)
    return (nxt_open, nxt_close) if nxt_open.date() == day else None


def next_weekday(d: dt.date) -> dt.date:
    d += dt.timedelta(days=1)
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d


def connect(factory: Callable[[], Any], sleep: Callable[[float], None]) -> Any:
    """Build the broker adapter, retrying network failures. The paper-only lock is never retried."""
    from wt.core.safety import PaperOnlyError
    for attempt in range(CONNECT_TRIES):
        try:
            return factory()
        except PaperOnlyError:
            raise
        except Exception as e:  # noqa: BLE001
            log("broker_connect_failed", attempt=attempt + 1, error=e.__class__.__name__)
            if attempt + 1 == CONNECT_TRIES:
                raise
            sleep(CONNECT_WAIT_S)
    raise RuntimeError("unreachable")


def prior_plans(day: dt.date, keep: int = 10) -> list[tuple[PlanStore, TradePlan]]:
    """Plans from earlier days, most recent first (their files are left where they are)."""
    out: list[tuple[PlanStore, TradePlan]] = []
    files = sorted((f for f in LIVE.glob("plan_*.json") if f.stem[5:15] < day.isoformat()), reverse=True)
    for f in files[:keep]:
        st = PlanStore(f)
        try:
            p = st.load()
        except (OSError, ValueError, TypeError) as e:
            log("plan_unreadable", file=f.name, error=e.__class__.__name__)
            continue
        if p is not None:
            out.append((st, p))
    return out


def run(day: dt.date | None = None, poll_s: float = 20.0, broker: Any = None, rest: Any = None,
        now_fn: Callable[[], dt.datetime] | None = None, sleep_fn: Callable[[float], None] | None = None,
        alerts: Any = None, exits_only: bool | None = None) -> None:
    """broker/rest/now_fn/sleep_fn/alerts are injected by the session simulation tests; production uses the
    defaults. exits_only (default: env WT_EXITS_ONLY=1, set by the job runner after a preflight refusal) turns
    entries off for the session."""
    if env("MODE", "backtest") != "paper":
        raise SystemExit("runner_b refuses to start: MODE must be 'paper'")
    clock = now_fn or (lambda: dt.datetime.now(ET))
    sleep = sleep_fn or time.sleep
    now = clock()
    day = day or now.date()
    production = broker is None
    pager = Pager(alerts if alerts is not None else (Alerts() if production else None))
    try:
        if not production:
            _session(day, poll_s, broker, rest, clock, sleep, pager,
                     exits_only if exits_only is not None else env("WT_EXITS_ONLY", "") == "1")
            return
        # One runner process at a time, whatever launched it: a runner orphaned by a dead jobs.py wrapper still
        # holds this lock, so a second one (a restart, a boot reconcile) refuses instead of double-managing orders.
        # A short wait: `make unkill`/`reset-latch` or the deploy gate may be probing this lock for a moment.
        with locks.job_lock(locks.RUNNER_LOCK, wait_s=RUNNER_LOCK_WAIT_S, poll_s=0.5) as got:
            if not got:
                log("refuse_to_arm", reason="another paper-b runner process is live (runner lock held)")
                pager.once_per_day("paper-b:second-runner", "paper-b: a second runner refused to start",
                                   "Another paper-b runner process holds the runner lock; this one exited without "
                                   "trading.", 4)
                return
            _session(day, poll_s, broker, rest, clock, sleep, pager,
                     exits_only if exits_only is not None else env("WT_EXITS_ONLY", "") == "1")
    finally:
        pager.close()


DECISION_CAP = 40               # decision events per session beyond the would-be signals themselves


def minute_grid(closed: pd.DataFrame, open_dt: dt.datetime) -> pd.DataFrame:
    """The session's closed bars on a full one-minute grid from the open to the newest bar.

    B's half-hour marks are bar positions, which equal minutes since the open only when no minute is missing.
    The IEX feed skips a minute with no trade there, and every later mark then lands on the wrong bar. A missing
    minute becomes a flat bar at the last close with no volume, so it moves neither the price nor the VWAP.
    """
    if not len(closed):
        return closed
    g = closed.drop_duplicates("t", keep="last").set_index("t").sort_index()
    idx = pd.date_range(pd.Timestamp(open_dt).tz_convert("UTC"), g.index[-1], freq="1min")
    if len(idx) == len(g) or not len(idx):
        return g.reset_index()
    g = g.reindex(idx)
    c = g.c.ffill().fillna(g.o.bfill())                      # before the first trade: that bar's open
    for col in ("o", "h", "l"):
        g[col] = g[col].fillna(c)
    g["c"], g["v"] = c, g.v.fillna(0.0)
    return g.rename_axis("t").reset_index()


def outcome_of(signals: list[dict[str, Any]], acted: bool, free_signal: bool, unchecked: bool = False) -> str:
    """One plain answer to "why was there no trade today": traded, no_signal, blocked:<code>, signal_not_acted,
    no_inputs.

    `free_signal` is the loop's own record of a signal with nothing blocking it, so the answer does not depend
    on the decision journal having worked. `unchecked`: the rule was asked on at least one bar and never once had
    its prices (today's bars, sigma, the prior close), so "no signal" would be a claim nobody checked."""
    if acted:
        return "traded"
    if free_signal or any(not s["blockers"] for s in signals):
        return "signal_not_acted"
    if signals:
        return f"blocked:{signals[0]['blockers'][0]}"
    return "no_inputs" if unchecked else "no_signal"


class Decisions:
    """The decision journal (plan v7 A-dec): what B's signal says on each newly closed bar, whatever blocks entries
    (KILL, the shadow role, exits-only). It only reads bars and computes; it never touches the broker, and `sig`, the
    variable that gates the order path, never sees its result. Two hosts on the same code must journal the same
    decisions, which is what the shadow comparison checks.

    A `decision` event is journaled when the signal function returns a signal it had not returned before, and when
    the blocker set changes (capped), so a session stays at tens of fsynced events."""

    def __init__(self, write: Callable[..., None]):
        self.write = write
        self.last_bar: pd.Timestamp | None = None
        self.last_blockers: tuple[str, ...] | None = None
        self.seen: set[int] = set()
        self.signals: list[dict[str, Any]] = []
        self.events = 0
        self.inputs = False
        self.asked = 0
        self.missing_noted = False
        self.marks = 0                  # half-hour marks seen, the only bars the rule can signal on
        self.spread_only_marks = 0      # of those, the ones where the spread check was the only blocker (DEC-0024, 6)

    @property
    def unchecked(self) -> bool:
        """Asked on at least one loop, and the rule's prices were never there."""
        return self.asked > 0 and not self.inputs

    def observe(self, closed: pd.DataFrame, blockers: list[str], sigma: float | None, prev_close: float | None) -> None:
        self.asked += 1
        if not len(closed) or sigma is None or prev_close is None:
            if not self.missing_noted:                     # once a session: the first time the rule could not be asked
                self.missing_noted = True
                self.write("decision_inputs_missing", closed_bars=len(closed), sigma=sigma is not None,
                           prev_close=prev_close is not None)
            return
        self.inputs = True
        bar = pd.Timestamp(closed.t.iloc[-1])
        if bar == self.last_bar:
            return
        self.last_bar = bar
        if len(closed) % 30 == 0 and 30 <= len(closed) <= 390:      # the bar that just closed is a half-hour mark
            self.marks += 1
            self.spread_only_marks += list(blockers) == ["spread_or_no_quote"]
        would = setups.b_intraday_momentum(closed.reset_index(drop=True), sigma, prev_close, include_last=True)
        key = tuple(sorted(blockers))
        base = {"bar": str(bar), "closed_bars": len(closed), "blockers": list(key), "sigma": sigma,
                "prev_close": prev_close}
        if would is not None and would.bar_index not in self.seen:
            self.seen.add(would.bar_index)
            rec = {**base, "would_signal": True, "signal_bar": would.bar_index,
                   "signal_t": str(closed.t.iloc[would.bar_index]), "trigger": would.trigger, "stop": would.stop,
                   "runner_acts": would.bar_index == len(closed) - 1 and not key}
            self.signals.append(rec)
            self.last_blockers = key
            self.write("decision", **rec)
        elif key != self.last_blockers and self.events < DECISION_CAP:
            self.last_blockers = key
            self.events += 1
            self.write("decision", **base, would_signal=False)

    def summary(self) -> None:
        self.write("decision_summary", inputs=self.inputs, asked=self.asked, would_signals=len(self.signals),
                   first=self.signals[0] if self.signals else None, marks=self.marks,
                   spread_only_marks=self.spread_only_marks)


def _session(day: dt.date, poll_s: float, broker: Any, rest: Any, clock: Callable[[], dt.datetime],
             sleep: Callable[[float], None], pager: Pager, exits_only: bool) -> None:
    off: list[str] = []                 # why entries are off for the whole session (exits keep being managed)

    def refuse(reason: str) -> None:
        off.append(reason)
        log("refuse_to_arm", reason=reason, exits_only=True)

    if exits_only:
        refuse("started in exits-only mode after a preflight refusal")
    free_gb = shutil.disk_usage(ROOT).free / 1e9
    if free_gb < MIN_FREE_GB:
        refuse(f"free disk {free_gb:.1f} GB under the {MIN_FREE_GB:.0f} GB floor")
    role = env("WT_ROLE", "primary")
    if broker is None:
        from wt.brokers.alpaca_paper import AlpacaPaperBroker  # asserts the paper-only lock
        broker = connect(AlpacaPaperBroker, sleep)
    if role == "shadow":
        from wt.brokers.shadow import ShadowBroker             # every order call raises
        broker = ShadowBroker(broker)
        refuse("shadow host: this session never places orders")
    elif env("WT_HOST", "") == "systemd":
        # On the VM, trading needs the primary lease: two hosts can never both trade B (ADR 0004).
        from wt.ops import lease
        held = lease.acquire()
        if held.ok:
            log("lease", held=held.reason)
        else:
            refuse(f"primary lease not held: {held.reason}")
            pager.fire("paper-b:lease", "Paper B: no primary lease, entries off",
                       f"{held.reason}. Exits are still managed. See docs/runbooks/oci-host.md.", 4)
    a = rest if rest is not None else AlpacaREST(per_minute=150)
    try:
        acct = broker.account()
        if not acct.is_paper:
            log("refuse_to_arm", reason="account not paper", exits_only=False)
            return                                    # never act on anything that isn't the paper account
        if acct.blocked:
            refuse("account blocked")
    except Exception as e:  # noqa: BLE001
        refuse(f"account unavailable ({e.__class__.__name__})")
    data = LiveData(a)

    # ---- session times: the market calendar, else the broker's clock ----
    sessions: list[dt.date] = []
    try:
        cal = a.calendar((day - dt.timedelta(days=40)).isoformat(), (day + dt.timedelta(days=10)).isoformat())
        if day not in set(cal.date):
            log("no_session", day=day)
            return
        sessions = sorted(cal.date)
        nxt = next(d for d in sessions if d > day)
        row = cal[cal.date == day].iloc[0]
        open_dt, close_dt = et(day, str(row.open)[:5]), et(day, str(row.close)[:5])
    except Exception as e:  # noqa: BLE001
        refuse(f"market calendar unavailable ({e.__class__.__name__})")
        times = times_from_clock(broker, day)
        if times is None:
            log("close_unknown", day=day)
            pager.fire("paper-b:close-unknown", "Paper B: session close unknown",
                       "Neither the market calendar nor the broker clock could be read. Resting GTC stops stay in "
                       "place, but there is no end-of-day exit. Check the account.", 5)
            return
        open_dt, close_dt = times
        nxt = next_weekday(day)
    now = clock()
    if now >= close_dt:
        log("no_session", day=day, reason="started after the close")
        return
    if now < open_dt - ARM_LEAD:
        log("too_early", day=day, reason="started more than 3 h 15 min before the open; the scheduled start will run it")
        return
    flatten_dt, market_dt, verify_dt = (close_dt - dt.timedelta(minutes=m) for m in (10, 5, 2))

    # ---- the virtual account: read-only when it can't be trusted (a default account must never be saved) ----
    va_path = LIVE / "virtual_account.json"
    try:
        va = VirtualAccount.load(va_path)
        va_ok = True
    except StateError as e:
        refuse(str(e))
        va, va_ok = VirtualAccount(), False
    books = Books(va, va_path, readonly=not va_ok)
    chain_flag = STATE_DIR / "evidence" / "chain-broken"      # wt.ops.backup: the evidence can't be trusted
    if chain_flag.exists():
        refuse("evidence hash chain broken (var/evidence/chain-broken): entries off until the owner clears it")
    try:
        if not events.coverage_ok(day):
            refuse("macro calendar < 30 days ahead")
    except Exception as e:  # noqa: BLE001
        refuse(f"macro calendar unreadable ({e.__class__.__name__})")

    # ---- plans: today's, plus any earlier plan still holding (or owing a booking) ----
    stores: dict[str, SafeStore] = {}
    today_store = SafeStore(PlanStore(LIVE / f"plan_{day.isoformat()}.json"))
    plan: TradePlan | None = None
    try:
        plan = today_store.store.load()
    except (OSError, ValueError, TypeError) as e:
        refuse(f"today's plan file is unreadable ({e.__class__.__name__})")
    if plan is not None:
        stores[plan.trade_id] = today_store
    held: TradePlan | None = None            # a position today's plan did not open: exited at the open

    def persist(p: TradePlan) -> None:
        st = stores.get(p.trade_id)
        if st is not None:
            st.save(p)

    guard = PreTradeGuard(load_limits(STRATEGY))

    def context(symbol: str) -> Context:
        return Context(now=clock(),
                       position_qty=sum(p.qty for p in broker.positions() if p.symbol == symbol),
                       open_orders=broker.open_orders(), kill=KILL.exists(), latched=va.latched,
                       session_open=open_dt, session_close=close_dt,
                       entries_today=va.trades_by_day.get(day.isoformat(), 0),
                       orders_today=plan.seq if plan else 0)

    def on_entry(p: TradePlan) -> None:
        if va_ok and va.count_entry(day, p.trade_id):
            va.save(va_path)
            log("entry_filled", trade_id=p.trade_id, qty=p.filled_qty, price=p.avg_entry)

    oms = OMS(broker, guard=guard, context=context, persist=persist, on_entry=on_entry, strategy=STRATEGY,
              sleep=sleep)

    # today's orphans first (a restart must resume them, not adopt the position a second time), then earlier days
    orphan_files = sorted(LIVE.glob(f"plan_{day.isoformat()}_orphan*.json"))
    for f in orphan_files:
        try:
            o = PlanStore(f).load()
        except (OSError, ValueError, TypeError) as e:
            refuse(f"orphan plan file {f.name} is unreadable ({e.__class__.__name__})")
            continue
        if o is not None:
            stores[o.trade_id] = SafeStore(PlanStore(f))
            if o.active and held is None:
                held = o
                log("resumed_orphan", trade_id=o.trade_id, state=o.state)
    for st, p in prior_plans(day):
        stores[p.trade_id] = SafeStore(st)
        if p.state == "closed" and not p.recorded:
            books.close(p, oms, dt.date.fromisoformat(p.date), day, persist)    # a close nobody booked
        elif p.active and held is None:
            held = p
            log("adopted_prior_plan", trade_id=p.trade_id, state=p.state)
    va.roll(day)
    orphan_n = len(orphan_files)

    def holding(p: TradePlan | None) -> bool:
        return p is not None and (p.state in ACTIVE_POSITION or p.state in ("entry_working", "submitting"))

    def adopt_orphan(qty: int, avg: float) -> TradePlan | None:
        """A long position no plan accounts for: take it over so the end-of-day and open exits apply."""
        if not oms.cancel_resting_confirmed(TRADE):              # a fallback stop from reconcile, if any
            log("orphan_adoption_deferred", reason="resting orders not confirmed cancelled")
            return None
        nonlocal orphan_n
        stop = round(avg * (1 - FALLBACK_STOP_PCT / 100), 2)
        o = TradePlan(date=day.isoformat(), strategy=STRATEGY, symbol=TRADE, qty=qty, trigger=avg, limit=avg,
                      stop=stop, target=stop, attempt=orphan_n, filled_qty=qty, avg_entry=avg,
                      state="in_position", entry_counted=True, origin="orphan")
        stores[o.trade_id] = SafeStore(PlanStore(LIVE / f"plan_{day.isoformat()}_orphan{orphan_n}.json"))
        orphan_n += 1
        persist(o)
        oms.ensure_stop(o)
        log("adopted_orphan", trade_id=o.trade_id, qty=qty, stop=stop)
        pager.fire("paper-b:orphan", "Paper B adopted a position it did not open",
                   f"{TRADE} x{qty} had no plan. It is protected by a stop and will be exited at the open "
                   "(or at once if the session is under way).", 4)
        return o

    def check_positions(positions: list[Any]) -> None:
        for sym, qty, legacy in out_of_mandate([(p.symbol, p.qty) for p in positions], guard.limits.allowlist):
            if not legacy:
                log("out_of_mandate", symbol=sym, qty=qty)
                pager.once_per_day(f"paper-b:out-of-mandate:{sym}", "Position outside strategy B's mandate",
                                   f"The paper account holds {sym} x{qty}. The runner never touches it. Close it in "
                                   "the Alpaca UI, or record it in config/legacy_positions.yaml.", 3)

    def page_reconcile(acts: list[str]) -> None:
        bad = [x for x in acts if any(k in x for k in ("UNKNOWN", "SHORT", "UNPROTECTED"))]
        if bad:
            pager.fire("paper-b:unknown-position", "Paper B: position needs attention", "; ".join(bad)[:300], 5)

    # ---- startup: adopt, reconcile and protect before anything that could fail (L1) ----
    try:
        positions = broker.positions()
        check_positions(positions)
        q = sum(p.qty for p in positions if p.symbol == TRADE)
        if q > 0 and not holding(held) and not holding(plan):
            avg = next(p.avg_price for p in positions if p.symbol == TRADE)
            held = adopt_orphan(q, avg) or held
    except Exception as e:  # noqa: BLE001
        log("startup_positions_error", error=repr(e)[:300])

    def holder() -> TradePlan | None:
        return held if holding(held) else plan

    def fallback_stops() -> dict[str, float]:
        h = holder()
        if h is not None and h.active:
            return {}
        return {p.symbol: round(p.avg_price * (1 - FALLBACK_STOP_PCT / 100), 2) for p in broker.positions()
                if p.symbol == TRADE and p.qty > 0}

    try:
        acts = oms.reconcile({TRADE}, fallback_stops(), plan=holder())
        if acts:
            log("reconcile_startup", actions=acts)
            page_reconcile(acts)
        if plan is not None:
            books.close(plan, oms, day, nxt, persist)          # a close that happened while we were down (C4)
    except Exception as e:  # noqa: BLE001
        log("startup_reconcile_error", error=repr(e)[:300])

    sigma: float | None = None
    prev_close: float | None = None
    if not off:
        try:
            sigma, prev_close = with_deadline(data.sigma_and_prev_close, day, sessions, deadline_s=180.0)
        except Exception as e:  # noqa: BLE001
            refuse(f"signal inputs unavailable ({e.__class__.__name__})")
    dec_sigma, dec_prev_close = sigma, prev_close          # the decision journal's inputs, even with entries off
    if off and sessions:
        try:
            dec_sigma, dec_prev_close = with_deadline(data.sigma_and_prev_close, day, sessions, deadline_s=180.0)
        except Exception as e:  # noqa: BLE001 — informational only: it never refuses and never blocks exits
            log("decision_inputs_unavailable", error=e.__class__.__name__)
    decisions = Decisions(log)
    kill_on = KILL.exists()
    log("armed", day=day, sigma=sigma, prev_close=prev_close, sigma_sessions=getattr(data, "sigma_sessions", None),
        flatten=flatten_dt, kill=kill_on,
        resumed_plan=plan.state if plan else None, held=held.trade_id if held else None, entries_off=off,
        skew_s=measure_skew(broker, clock), virtual=asdict(va) if va_ok else None)
    held_try = dt.datetime.min.replace(tzinfo=ET)
    short_paged = False
    acted = plan is not None                               # an entry was placed today (now or before a restart)
    free_signal = False                                    # a signal fired with nothing blocking it
    open_pinged = False

    while True:
        now = clock()
        if now < open_dt:
            sleep(min(60, (open_dt - now).total_seconds()))
            continue
        if now >= close_dt:
            break
        if not open_pinged:                   # the healthchecks "armed" check: the loop reached the open
            open_pinged = True
            hc.ping_async("wt-paper-b-armed", "", f"armed at the open; kill={kill_on} entries_off={len(off)}")
        try:
            if KILL.exists() != kill_on:
                kill_on = not kill_on
                log("kill_state", on=kill_on)
            for p in (plan, held):
                if p is not None and p.active:
                    oms.sync(p)
                    books.close(p, oms, day, nxt, persist)
            acts = oms.reconcile({TRADE}, fallback_stops(), plan=holder())
            if acts:
                log("reconcile", actions=acts)
                page_reconcile(acts)
            try:
                q = with_deadline(data.quote, TRADE)
            except (TimeoutError, cf.TimeoutError):
                q = None
                log("data_timeout", what="quote")
            last_mid = (q[0] + q[1]) / 2 if q else None
            # ---- a position today's plan did not open: exit it at the open (retried every 5 minutes) ----
            if held is not None and held.state in ACTIVE_POSITION and now < verify_dt and \
                    (now - held_try).total_seconds() >= HELD_EXIT_RETRY_S:
                held_try = now
                oms.exit_now(held, None, reason="adopted_exit", market=True)
                books.close(held, oms, day, nxt, persist)
            # ---- exits ----
            if plan is not None and plan.state in ACTIVE_POSITION:
                if now >= verify_dt:
                    pass                                   # T-2: handled below (verify flat)
                elif now >= market_dt:
                    oms.exit_now(plan, None, reason="eod_market", market=True)
                elif now >= flatten_dt:
                    if q:
                        oms.exit_now(plan, round(q[0] - 0.02, 2), reason="eod_flatten")
                    else:
                        oms.exit_now(plan, None, reason="eod_flatten", market=True)
                elif last_mid and last_mid >= plan.target and q:
                    oms.exit_now(plan, round(q[0] - 0.01, 2), reason="target")
                books.close(plan, oms, day, nxt, persist)
            if now >= market_dt:
                qty = oms._stable_position(TRADE)
                h = holder()
                if qty > 0 and not holding(h):
                    held = adopt_orphan(qty, next(p.avg_price for p in broker.positions() if p.symbol == TRADE))
                    h = held
                if qty > 0 and h is not None and h.state in ACTIVE_POSITION and now >= verify_dt:
                    oms.exit_now(h, None, reason="eod_verify", market=True)
                    books.close(h, oms, day, nxt, persist)
                elif qty > 0 and h is not None and h is held and h.state in ACTIVE_POSITION:
                    oms.exit_now(h, None, reason="eod_market", market=True)
                    books.close(h, oms, day, nxt, persist)
                elif qty < 0 and not short_paged:
                    short_paged = True
                    cancelled = oms.cancel_resting(TRADE)       # this strategy's sells would deepen the short
                    log("short_position", qty=qty, cancelled=cancelled)
                    pager.fire("paper-b:not-flat", "Paper B is SHORT",
                               f"{TRADE} x{qty}. This account must never be short. This strategy's sell orders were "
                               "cancelled; nothing is bought back automatically. Follow the not-flat runbook.", 5)
            if plan is not None and plan.state == "entry_working" and now >= et(day, "15:30"):
                oms.cancel_entry_remainder(plan)
            # ---- entries (at most one per day; never while any exposure exists) ----
            if plan is None and now < flatten_dt - dt.timedelta(minutes=20):
                blockers = [f"entries_off:{r}" for r in off]
                if today_store.broken or any(st.broken for st in stores.values()):
                    blockers.append("plan_not_persisted")
                if not books.flush():
                    blockers.append("account_not_persisted")
                if kill_on:
                    blockers.append("kill_file")
                if va.latched:
                    blockers.append(f"latched:{va.latch_reason}")
                if va.trades_by_day.get(day.isoformat(), 0) >= 1:
                    blockers.append("max_1_trade_per_day")
                if any(p.symbol == TRADE and p.qty for p in broker.positions()):
                    blockers.append("exposure_exists")
                pol, ev = events.policy(now)
                if pol in ("skip", "blackout"):
                    blockers.append(f"event:{pol}:{ev}")
                try:
                    bars = with_deadline(data.bars_today, SIG, day)
                except (TimeoutError, cf.TimeoutError):
                    bars = pd.DataFrame()
                closed = bars[bars.t <= pd.Timestamp(now) - pd.Timedelta(minutes=1)] if len(bars) else bars
                closed = minute_grid(closed, open_dt)
                if not len(closed) or (pd.Timestamp(now) - closed.t.iloc[-1]).total_seconds() > STALE_S:
                    blockers.append("stale_signal_data")
                if not q or (q[1] - q[0]) / ((q[0] + q[1]) / 2) * 100 > MAX_SPREAD_PCT:
                    blockers.append("spread_or_no_quote")
                sig = None if blockers else setups.b_intraday_momentum(closed.reset_index(drop=True), sigma, prev_close,
                                                                       include_last=True)
                try:
                    decisions.observe(closed, blockers, dec_sigma, dec_prev_close)
                except Exception as e:  # noqa: BLE001 — the journal of what B would do must never disturb what it does
                    log("decision_error", error=repr(e)[:200])
                if sig and sig.bar_index == len(closed) - 1:          # only act on the bar that just closed
                    free_signal = True
                    skew = measure_skew(broker, clock)
                    if skew is None or abs(skew) > SKEW_MAX_S:
                        log("clock_skew", skew_s=skew, max_s=SKEW_MAX_S, action="entry skipped")
                        pager.fire("paper-b:clock-skew", "Paper B skipped an entry: clock check failed",
                                   "The local clock is more than 2 s off the broker's, or the broker clock could "
                                   "not be read." if skew is None else
                                   f"The local clock is {skew:+.1f} s off the broker's (limit 2 s).", 4)
                        sig = None
                    else:
                        pager.resolve("paper-b:clock-skew", "Paper B clock check: ok", "Clock skew is back in range.")
                if sig and sig.bar_index == len(closed) - 1:
                    sq = with_deadline(data.quote, SIG)
                    ratio = last_mid / ((sq[0] + sq[1]) / 2) if sq and last_mid else None
                    if ratio:
                        trig = math.ceil(sig.trigger * ratio * 100) / 100
                        stop = math.floor(sig.stop * ratio * 100) / 100
                        R = trig - stop
                        risk = va.equity * RISK_PCT / 100 * (0.5 if pol == "reduce" else 1.0)
                        qty = size_position(trig, stop, risk, va.settled_cash, va.equity)
                        if qty >= 1 and R > 0:
                            plan = TradePlan(date=day.isoformat(), strategy=STRATEGY, symbol=TRADE, qty=qty,
                                             trigger=trig, limit=round(trig + 0.1 * R, 2), stop=stop,
                                             target=round(trig + 2 * R, 2))
                            stores[plan.trade_id] = today_store
                            today_store.save(plan)
                            oms.place_entry(plan)
                            acted = acted or plan.state == "entry_working"
                            log("entry_placed" if plan.state == "entry_working" else "entry_not_placed",
                                trigger=trig, stop=stop, target=plan.target, qty=qty, ratio=ratio, policy=pol,
                                state=plan.state, detail=plan.log[-1:] if plan.log else None)
                        else:
                            log("signal_skipped_size", qty=qty, R=R)
                    else:
                        log("signal_skipped_no_quote", signal_quote=bool(sq), trade_mid=bool(last_mid))
                elif blockers and now.minute in (0, 30) and now.second < poll_s:
                    log("blocked", blockers=blockers)
        except Exception as e:  # noqa: BLE001 — never crash with an open position; log and keep protecting
            log("loop_error", error=repr(e)[:300])
        sleep(poll_s)

    # ---- after the close ----
    try:
        qty = sum(p.qty for p in broker.positions() if p.symbol == TRADE)
        h = holder()
        if qty > 0:
            if h is not None and h.state in ACTIVE_POSITION:
                oms.ensure_stop(h)                       # GTC stop keeps protecting overnight
            log("END_OF_DAY_NOT_FLAT", qty=qty, plan=h.log if h else None)
            pager.fire("paper-b:not-flat", "Paper B NOT FLAT at the close",
                       f"{TRADE} x{qty} is still open after the close. A GTC stop protects it overnight; the next "
                       "session exits it at the open. Check the broker.", 5)
        elif qty < 0:
            cancelled = oms.cancel_resting(TRADE)        # never cover automatically; sells would deepen it
            log("END_OF_DAY_NOT_FLAT", qty=qty, short=True, cancelled=cancelled)
            pager.fire("paper-b:not-flat", "Paper B is SHORT at the close",
                       f"{TRADE} x{qty}. Nothing is bought back automatically. Follow the not-flat runbook.", 5)
        else:
            cancelled = oms.cancel_resting(TRADE)        # flat: no GTC stop may outlive the position
            if cancelled:
                log("cancelled_resting_after_close", orders=cancelled)
        for p in (plan, held):
            if p is not None:
                books.close(p, oms, day, nxt, persist)
    except Exception as e:  # noqa: BLE001
        log("END_OF_DAY_NOT_FLAT", error=f"could not verify flat after the close: {e!r}"[:300])
        pager.fire("paper-b:not-flat", "Paper B could not verify flat after the close",
                   "The broker could not be read after the close. Check the account.", 5)
    decisions.summary()
    outcome = outcome_of(decisions.signals, acted, free_signal, decisions.unchecked)
    if outcome == "signal_not_acted":
        pager.fire("paper-b:signal-not-acted", "Paper B had a signal and did not act",
                   "A signal fired with nothing blocking it and no entry was placed. Read the session's journal "
                   "(clock_skew, signal_skipped_size, signal_skipped_no_quote, entry_not_placed) before the next "
                   "session.", 4)
    if outcome == "no_inputs":
        pager.once_per_day("paper-b:no-inputs", "Paper B could not check its signal today",
                   "The prices the rule needs (today's bars, sigma or the prior close) were missing for the whole "
                   "session, so it never ran. This is a data fault, not a quiet market. Read decision_inputs_missing "
                   "and refuse_to_arm in the session's journal.", 4)
    log("session_end", virtual=asdict(va) if va_ok else None, entries_off=off, outcome=outcome)


if __name__ == "__main__":
    run()
