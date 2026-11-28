"""Paper runner for Gap Hunter, the stock desk (DEC-0066, where it is "sleeve S"). MODE must be 'paper'.

One US$600 virtual book (HYP-0069) and three rules, of which a session runs one: the one listed in `S.switched_on`
of config/risk.yaml (`session_trial`). With none or more than one listed, no entry is placed.

  HYP-0070  the reversal rule on a universe known at scan time (the first slice; paused by the owner).
  HYP-0071  Gap Hunter (DEC-0068): one trade a day in the primary name of the 09:25 pool. See "Gap Hunter" below.
  HYP-0072  Gap Hunter with rotation (DEC-0076): the same entries, in the best-ranked tier-2 name with a valid order.

What it shares with the retired QQQ rule's runner (wt.live.runner_b; DEC-0069): four pure helpers it imports, and
nothing at run time. Its own paper account and key pair (APCA_S_KEY_ID, APCA_S_SECRET_KEY), journal
(data/live/smallcap_journal.jsonl), plans and state (var/smallcap/), kill file (var/smallcap/KILL; the root KILL,
which stops every desk, is read too), strategy tag (S) and process lock. It never reads or writes
data/live/plan_*.json, data/live/journal.jsonl or the QQQ rule's virtual account: those are an archive.

It refuses to start without its own key pair, and never falls back to APCA_API_*. It reads no other pair, so it does
not matter what APCA_API_* holds: since DEC-0069 no job trades on that pair, and it may come to hold this desk's own
keys (the market-data jobs read it). It places no entry while DEC-0066 does not read ACCEPTED, or while any of the
session gates below is closed. A refusal turns entries off, never exit management.

On the host (job `paper-s`, WT_HOST=systemd) it trades only while it holds its own primary lease (`wt-leases/paper-s`,
wt.ops.lease): without it entries are off and exits are still managed. On a shadow host (WT_ROLE=shadow) every order
call raises (wt.brokers.shadow) and entries are off for the session. A console checkout takes no lease.

Each poll, in this order: the plan in play is synced with the broker and booked if it closed; orders and positions
are reconciled and protected; the universe is rescanned on each five-minute mark; newly closed bars are read; a
resting entry is cancelled when the simulation would not have filled it; an open position is exited at its target,
at the stagnation stop, or at the end of the day; and only then, with nothing in play, a fresh signal may become an
order.

Entry gates (each one is journaled with the signal it blocked): the record's status, the kill file, the stop-rule
latch, the day stop (three losers in a row, or -2R realised), the day's entry and order counts, an open position or
working order, a plan or account that could not be saved, a spread that is unknown or over US$0.05, a quote older
than the limit, a newest bar that is not the minute just ended (no print: treated as halted), a clock more than 2 s
off the broker's, a size of zero, and cash that has not settled.

Phone pages go out during the session through a non-blocking pager (wt.ops.alerts.Pager), keys `paper-s:*`: refused
to start (key pair), a second runner, no lease, the session's close unknown, the stop rule, a position
adopted, a position over the hard caps, a short, a clock-skew block, and not flat (or not verified flat) after the
close. A page is fixed words and guarded counts: never a symbol, a price, an amount or an error's text; the journal
row written just before it holds those. The `armed` row says whether this session pages.

Gap Hunter (HYP-0071). The two rules share everything above: arming, the gates, the book, the day stop, the stop
rule, reconciliation, the end of the day, the pages. What differs:

  the name     At the first poll at or after the open the day's pool (data/candidates_live/<day>.parquet, with
               data/pm_bars_live/<day>.parquet, saved by the pre-market routine at 09:25) goes through `wt.scanner.gap_hunter.select`; its primary is the only
               name traded. No pool, a pool not dated today, or no name through the filters: no entry this
               session, journaled (`gap_primary`), and exits are still managed. There is no rotation to rank 2.
  the entry    Each minute, once its bars are read, `wt.live.setups_live` says which order each registered gap
               entry (e1..e4) wants resting. Only the lowest trigger rests. It is replaced, after a confirmed
               cancel, when that changes; an order valid for one bar is cancelled when its minute ends. Every
               order sent has passed the spread must and the collar check at that moment, and is its own plan
               with its own block of order ids. Re-pricing stops at GAP_ENTRY_ORDERS_MAX orders.
  one attempt  The first closed bar that reaches the trigger of the order that should be resting spends the day,
               whether or not anything rested or filled (`gap_day_done`: traded, no_fill, missed, no_signal,
               order_budget). A fill is the day's one trade.
  the exit     The registered gap exit through wt.oms.multi: half off when the bid is at or over the first target
               (a limit at the target's price), the stop to breakeven, the stagnation stop before that target,
               then the stop trailed under each completed five-minute low, out on a five-minute close under EMA9,
               and out after a breakout bar without volume. R is booked against the stop the trade entered with.
  a restart    The primary, the spent attempt and the refused signals are read back from the journal; the plan,
               its rule code and the exit's state from the plan file. Nothing is chosen or attempted twice.
  rotation     When HYP-0072 is the trial (DEC-0076), the names are the tier-2 names of the same selection (ranks
               1 to 4, journaled once as `gap_names`), and each minute `rotation_walk` says which one order rests:
               of the names whose own lowest valid order exists, the best-ranked. The desk's one resting order
               follows it, in that name, replaced after a confirmed cancel (`rotation_live` rows); the first closed
               bar in the resting name to reach its trigger spends the day. Everything else (gates, spread must,
               collar, size, exit, 11:00, one trade a day, the book) is HYP-0071's. The shadow does not run then.
  the shadow   DEC-0076 (HYP-0072, EXP-0054) runs beside HYP-0071, journal only (`rotation_shadow`): each minute, the
               order of the best-ranked tier-2 name that has a valid one, a row when that changes, and the first
               closed bar in that name to reach it (whether the engine fills it, the NBBO read when it began to
               rest, the spread must). It reads its own bars, places, cancels and changes no order, computes no
               R, P&L or exit, and ends with its attempt or at 11:00. `session_end` carries its counts.

The journal names a gap rule by its code and never by a setup's name; no headline or catalyst category is read into
it. DEC-0068's note of 2026-11-20 lists the readings this mode had to choose, for the owner to confirm.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import shutil
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, field, fields, replace
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from wt.backtest.engine import size_position
from wt.core import ledger
from wt.core.clock import ET, et, to_utc_iso
from wt.core.config import CONFIG_DIR, DATA_DIR, ROOT, STATE_DIR, env
from wt.data.alpaca import DATA
from wt.live import scan_s
from wt.live import setups_live as sl
from wt.live.runner_b import measure_skew, target_exit_limit, times_from_clock, with_deadline
from wt.oms.manager import ACTIVE_POSITION, PlanStore, TradePlan
from wt.oms.multi import MultiOMS, MultiPlan
from wt.ops import alerts as page
from wt.ops import locks
from wt.ops.alerts import Alerts, Pager
from wt.risk import execution_stops, stop_rule
from wt.risk.pretrade import Context, PreTradeGuard, load_limits
from wt.risk.virtual_account import StateError, VirtualAccount
from wt.signals.musts import spread_ok

OMS = MultiOMS                  # the order manager of both rules: the base manager, plus selling in parts
STRATEGY = "S"
DIR = STATE_DIR / "smallcap"
PLANS = DIR / "plans"
KILL = DIR / "KILL"
ROOT_KILL = ROOT / "KILL"          # the master switch: `make kill` with no DESK stops every desk, this one too
VA_PATH = DIR / "virtual_account.json"
JOURNAL = DATA_DIR / "live" / "smallcap_journal.jsonl"
RECORD = ROOT / "research" / "decisions" / "DEC-0066-robot-b-sleeve-s-paper-desk.md"
RUNNER_LOCK = locks.RUNNER_LOCK_S          # "paper-s-runner": the deploy gate reads it too
KEY_ID, KEY_SECRET = "APCA_S_KEY_ID", "APCA_S_SECRET_KEY"

RISK_PCT = 1.0                  # of the virtual account's equity, per trade (DEC-0066 section 3)
DAY_STOP_LOSERS = 3             # entries stop for the day after this many losers in a row ...
DAY_STOP_R = -2.0               # ... or at this much realised R
MAX_OPEN_POSITIONS = 1          # until the order manager can protect several plans
SKEW_MAX_S = 2.0
SETTLE_S = 5.0                  # a minute bar is read this long after its minute ended
MIN_FREE_GB = 3.0
FALLBACK_STOP_PCT = 1.0         # protective stop for a position no plan accounts for
HELD_EXIT_RETRY_S = 300         # an adopted position that failed to exit is retried at most every 5 minutes
ARM_LEAD = dt.timedelta(hours=3, minutes=15)
LOOP_ERROR_PAGE_POLLS = 3       # polls in a row that end in loop_error before the owner is paged
QUOTE_OUTAGE_PAGE_S = 120       # seconds of failed quote reads for an open position before the owner is paged
ENTRY_CUTOFF_MIN = 30           # no new entry in the last half hour before the close
SEQ_BLOCK = 1000                # each plan's order ids come from its own block of sequence numbers (see plan_seq)
BAR_PAGES = 20
CONNECT_TRIES, CONNECT_WAIT_S = 5, 15.0
RUNNER_LOCK_WAIT_S = 10.0       # how long a starting runner waits for its own process lock

# ---- Gap Hunter (HYP-0071, DEC-0068) ----
POOL_DIR = DATA_DIR / "candidates_live"     # the 09:25 pool, saved before the open by the pre-market routine
PM_BARS_DIR = DATA_DIR / "pm_bars_live"     # (wt.scanner.pool: LIVE_POOL_DIR, LIVE_PM_BARS_DIR)
PM_FROM = "04:00"
GAP_ENTRY_ORDERS_MAX = 40       # entry orders a day; the rest of S.max_orders_per_day (60) is left to the exit
STOP_MOVE_TRIES = 3             # a stop the broker will not take at one price is not asked for a fourth time
# the journal rows the execution stops read (wt.risk.execution_stops, DEC-0073)
X_EVENTS = frozenset({"short_position", "END_OF_DAY_NOT_FLAT", "unprotected", "gap_primary", "gap_names",
                      "entry_filled", "trade_closed"})


# ---- journal ------------------------------------------------------------------------------------------------------
_WATCH: list[Callable[[dict[str, Any]], None]] = []    # the session's readers of its own rows (DEC-0073); run() clears it


def killed() -> bool:
    """Are new entries stopped by a kill file: Gap Hunter's own (var/smallcap/KILL) or the root KILL, which stops
    every desk. A check that fails raises: the poll is a loop error (paged after three in a row) and enters nothing."""
    return KILL.exists() or ROOT_KILL.exists()


def log(event: str, **kw: Any) -> bool:
    """Append to sleeve S's own journal, hash-chained and fsynced. Never raises: a full disk must not kill a runner
    that holds a position. Returns whether the line is on disk."""
    rec: dict[str, Any] = {"ts": dt.datetime.now(dt.UTC).isoformat(), "event": event, **kw}
    ident = kw.get("trade_id")
    if ident:
        rec["idem"] = f"{ident}:{event}"
    ok = True
    try:
        line = ledger.append(JOURNAL, rec, fsync=True)
    except Exception as e:  # noqa: BLE001 — the journal must never take the runner down
        ok = False
        try:
            line = json.dumps(rec, default=str, skipkeys=True)
        except Exception:  # noqa: BLE001
            line = repr(rec)[:2000]
        _echo(f"JOURNAL WRITE FAILED ({e.__class__.__name__}): {line}", sys.stderr)
    _echo(line, sys.stdout)
    for watch in list(_WATCH):
        try:
            watch(rec)
        except Exception as e:  # noqa: BLE001 — a reader of the journal must never take the runner down
            _echo(f"JOURNAL READER FAILED ({e.__class__.__name__})", sys.stderr)
    return ok


def _echo(text: str, stream: Any) -> None:
    try:
        print(text, file=stream, flush=True)
    except (OSError, ValueError):
        pass


def journal_rows() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        with open(JOURNAL) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(r, dict):
                    out.append(r)
    except OSError:
        pass
    return out


# ---- the record, the keys, the book -------------------------------------------------------------------------------
def accepted(path: Path | None = None) -> bool:
    """DEC-0066 takes effect when its status line reads ACCEPTED. An unreadable record is not an accepted one."""
    try:
        return "**Status: ACCEPTED" in (path or RECORD).read_text()
    except OSError:
        return False


def switched_on(path: Path | None = None) -> frozenset[str]:
    """The trials sleeve S may trade: `S.switched_on` in config/risk.yaml. DEC-0066 section 2: a registered rule
    trades only once a dated note in that record switches it on, and the list is where the code reads it. A missing
    or unreadable list is an empty one: nothing trades by default."""
    import yaml
    try:
        cfg = yaml.safe_load((path or CONFIG_DIR / "risk.yaml").read_text())
        return frozenset(str(x) for x in (cfg.get(STRATEGY, {}).get("switched_on") or []))
    except Exception:  # noqa: BLE001 — unknown is "nothing switched on"
        return frozenset()


def session_trial(on: frozenset[str]) -> tuple[str, str | None]:
    """(the trial this session runs, why it may place no entry or None). The desk trades one rule a session: the
    one that is switched on. With none switched on it runs the reversal rule with entries off, as it did before
    Gap Hunter existed; with more than one, the first of them (Gap Hunter, then its rotation, then the reversal
    rule) with entries off, because nothing says which of them the day's one position belongs to."""
    known = [t for t in (sl.GAP_TRIAL, sl.ROTATION_TRIAL, sl.TRIAL) if t in on]
    if len(known) == 1:
        return known[0], None
    if known:
        return known[0], f"{' and '.join(known)} are {'both' if len(known) == 2 else 'all'} switched on: " \
                         "the desk trades one rule a session"
    return sl.TRIAL, f"{sl.TRIAL} is not switched on (config/risk.yaml S.switched_on; DEC-0066 section 2)"


def key_refusal(environ: Mapping[str, str]) -> str | None:
    """Why the environment may not run the stock desk, or None: it needs both of its own keys. It never falls back
    to another pair, and it does not look at one: APCA_API_* may hold anything, this desk's own pair included."""
    kid, secret = environ.get(KEY_ID, "").strip(), environ.get(KEY_SECRET, "").strip()
    if not kid or not secret:
        return f"{KEY_ID} and {KEY_SECRET} are not both set"
    return None


class SleeveAccount(VirtualAccount):
    """The US$600 virtual book with T+1 settled cash. Sleeve S's limits are the ones DEC-0066 gives it (the day
    stop, and the stop rule that latches through `latch`), so the QQQ rule's own loss latches do not apply."""

    def check_limits(self, today: dt.date) -> None:
        return None


def day_state(rows: list[dict[str, Any]], day: dt.date) -> tuple[int, float, int]:
    """(losers in a row, realised R, closed trades) for the day, from the journal: a restart rebuilds the day stop
    from what is on disk. A trade with no real exit price counts as a loser of unknown size (R taken as -1)."""
    run, total, n, seen = 0, 0.0, 0, set()
    for r in rows:
        if r.get("event") != "trade_closed" or r.get("origin", "entry") != "entry" or str(r.get("day")) != day.isoformat():
            continue
        tid = str(r.get("trade_id"))
        if tid in seen:
            continue
        seen.add(tid)
        x = r.get("R")
        x = float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else -1.0
        n, total = n + 1, total + x
        run = run + 1 if x < 0 else 0
    return run, total, n


def day_stopped(run: int, total: float) -> str | None:
    if run >= DAY_STOP_LOSERS:
        return f"{run} losers in a row"
    if total <= DAY_STOP_R + 1e-9:
        return f"{total:+.2f}R realised"
    return None


def detector_curve() -> np.ndarray:
    """The time-of-day curve the registered detector reads (wt.scanner.intraday), the same file the batch run and
    the forward test use. It is never rebuilt here: a machine without the file does not trade the rule."""
    from wt.scanner import intraday
    if not intraday.CURVE_FILE.exists():
        raise FileNotFoundError(intraday.CURVE_FILE.name)
    return intraday.volume_curve()


# ---- market data ---------------------------------------------------------------------------------------------------
class Data:
    """Every market-data read sleeve S makes, all from the consolidated tape (DEC-0064): no other feed, no fallback."""

    def __init__(self, a: Any, clock: Callable[[], dt.datetime]) -> None:
        self.a, self.clock = a, clock

    def symbols(self) -> list[str]:
        return scan_s.tradable_symbols(self.a.assets("active"))

    def snapshots(self, symbols: list[str]) -> dict[str, Any]:
        return scan_s.fetch_snapshots(self.a, symbols)

    def minute_bars(self, symbols: list[str], start: dt.datetime) -> dict[str, pd.DataFrame]:
        """1-minute bars from `start` to now for each symbol that has any, every page."""
        out: dict[str, list[dict[str, Any]]] = {}
        for i in range(0, len(symbols), 200):
            params: dict[str, Any] = {"symbols": ",".join(symbols[i:i + 200]), "timeframe": "1Min", "feed": "sip",
                                      "limit": 10000, "start": to_utc_iso(start), "end": to_utc_iso(self.clock())}
            for _ in range(BAR_PAGES):
                j = self.a.get(f"{DATA}/v2/stocks/bars", params)
                for sym, rows in (j.get("bars") or {}).items():
                    out.setdefault(sym, []).extend(rows)
                token = j.get("next_page_token")
                if not token:
                    break
                params["page_token"] = token
            else:
                raise RuntimeError("minute bars: more pages than the cap")
        frames = {}
        for sym, rows in out.items():
            df = pd.DataFrame(rows)
            if len(df):
                df["t"] = pd.to_datetime(df.t, utc=True)
                frames[sym] = df[["t", "o", "h", "l", "c", "v"]].drop_duplicates("t", keep="last") \
                    .sort_values("t").reset_index(drop=True)
        return frames

    def prior_session(self, symbols: list[str], prev: dt.date, close: str) -> dict[str, pd.DataFrame]:
        """The prior session's regular-hours minute bars, on today's share basis (split-adjusted to now)."""
        b = self.a.bars(symbols, "1Min", to_utc_iso(et(prev, "09:30")), to_utc_iso(et(prev, close)), feed="sip",
                        adjustment="split")
        if not len(b):
            return {}
        if "symbol" not in b:
            b = b.assign(symbol=symbols[0])
        return {str(s): g.sort_values("t").reset_index(drop=True) for s, g in b.groupby("symbol")}

    def daily_volumes(self, symbols: list[str], day: dt.date) -> dict[str, list[float]]:
        """Each symbol's daily volumes over the sessions before `day`, oldest first, split-adjusted to now."""
        b = self.a.bars(symbols, "1Day", to_utc_iso(et(day - dt.timedelta(days=45), "00:00")),
                        to_utc_iso(et(day, "00:00")), feed="sip", adjustment="split")
        if not len(b):
            return {}
        if "symbol" not in b:
            b = b.assign(symbol=symbols[0])
        return {str(s): [float(v) for v in g.sort_values("t").v] for s, g in b.groupby("symbol")}

    def quote(self, sym: str) -> tuple[float, float, pd.Timestamp] | None:
        j = self.a.get(f"{DATA}/v2/stocks/quotes/latest", {"symbols": sym, "feed": "sip"})
        q = (j.get("quotes") or {}).get(sym)
        if not q or not q.get("bp") or not q.get("ap"):
            return None
        bid, ask = float(q["bp"]), float(q["ap"])
        if bid <= 0 or ask < bid:
            return None
        return bid, ask, pd.Timestamp(q["t"])


# ---- plans ----------------------------------------------------------------------------------------------------------
@dataclass
class GapPlan(MultiPlan):
    """A Gap Hunter plan: one resting entry of one registered gap rule, and, once it fills, the day's trade. It
    sells in parts and moves its stop (wt.oms.multi), and carries what a restart needs to go on."""
    kind: str = "gap"
    code: str = ""                  # which registered entry the order belongs to: e1..e4, never a setup's name
    signal_t: str = ""              # start of the bar the order was decided on
    expires: str = ""               # when the resting entry is cancelled if it has not filled
    spread: float = 0.0             # the spread at the decision
    bv: str = ""                    # the breakout-volume check the fill carries ("1m", "5m" or none)
    wt: dict[str, Any] = field(default_factory=dict)      # the exit's memory between bars (wt.live.setups_live.WTState)


def load_plan(f: Path) -> TradePlan:
    """A plan file as the class that wrote it: a Gap Hunter plan keeps its own fields across a restart."""
    raw: dict[str, Any] = json.loads(f.read_text())
    cls: type[TradePlan] = GapPlan if raw.get("kind") == "gap" else TradePlan
    known = {x.name for x in fields(cls)}
    return cls(**{k: v for k, v in raw.items() if k in known})


class Store:
    """One plan file per trade under var/smallcap/plans/. A failed save never stops an order: the plan lives on in
    memory and entries turn off, because a restart could no longer resume it."""

    def __init__(self) -> None:
        self.broken = False

    @staticmethod
    def path(trade_id: str) -> Path:
        return PLANS / f"{trade_id}.json"

    def save(self, p: TradePlan) -> None:
        try:
            PlanStore(self.path(p.trade_id)).save(p)
        except OSError as e:
            if not self.broken:
                log("persist_failed", trade_id=p.trade_id, error=e.__class__.__name__)
            self.broken = True

    def load_all(self) -> list[TradePlan]:
        out = []
        for f in sorted(PLANS.glob("*.json")) if PLANS.exists() else []:
            try:
                p = load_plan(f)
            except (OSError, ValueError, TypeError) as e:
                log("plan_unreadable", file=f.name, error=e.__class__.__name__)
                self.broken = True
                continue
            out.append(p)
        return out


def plan_seq(attempt: int) -> int:
    """Where a new plan's order sequence starts. An order id is made from the date, the strategy, the symbol, the
    leg and the sequence number (wt.core.ids), and a new plan would otherwise start at 0 like the one before it: a
    second attempt in the same name on the same day would send the first attempt's entry id again, and the broker
    refuses a repeated id. Found on 2026-11-20 by the order smoke test on the paper account."""
    return max(int(attempt), 0) * SEQ_BLOCK


def orders_sent(p: TradePlan) -> int:
    """How many orders a plan has sent: its sequence number without the block it started from."""
    return p.seq % SEQ_BLOCK


def staged_note(s: sl.Staged) -> list[Any]:
    return ["staged", s.signal_t.isoformat(), s.expires_at.isoformat(), s.attempt, s.spread, s.target]


def staged_of(p: TradePlan) -> sl.Staged | None:
    """The staged entry a plan was made from, read back from the plan's own log (so a restart can still judge it)."""
    if isinstance(p, GapPlan):
        try:
            signal_t = pd.Timestamp(p.signal_t)
            if not p.signal_t or pd.isna(signal_t):
                return None
            return sl.Staged(p.symbol, p.attempt, signal_t, p.trigger, p.limit, p.initial_stop, 0.0,
                             dt.datetime.fromisoformat(p.expires), float(p.spread))
        except (TypeError, ValueError):
            return None
    for row in p.log:
        if isinstance(row, list) and len(row) == 6 and row[0] == "staged":
            try:
                return sl.Staged(p.symbol, int(row[3]), pd.Timestamp(row[1]), p.trigger, p.limit, p.stop,
                                 float(row[5]), dt.datetime.fromisoformat(row[2]), float(row[4]))
            except (TypeError, ValueError):
                return None
    return None


# ---- Gap Hunter: the day's primary -------------------------------------------------------------------------------------
def gap_selection(day: dt.date, open_dt: dt.datetime,
                  symbol: str | None = None) -> tuple[str | None, dict[str, Any] | None, dict[str, Any]]:
    """(the primary, what the gap entries read about it, counts for the journal). The 09:25 pool of `day` through
    `wt.scanner.gap_hunter.select`. No primary, with the reason under "why", when the pool is missing, unreadable,
    not of this session, or leaves no name. `symbol`: the primary already journaled today (a restart): it is not
    chosen again, only looked up. Nothing here reads a price after 09:30, and no headline or category leaves it."""
    from wt.scanner import gap_hunter
    from wt.specs.loader import load_spec
    f = POOL_DIR / f"{day}.parquet"
    if not f.exists():
        return None, None, {"why": "pool_missing"}
    try:
        pool = pd.read_parquet(f)
    except Exception as e:  # noqa: BLE001 — unreadable is "no pool"
        return None, None, {"why": "pool_unreadable", "error": e.__class__.__name__}
    if not len(pool) or "symbol" not in pool:
        return None, None, {"why": "pool_empty"}
    if "date" not in pool or any(str(d)[:10] != day.isoformat() for d in pool["date"]):
        return None, None, {"why": "pool_stale"}                # a pool that does not say it is today's is not today's
    info: dict[str, Any] = {}
    if symbol is None:
        try:
            sel = gap_hunter.select(pool, load_spec("SPEC-0001"))
        except Exception as e:  # noqa: BLE001 — a spec or a pool the rule cannot read selects nothing
            return None, None, {"why": "selection_failed", "error": e.__class__.__name__}
        info = {"kept": sel["kept"], "passed": sel["passed"], "tier1": len(sel["tier1"]), "tier2": len(sel["tier2"])}
        symbol = sel["primary"]
        if symbol is None:
            return None, None, {"why": "no_name_passed", **info}
    rows = pool[pool["symbol"] == symbol]
    if len(rows) != 1:
        return None, None, {"why": "pool_changed", **info}
    pm = pd.DataFrame(columns=["t", "o", "h", "l", "c", "v"])
    pmf = PM_BARS_DIR / f"{day}.parquet"
    if pmf.exists():                                           # a missing file is no pre-market bars, as in the batch run
        try:
            allpm = pd.read_parquet(pmf)
            mine = allpm[allpm["symbol"] == symbol].copy()
            mine["t"] = pd.to_datetime(mine["t"], utc=True)
        except Exception as e:  # noqa: BLE001
            return None, None, {"why": "pm_bars_unreadable", "error": e.__class__.__name__, **info}
        lo, hi = pd.Timestamp(et(day, PM_FROM)), pd.Timestamp(open_dt)
        if len(mine) and ((mine["t"] < lo) | (mine["t"] >= hi)).any():
            return None, None, {"why": "pm_bars_stale", **info}   # a bar of another day, or of the session itself
        pm = mine.sort_values("t")[["t", "o", "h", "l", "c", "v"]].reset_index(drop=True)
    return symbol, sl.gap_context(rows.iloc[0].to_dict(), pm), {"rank": 1, "pm_bars": len(pm), **info}


# ---- the rotation shadow (DEC-0076, HYP-0072, EXP-0054): journal only -----------------------------------------------------
ROTATION_TRIAL = sl.ROTATION_TRIAL


def rotation_tier2(day: dt.date) -> tuple[list[tuple[int, str]], dict[str, Any]]:
    """([(rank, symbol)] of Tier 2, counts for the journal): the 09:25 pool of `day` through
    `wt.scanner.gap_hunter.select`, read as HYP-0071 reads it. Nothing after 09:30 changes the names or their order."""
    from wt.scanner import gap_hunter
    from wt.specs.loader import load_spec
    f = POOL_DIR / f"{day}.parquet"
    if not f.exists():
        return [], {"why": "pool_missing"}
    try:
        pool = pd.read_parquet(f)
        if not len(pool) or "symbol" not in pool:
            return [], {"why": "pool_empty"}
        if "date" not in pool or any(str(d)[:10] != day.isoformat() for d in pool["date"]):
            return [], {"why": "pool_stale"}
        sel = gap_hunter.select(pool, load_spec("SPEC-0001"))
    except Exception as e:  # noqa: BLE001 — a pool or a spec the rule cannot read gives no names
        return [], {"why": "selection_failed", "error": e.__class__.__name__}
    return [(int(r["rank"]), str(r["symbol"])) for r in sel["tier2"]], {}


@dataclass
class Rotation:
    """The shadow's day: which tier-2 order would rest each minute, and the day's one attempt. It places nothing.

    `next_k`: the next minute to decide. `rest`: (rank, symbol, order) decided for the minute before `next_k`, whose
    bar has not been read yet. `nbbo`: the quote at the resting order's decision: read when it changed live, and
    again each live minute while a one-bar order rests (the desk sends those afresh each minute); after a restart,
    the one its journaled change row holds (`known`, by minute), else unknown."""
    names: list[tuple[int, str, dict[str, Any]]]
    next_k: pd.Timestamp
    rest: tuple[int, str, sl.GapOrder] | None = None
    key: str = ""
    nbbo: list[float] | None = None
    done: str = ""
    changes: int = 0
    rank_minutes: dict[str, int] = field(default_factory=dict)
    attempt: dict[str, Any] | None = None
    known: dict[str, list[float] | None] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        """Counts only, for `session_end`: no price, no R, no P&L."""
        a = self.attempt or {}
        return {"names": len(self.names), "changes": self.changes, "rank_minutes": dict(sorted(self.rank_minutes.items())),
                "done": self.done, "attempt": self.attempt is not None, "attempt_rank": a.get("rank"),
                "engine_fill": a.get("engine_fill"), "spread_ok": a.get("spread_ok")}


def rotation_key(rest: tuple[int, str, sl.GapOrder] | None) -> str:
    if rest is None:
        return ""
    trig, stop = sl.gap_cents(rest[2])
    return f"{rest[1]}|{rest[2].code}|{trig:.2f}|{stop:.2f}"


def rotation_resting(names: list[tuple[int, str, dict[str, Any]]], bars: Mapping[str, pd.DataFrame],
                     k: pd.Timestamp) -> tuple[int, str, sl.GapOrder] | None:
    """The order that would rest during minute `k`: of the names whose own order is valid (`gap_choose` of its
    `gap_orders`, from its bars closed before `k`), the one with the best rank."""
    local = k.tz_convert(ET)
    now_min = local.hour * 60 + local.minute
    for rank, sym, ctx in sorted(names, key=lambda x: x[0]):
        b = bars.get(sym)
        if b is None or not len(b):
            continue
        b = b[b.t < k].reset_index(drop=True)
        o = sl.gap_choose(sl.gap_orders(b, ctx, now_min)) if len(b) else None
        if o is not None:
            return rank, sym, o
    return None


def rotation_walk(rot: Rotation, bars: Mapping[str, pd.DataFrame], upto: pd.Timestamp) -> list[dict[str, Any]]:
    """Walk the shadow forward to minute `upto` (every bar before it closed): decide each minute's resting order,
    and read each decided minute's bar in the resting name for the attempt. Returns the rows to journal: a change of
    the resting order ("change") and the day's end ("attempt" or "done"). Deterministic, so a restart walks the
    morning again to the same state. Reads no bar after the attempt."""
    out: list[dict[str, Any]] = []
    one = pd.Timedelta(minutes=1)
    while not rot.done:
        k = rot.next_k
        prev = k - one
        if rot.rest is not None:
            if prev >= upto:
                break                                          # its bar has not closed yet
            rank, sym, order = rot.rest
            b = bars.get(sym)
            row = b[b.t == prev] if b is not None and len(b) else None
            if row is not None and len(row) and float(row.h.iloc[0]) >= order.trigger:
                trig, stop = sl.gap_cents(order)
                q = rot.nbbo
                rot.attempt = {"rank": rank, "symbol": sym, "code": order.code, "trigger": trig, "stop": stop,
                               "bar": prev, "engine_fill": sl.engine_entry(order, float(row.o.iloc[0]),
                                                                           sl.MIN_SLIP) is not None,
                               "nbbo": q, "spread_ok": spread_ok(q[1] - q[0] if q else None)}
                rot.done = "attempt"
                out.append({"kind": "attempt", **rot.attempt})
                break
        if k > upto:
            break
        local = k.tz_convert(ET)
        if local.hour * 60 + local.minute >= sl.GAP_LAST_MINUTE:
            rot.done = "no_attempt"
            out.append({"kind": "done"})
            break
        new = rotation_resting(rot.names, bars, k)
        key = rotation_key(new)
        if key != rot.key:
            rot.key = key
            rot.changes += 1
            rot.nbbo = rot.known.get(k.isoformat())
            row2: dict[str, Any] = {"kind": "change", "minute": k, "rank": new[0] if new else None,
                                    "symbol": new[1] if new else None}
            if new is not None:
                trig, stop = sl.gap_cents(new[2])
                row2.update(code=new[2].code, trigger=trig, stop=stop)
            out.append(row2)
        if new is not None:
            r = str(new[0])
            rot.rank_minutes[r] = rot.rank_minutes.get(r, 0) + 1
        rot.rest = new
        rot.next_k = k + one
    return out


# ---- the session ---------------------------------------------------------------------------------------------------
def run(day: dt.date | None = None, poll_s: float = 10.0, broker: Any = None, rest: Any = None,
        now_fn: Callable[[], dt.datetime] | None = None, sleep_fn: Callable[[float], None] | None = None,
        environ: Mapping[str, str] | None = None, alerts: Any = None) -> None:
    """broker, rest, now_fn, sleep_fn and alerts are injected by the replay tests; production builds them from the
    desk's own keys. A run with an injected broker pages only through `alerts`."""
    if env("MODE", "backtest") != "paper":
        raise SystemExit("runner_s refuses to start: MODE must be 'paper'")
    pager = Pager(alerts if alerts is not None else (Alerts() if broker is None else None))
    try:
        _start(day, poll_s, broker, rest, now_fn, sleep_fn, environ, pager)
    finally:
        _WATCH.clear()
        pager.close()                                         # also on a refusal: its page is still delivered


def _start(day: dt.date | None, poll_s: float, broker: Any, rest: Any, now_fn: Callable[[], dt.datetime] | None,
           sleep_fn: Callable[[float], None] | None, environ: Mapping[str, str] | None, pager: Pager) -> None:
    e = os.environ if environ is None else environ
    why = key_refusal(e)
    if why:
        log("refuse_to_start", reason=why)
        pager.once_per_day("paper-s:refused-keys", "Gap Hunter refused to start: key pair",
                           "The stock desk's own key pair is missing; the session's journal (refuse_to_start) "
                           "names the keys. No order was sent and nothing is managed. See the position alerts "
                           "runbook.", 4)
        raise SystemExit(f"runner_s refuses to start: {why}")
    clock = now_fn or (lambda: dt.datetime.now(ET))
    sleep = sleep_fn or time.sleep
    day = day or clock().date()
    if broker is not None:
        _session(day, poll_s, broker, rest, clock, sleep, pager)
        return
    with locks.job_lock(RUNNER_LOCK, wait_s=RUNNER_LOCK_WAIT_S, poll_s=0.5) as got:
        if not got:
            log("refuse_to_start", reason="another paper-s runner process is live (runner lock held)")
            pager.once_per_day("paper-s:second-runner", "paper-s: a second runner refused to start",
                               "Another paper-s runner process holds the runner lock; this one exited without "
                               "trading.", 4)
            return
        from wt.brokers.alpaca_paper import AlpacaPaperBroker    # asserts the paper-only lock
        from wt.data.alpaca import AlpacaREST
        broker = _connect(lambda: AlpacaPaperBroker(key_id=e[KEY_ID], secret=e[KEY_SECRET]), sleep)
        rest = AlpacaREST(per_minute=150, key_id=e[KEY_ID], secret=e[KEY_SECRET])
        _session(day, poll_s, broker, rest, clock, sleep, pager)


def _connect(factory: Callable[[], Any], sleep: Callable[[float], None]) -> Any:
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


def _session(day: dt.date, poll_s: float, broker: Any, rest: Any, clock: Callable[[], dt.datetime],
             sleep: Callable[[float], None], pager: Pager) -> None:
    off: list[str] = []                 # why entries are off for the whole session (exits keep being managed)

    def refuse(reason: str) -> None:
        off.append(reason)
        log("refuse_to_arm", reason=reason, exits_only=True)

    if not accepted():
        refuse("DEC-0066 does not read ACCEPTED")
    trial, why_not = session_trial(switched_on())
    gap = trial in sl.GAP_TRIALS         # Gap Hunter's day (HYP-0071 or HYP-0072); otherwise the reversal rule's
    rotate = trial == ROTATION_TRIAL     # DEC-0076: the day's name is the best-ranked tier-2 name with a valid order
    if why_not:
        refuse(why_not)
    role = env("WT_ROLE", "primary")
    lease_state = "none"                # a console checkout takes no lease
    if role == "shadow":
        from wt.brokers.shadow import ShadowBroker             # every order call raises
        broker = ShadowBroker(broker)
        lease_state = "shadow"
        refuse("shadow host: this session never places orders")
    elif env("WT_HOST", "") == "systemd":
        # On the host, trading needs sleeve S's own primary lease: two hosts can never both trade it (ADR 0004).
        from wt.ops import lease
        got = lease.acquire(key=lease.KEY_S)
        if got.ok:
            lease_state = "held"
            log("lease", held=got.reason)
            pager.resolve("paper-s:lease", "Sleeve S: primary lease held", "The lease is held again; entries are on.")
        else:
            lease_state = "refused"
            refuse(f"primary lease not held: {got.reason}")
            pager.fire("paper-s:lease", "Sleeve S: no primary lease, entries off",
                       "The lease was not held; the session's journal (refuse_to_arm) says why. Exits are still "
                       "managed. See the backups and lease runbook.", 4)
    free_gb = shutil.disk_usage(ROOT).free / 1e9
    if free_gb < MIN_FREE_GB:
        refuse(f"free disk {free_gb:.1f} GB under the {MIN_FREE_GB:.0f} GB floor")
    try:
        acct = broker.account()
        if not acct.is_paper:
            log("refuse_to_arm", reason="account not paper", exits_only=False)
            pager.once_per_day("paper-s:not-paper", "Sleeve S stopped: not a paper account",
                               "The broker did not say the account is a paper account, so the session ended at "
                               "once: nothing was ordered and nothing is managed. Check the key pair.", 5)
            return                                    # never act on anything that isn't the paper account
        if acct.blocked:
            refuse("account blocked")
    except Exception as e:  # noqa: BLE001
        refuse(f"account unavailable ({e.__class__.__name__})")
    data = Data(rest, clock)

    # ---- session times: the market calendar, else the broker's clock ----
    prev: dt.date | None = None
    prev_close = "16:00"
    try:
        cal = rest.calendar((day - dt.timedelta(days=40)).isoformat(), (day + dt.timedelta(days=10)).isoformat())
        if day not in set(cal.date):
            log("no_session", day=day)
            return
        sessions = sorted(cal.date)
        nxt = next(d for d in sessions if d > day)
        prev = max(d for d in sessions if d < day)
        row = cal[cal.date == day].iloc[0]
        open_dt, close_dt = et(day, str(row.open)[:5]), et(day, str(row.close)[:5])
        prev_close = str(cal[cal.date == prev].iloc[0].close)[:5]
    except Exception as e:  # noqa: BLE001
        refuse(f"market calendar unavailable ({e.__class__.__name__})")
        times = times_from_clock(broker, day)
        if times is None:
            log("close_unknown", day=day)
            pager.once_per_day("paper-s:close-unknown", "Sleeve S: session close unknown",
                               "Neither the market calendar nor the broker clock could be read. Resting GTC stops "
                               "stay in place, but there is no end-of-day exit. Check the account.", 5)
            return
        open_dt, close_dt = times
        nxt = day + dt.timedelta(days=1)
        while nxt.weekday() >= 5:
            nxt += dt.timedelta(days=1)
    now = clock()
    if now >= close_dt:
        log("no_session", day=day, reason="started after the close")
        return
    if now < open_dt - ARM_LEAD:
        log("too_early", day=day)
        return
    flatten_dt, market_dt, verify_dt = (close_dt - dt.timedelta(minutes=m) for m in (10, 5, 2))
    entry_end = close_dt - dt.timedelta(minutes=ENTRY_CUTOFF_MIN)

    # ---- the virtual book and the stop rule ----
    try:
        va: VirtualAccount = SleeveAccount.load(VA_PATH)
        va_ok = True
    except StateError as e:
        refuse(str(e))
        va, va_ok = SleeveAccount(), False
    rows = journal_rows()
    try:
        rule = stop_rule.load(STRATEGY)
        fired = stop_rule.evaluate(rule, rows, day) if rule is not None and va_ok else None
    except Exception as e:  # noqa: BLE001 — a bad config refuses entries; exits are still managed
        rule, fired = None, None
        refuse(f"stop rule unreadable ({e.__class__.__name__}): config/risk.yaml S.stop_rule")
    else:
        if rule is None:
            refuse("no stop rule in config/risk.yaml (S.stop_rule)")
    if rule is not None and fired is not None:
        if not va.latched and va_ok:
            va.latch(stop_rule.latch_reason(fired, rule))
            try:
                va.save(VA_PATH)
            except OSError as e:
                _echo(f"STOP RULE LATCH NOT SAVED ({e.__class__.__name__})", sys.stderr)
            log("stop_rule", kind=fired.kind, detail=fired.detail, decision=rule.decision)
            pager.once_per_day("paper-s:stop-rule", f"paper-s stopped by its stop rule ({page.record(rule.decision)})",
                               "The rule fired; the session's journal (stop_rule) has its numbers. Entries stay off "
                               "until a new decision record changes S.stop_rule or retires the sleeve and its latch "
                               "is cleared; a reset alone brings the latch back at the next arming.", 4)
        refuse(f"stop rule {fired.kind} ({rule.decision}): {fired.detail}")

    # ---- the execution stops (DEC-0073): faults that latch the desk across sessions, read from the journal ----
    xrules: execution_stops.Rules | None = None
    try:
        xrules = execution_stops.load(STRATEGY)
    except Exception as e:  # noqa: BLE001 — a bad config refuses entries; exits are still managed
        refuse(f"execution stops unreadable ({e.__class__.__name__}): config/risk.yaml S.execution_stops")
    else:
        if xrules is None:
            refuse("no execution stops in config/risk.yaml (S.execution_stops)")
    xrows = list(rows)
    xsince = execution_stops.last_reset(va.latch_history, xrules.decision) if xrules is not None and va_ok else ""
    xfired: list[str] = []

    def x_check(arming: bool) -> None:
        """Latch the book on the first execution stop that holds: entries off, exits on, until a record clears it."""
        if xrules is None or not va_ok or xfired:
            return
        x = execution_stops.evaluate(xrules, xrows, xsince)
        if x is None:
            return
        xfired.append(x.code)
        new = not va.latched                                   # a latch already set keeps its own reason
        if new:
            va.latch(execution_stops.latch_reason(x, xrules))
            try:
                va.save(VA_PATH)
            except OSError as e:
                _echo(f"EXECUTION STOP LATCH NOT SAVED ({e.__class__.__name__})", sys.stderr)
        log("execution_stop", code=x.code, detail=x.detail, decision=xrules.decision, arming=arming, new_latch=new)
        if new:                                                # as the stop rule: a page when it latches, not daily
            pager.once_per_day("paper-s:execution-stop",
                               f"Gap Hunter stopped: execution stop {x.code} ({page.record(xrules.decision)})",
                               "An execution fault latched the desk: no new entry, exits still managed. The "
                               "session's journal (execution_stop) says which. Only a new decision record clears "
                               "it (make reset-latch-s).", 5)
        why = f"execution stop {x.code} ({xrules.decision}): {x.detail}"
        if arming:
            refuse(why)
        else:
            off.append(why)

    def x_watch(rec: dict[str, Any]) -> None:
        if rec.get("event") in X_EVENTS:
            xrows.append(rec)
            x_check(False)

    x_check(True)
    _WATCH[:] = [x_watch]                                     # this session's reader only
    va.roll(day)
    losers, realised, closed_n = day_state(rows, day)
    journaled = {str(r.get("trade_id")) for r in rows if r.get("event") == "trade_closed"}
    account_unsaved = False

    # ---- plans ----
    store = Store()
    plans = store.load_all()
    today = [p for p in plans if p.date == day.isoformat()]
    orders_before = sum(orders_sent(p) for p in today)
    plan: TradePlan | None = next((p for p in today if p.active and p.origin == "entry"), None)
    staged: sl.Staged | None = staged_of(plan) if plan is not None else None
    held: list[TradePlan] = [p for p in plans if p.active and p is not plan]     # earlier days, and orphans
    limits = load_limits(STRATEGY)
    guard = PreTradeGuard(replace(limits, allowlist=frozenset({p.symbol for p in plans if p.active})))

    def allow(symbols: set[str]) -> None:
        guard.limits = replace(guard.limits, allowlist=guard.limits.allowlist | frozenset(symbols))

    def context(symbol: str) -> Context:
        return Context(now=clock(), position_qty=sum(p.qty for p in broker.positions() if p.symbol == symbol),
                       open_orders=broker.open_orders(), kill=killed(), latched=va.latched,
                       session_open=open_dt, session_close=close_dt,
                       entries_today=va.trades_by_day.get(day.isoformat(), 0),
                       orders_today=orders_before + sum(orders_sent(p) for p in made))

    def on_entry(p: TradePlan) -> None:
        nonlocal account_unsaved
        if va_ok and va.count_entry(day, p.trade_id):
            try:
                va.save(VA_PATH)
            except OSError:
                account_unsaved = True
        if p.origin == "entry":
            pager.fire("paper-s:position", "Gap Hunter is in a trade",
                       "Its entry filled and its stop rests. The session's journal (entry_filled) has the trade.", 3)
        log("entry_filled", trade_id=p.trade_id, symbol=p.symbol, qty=p.filled_qty, price=p.avg_entry,
            nbbo=nbbo(p.symbol), **({"code": p.code} if isinstance(p, GapPlan) else {}))

    made: list[TradePlan] = []                                # plans created by this process today
    oms = OMS(broker, guard=guard, context=context, persist=store.save, on_entry=on_entry, strategy=STRATEGY,
              sleep=sleep, clock=lambda: clock().timestamp())

    def nbbo(sym: str) -> list[float] | None:
        try:
            q = with_deadline(data.quote, sym)
        except Exception:  # noqa: BLE001 — a record only
            return None
        return [q[0], q[1]] if q else None

    def book(p: TradePlan, trade_day: dt.date) -> None:
        """Book a closed plan into the virtual account and the journal, once each, in that order."""
        nonlocal losers, realised, closed_n, account_unsaved
        if p.state != "closed" or p.recorded or not p.filled_qty:
            return
        px = p.exit_fill_price
        if px is None:
            try:
                px = p.exit_fill_price = oms.exit_fill(p)
            except Exception:  # noqa: BLE001 — retried on the next poll
                px = None
        estimated = px is None
        # R is measured against the stop the trade entered with, wherever the exit has moved it since
        stop0 = p.initial_stop if isinstance(p, MultiPlan) else p.stop
        px = px if px is not None else p.stop
        entry = p.avg_entry or 0.0
        own = ((trial if gap else sl.GAP_TRIAL) if isinstance(p, GapPlan) else sl.TRIAL) if p.origin == "entry" else None
        more: dict[str, Any] = {}
        if isinstance(p, GapPlan):
            if p.exit_reason == "stop" and p.wt.get("stop_reason") == "runner_prior_5m_low":
                p.exit_reason = "runner_prior_5m_low"           # the engine's name for a stop-out once the stop has trailed
            more = {"code": p.code, "partial_qty": p.partial_qty, "final_stop": p.stop}
        attributed = p.origin == "entry"
        priced = entry > 0                                     # no entry price: journaled, never booked as a gain
        if attributed and priced and va_ok and va.record_round_trip(trade_day, nxt, cost=p.filled_qty * entry,
                                                         proceeds=p.filled_qty * px, trade_id=p.trade_id):
            account_unsaved = True
        if account_unsaved and va_ok:
            try:
                va.save(VA_PATH)
                account_unsaved = False
            except OSError as e:
                log("account_save_failed", error=e.__class__.__name__)
        if p.trade_id not in journaled:
            r_mult = (px - entry) / (entry - stop0) if attributed and entry > stop0 else None
            if p.stop_id:                                      # the stop order's own fill (DEC-0073 X5): the exit
                try:                                           # price above averages every sell of the plan
                    so = broker.get_order(p.stop_id)
                except Exception:  # noqa: BLE001 — a record only
                    so = None
                if so is not None and so.filled_qty and so.avg_fill_price and so.stop_price:
                    more = {**more, "stop_fill": so.avg_fill_price, "stop_price": so.stop_price}
            if log("trade_closed", day=trade_day, trial=own, symbol=p.symbol,
                   entry=entry, exit=px, exit_price_estimated=estimated, stop=stop0, qty=p.filled_qty, R=r_mult,
                   reason=p.exit_reason, trade_id=p.trade_id, origin=p.origin,
                   booked=attributed and priced and va_ok,
                   virtual=asdict(va) if va_ok else None, **more):
                journaled.add(p.trade_id)
                if p.origin == "entry" and trade_day == day:
                    pager.resolve("paper-s:position", "Gap Hunter closed its trade",
                                  f"Closed at {page.ratio(r_mult, '+.2f')}R"
                                  f"{' (exit price estimated)' if estimated else ''}. The session's journal "
                                  "(trade_closed) has the trade.")
                if attributed and trade_day == day:
                    x = -1.0 if r_mult is None or estimated else float(r_mult)
                    closed_n, realised = closed_n + 1, realised + x
                    losers = losers + 1 if x < 0 else 0
        if va_ok and not account_unsaved and p.trade_id in journaled:
            p.recorded = True
            store.save(p)

    p: TradePlan | None                                       # the loop variable below also walks [plan, *held]
    for p in plans:                                           # a close nobody booked, from this day or an earlier one
        book(p, dt.date.fromisoformat(p.date))

    def adopt(sym: str, qty: int, avg: float) -> TradePlan | None:
        """A long position no plan accounts for: protect it, then exit it."""
        allow({sym})
        if not oms.cancel_resting_confirmed(sym):
            log("orphan_adoption_deferred", symbol=sym)
            return None
        n = sum(1 for p in plans + made if p.origin == "orphan" and p.date == day.isoformat())
        stop = round(avg * (1 - FALLBACK_STOP_PCT / 100), 2)
        o = TradePlan(date=day.isoformat(), strategy=STRATEGY, symbol=sym, qty=qty, trigger=avg, limit=avg, stop=stop,
                      target=stop, attempt=n, seq=plan_seq(n), filled_qty=qty, avg_entry=avg, state="in_position",
                      entry_counted=True, origin="orphan")
        made.append(o)
        store.save(o)
        try:
            oms.ensure_stop(o)
        except Exception as e:  # noqa: BLE001 — it is adopted either way: reconcile keeps trying to protect it
            log("orphan_stop_failed", trade_id=o.trade_id, error=e.__class__.__name__)
        log("adopted_orphan", trade_id=o.trade_id, symbol=sym, qty=qty, stop=stop)
        pager.once_per_day("paper-s:orphan", "Sleeve S adopted a position it did not open",
                           f"A long position of {page.count(qty)} share(s) had no plan. It is stopped and sold at "
                           "once (retried every 5 minutes); the session's journal (adopted_orphan) names it. Only "
                           "the day's first adoption pages.", 4)
        return o

    left_alone: set[str] = set()                              # positions too large for this desk's hard caps

    def sweep_positions() -> None:
        """Every position on sleeve S's account belongs to a plan, or becomes one. A short is never covered."""
        owned = {p.symbol for p in [plan, *held] if p is not None and p.active} | left_alone
        for pos in broker.positions():
            if pos.symbol in owned or not pos.qty:
                continue
            if pos.qty > 0 and (pos.qty > limits.max_qty or pos.qty * pos.avg_price > limits.max_notional):
                # The hard caps refuse protective orders too, so this desk cannot stop or sell it. It did not open
                # it (its own orders are under the caps): it is journaled once and left for the owner.
                left_alone.add(pos.symbol)
                log("position_over_caps", symbol=pos.symbol, qty=pos.qty, action="left for the owner")
                pager.once_per_day("paper-s:over-caps", "Sleeve S: a position over its hard caps",
                                   f"The account holds a long position of {page.count(pos.qty)} share(s) that this "
                                   "desk did not open and cannot stop or sell (its hard caps refuse the orders). It "
                                   "is left for the owner; the session's journal (position_over_caps) names it.", 5)
            elif pos.qty > 0:
                o = adopt(pos.symbol, pos.qty, pos.avg_price)
                if o is not None:
                    held.append(o)
            else:
                left_alone.add(pos.symbol)                     # a short is never covered automatically
                allow({pos.symbol})
                log("short_position", symbol=pos.symbol, qty=pos.qty, cancelled=oms.cancel_resting(pos.symbol))
                pager.once_per_day("paper-s:short", "Sleeve S is SHORT",
                                   f"Short {page.count(abs(pos.qty))} share(s). This account must never be short. "
                                   "This desk's orders in the name were cancelled; nothing is bought back "
                                   "automatically. The session's journal (short_position) names it. Follow the "
                                   "not-flat runbook.", 5)

    def reconciled(p: TradePlan) -> list[str]:
        """Orders and position against one plan. A plan that sells in parts settles a part sale a crash left
        resting before its stop is sized. Every other active plan's symbol is kept: its orders are never this
        plan's strays (DEC-0077)."""
        keep = {x.symbol for x in [plan, *held] if x is not None and x.active and x is not p}
        if isinstance(p, MultiPlan):
            return oms.reconcile_all([p], keep=keep)
        return oms.reconcile({p.symbol}, {}, plan=p, keep=keep)

    def protect(p: TradePlan) -> None:
        """Sync and protect one plan, in its own guard (DEC-0077). A refusal never leaves the poll: it is
        journaled and paged, and when the bid is already at or under the plan's stop the plan leaves at market,
        where the simulation is stopped out too. Otherwise the next poll tries again; the exits run either way."""
        try:
            oms.sync(p)
            acts = reconciled(p)
            if acts:
                log("reconcile", actions=acts)
            return
        except Exception as e:  # noqa: BLE001 — a protect step must never cost the plan its exit management
            err = e.__class__.__name__
        log("protect_failed", trade_id=p.trade_id, symbol=p.symbol, error=err)
        pager.once_per_day("paper-s:protect-failed", "Gap Hunter could not protect a position",
                           "The broker refused or did not answer the stop for an open position. The desk keeps "
                           "managing the exit; if the market is already under the stop it sells at market. The "
                           "session's journal (protect_failed) names the trade.", 5)
        if err == "TransportError" or p.state not in ACTIVE_POSITION or oms.held_for_exit(p):
            return
        try:
            q = with_deadline(data.quote, p.symbol)
        except Exception:  # noqa: BLE001
            q = None
        if q is not None and 0 < float(q[0]) <= p.stop:
            if isinstance(p, GapPlan):
                p.wt["exit"] = "stop"
                store.save(p)
            log("exit_signal", trade_id=p.trade_id, symbol=p.symbol, reason="stop", why="stop_under_market")
            try:
                oms.exit_now(p, None, reason="stop", market=True)
            except Exception as e:  # noqa: BLE001
                log("protect_failed", trade_id=p.trade_id, symbol=p.symbol, error=e.__class__.__name__,
                    step="exit")

    try:
        sweep_positions()
        for p in [plan, *held]:
            if p is not None:
                acts = reconciled(p)
                if acts:
                    log("reconcile_startup", actions=acts)
    except Exception as e:  # noqa: BLE001
        log("startup_reconcile_error", error=repr(e)[:300])

    # ---- the universe and the names in it ----
    curve: np.ndarray | None = None
    rule_curve: np.ndarray | None = None
    symbols: list[str] = []
    if not gap:                                               # the reversal rule's inputs; Gap Hunter reads the pool
        try:
            rule_curve = detector_curve()
            curve = scan_s.load_curve()
            symbols = with_deadline(data.symbols, deadline_s=120.0)
            if not symbols:
                refuse("the asset list is empty")
        except Exception as e:  # noqa: BLE001
            refuse(f"scan inputs unavailable ({e.__class__.__name__})")
    universe = scan_s.Universe(day, open_dt, curve if curve is not None else np.ones(scan_s.SESSION_MIN))
    names: dict[str, sl.NameState] = {}
    ctxs: dict[str, dict[str, Any]] = {}
    bars: dict[str, pd.DataFrame] = {}
    counts: dict[str, int] = {}                               # blocked signals, by blocker

    def bump(key: str) -> None:
        counts[key] = counts.get(key, 0) + 1

    # What each name already used up today, from the plan files and the journal: a restart must not hand a name a
    # third attempt, or revive one that an unfilled order or a refused signal had finished.
    used: dict[str, int] = {}
    ended: dict[str, str] = {}
    for p in today:
        if p.origin != "entry" or p.active:
            continue
        if p.filled_qty:
            used[p.symbol] = used.get(p.symbol, 0) + 1
        else:
            ended[p.symbol] = "no_fill"
    for r in rows:
        if r.get("event") in ("signal_blocked", "signal_missed") and r.get("name_done") \
                and str(r.get("day")) == day.isoformat():
            ended[str(r.get("symbol"))] = str(r["name_done"])

    # ---- Gap Hunter's day: the primary, and what is already settled about it. All of it is rebuilt from the plan
    # files and the journal, so a restart neither chooses again nor takes a second attempt. ----
    primary: str | None = None
    gctx: dict[str, Any] | None = None
    gap_selected = False            # the primary was chosen (or found missing) today
    gap_done = ""                   # why the day's one attempt is settled ("" while it is open)
    gap_dead: set[str] = set()      # signals refused for good (spread, collar, an order the broker refused)
    gap_said: set[str] = set()      # blocked signals already journaled, with their blockers
    gap_walked = 0                  # bars already read for a trigger that was reached
    gap_minute: list[pd.Timestamp | None] = [None]            # the minute the entries were last decided for
    # why each rule has (or has no) order: a row when any rule's reason changes, and the minutes per reason on the day's
    # end. Journal words only; they decide nothing. A restart starts the tally again.
    gap_why_seen: list[tuple[tuple[str, str], ...] | None] = [None]
    gap_why_tally: dict[str, dict[str, int]] = {}
    gap_why_last: dict[str, dict[str, Any]] = {}
    gap_rested = [""]               # the signal whose order the desk last had resting
    # HYP-0072 (DEC-0076): the day's tier-2 names and the walk that says, each minute, which one order rests. The walk
    # is deterministic, so a restart walks the morning again from the names the journal holds (`gap_names`).
    grot: list[Rotation | None] = [None]

    def rot_names(tier2: list[tuple[int, str]]) -> tuple[Rotation, list[int]]:
        """The names with their own context (pool row and pre-market bars), and the ranks that have none."""
        named: list[tuple[int, str, dict[str, Any]]] = []
        missing: list[int] = []
        for rank, sym in tier2:
            try:
                _, ctx, _ = gap_selection(day, open_dt, symbol=sym)
            except Exception:  # noqa: BLE001 — no context: the name never has an order
                ctx = None
            if ctx is None:
                missing.append(rank)
            else:
                named.append((rank, sym, ctx))
        return Rotation(named, pd.Timestamp(open_dt) + pd.Timedelta(minutes=1)), missing

    def rot_select() -> None:
        """HYP-0072: the day's tier-2 names from the 09:25 pool, journaled once as `gap_names`. No names: no entry."""
        try:
            tier2, info2 = rotation_tier2(day)
        except Exception as e:  # noqa: BLE001 — no names: no entry this session
            tier2, info2 = [], {"why": "selection_failed", "error": e.__class__.__name__}
        today_rot, missing = rot_names(tier2)
        grot[0] = today_rot
        log("gap_names", day=day, trial=trial, names=[[k, s] for k, s in tier2], no_context=missing, **info2)
        allow({s for _, s, _ in today_rot.names})
    gap_n = max((p.attempt for p in today if p.origin == "entry"), default=0)
    wt: sl.WTState | None = None    # the exit's state for the plan in play
    wt_tries: dict[float, int] = {}
    if gap:
        if any(p.filled_qty for p in today if p.origin == "entry"):
            gap_done = "traded"                                # one trade a day: a fill is the day's trade, open or closed
        for r in rows:
            if str(r.get("day")) != day.isoformat():
                continue
            if r.get("event") == "gap_primary" and not gap_selected:
                gap_selected = True
                if r.get("symbol"):
                    try:
                        primary, gctx, _ = gap_selection(day, open_dt, symbol=str(r["symbol"]))
                    except Exception as e:  # noqa: BLE001 — no context: no entry; a position is still managed
                        log("gap_context_unreadable", day=day, error=e.__class__.__name__)
            elif r.get("event") == "gap_names" and rotate and grot[0] is None:
                grot[0] = rot_names([(int(k), str(s)) for k, s in (r.get("names") or [])])[0]
            elif r.get("event") == "gap_day_done" and not gap_done:
                gap_done = str(r.get("reason") or "done")
            elif r.get("event") in ("signal_blocked", "entry_not_placed") and r.get("dead"):
                gap_dead.add(str(r["dead"]))
        if primary is not None:
            allow({primary})
        if grot[0] is not None:
            allow({s for _, s, _ in grot[0].names})
        elif rotate and gap_selected and not gap_done:
            # a restart between `gap_primary` and `gap_names`: the names come from the same 09:25 pool, so choose them
            # now (and journal them, for X4) rather than watch no names for the rest of the day
            rot_select()
        if isinstance(plan, GapPlan):                          # the order (or position) this restart found in play
            gap_rested[0] = (f"{plan.symbol}|" if rotate else "") + \
                f"{plan.code}|{plan.signal_t}|{plan.trigger:.2f}|{plan.initial_stop:.2f}"

    kill_on = killed()
    log("armed", day=day, trial=trial, entries_off=off, kill=kill_on, flatten=flatten_dt, symbols=len(symbols),
        resumed_plan=plan.trade_id if plan else None, held=[p.trade_id for p in held],
        day_stop=day_stopped(losers, realised), skew_s=measure_skew(broker, clock),
        virtual=asdict(va) if va_ok else None, stock_feed="sip", pages=pager.alerts is not None, role=role,
        lease=lease_state, record_accepted=accepted())
    if off and role != "shadow":
        pager.once_per_day("paper-s:entries-off", "Gap Hunter armed with new entries off",
                           f"Armed with new entries off for {page.count(len(off))} reason(s). Exits are still "
                           "managed. The session's journal (refuse_to_arm) names each reason.", 4)

    def close_out(p: TradePlan) -> None:
        book(p, dt.date.fromisoformat(p.date))

    def finish(p: TradePlan, when: dt.datetime) -> None:
        """The day's plan reached a terminal state: book it and move its name on."""
        nonlocal plan, staged, wt
        close_out(p)
        traded = p.state == "closed" and bool(p.filled_qty)
        if isinstance(p, GapPlan):
            if traded:
                gap_end("traded", code=p.code)
            plan, staged, wt = None, None, None
            wt_tries.clear()
            return
        if traded:
            used[p.symbol] = used.get(p.symbol, 0) + 1         # read by join() if the name is not back yet
        else:
            ended.setdefault(p.symbol, "no_fill")
        st = names.get(p.symbol)
        if st is not None:
            if traded:
                # a stop fills at the broker between polls: it is timed one poll back, so the bar it may have
                # filled on is never skipped; an exit this runner sent is timed when it was sent
                seen_late = dt.timedelta(seconds=poll_s) if p.exit_reason == "stop" else dt.timedelta(0)
                st.after_trade(pd.Timestamp(when - seen_late))
            else:
                st.done = st.done or "no_fill"                # as the batch run: an unfilled attempt ends the name
        plan, staged = None, None

    def closed_only(df: pd.DataFrame, now: dt.datetime) -> pd.DataFrame:
        cut = pd.Timestamp(now) - pd.Timedelta(minutes=1) - pd.Timedelta(seconds=SETTLE_S)
        return df[(df.t >= pd.Timestamp(open_dt)) & (df.t <= cut)].reset_index(drop=True)

    read_minute: list[pd.Timestamp | None] = [None]

    def refresh(cache: dict[str, pd.DataFrame], syms: list[str], now: dt.datetime, deadline_s: float) -> None:
        """Bring `cache` up to the last closed bar for `syms`: a name not yet in it is read from the open, the rest
        from the oldest of their last cached bars."""
        first = [x for x in syms if x not in cache]
        if first:
            got = with_deadline(data.minute_bars, first, open_dt, deadline_s=deadline_s)
            for sym in first:
                if sym in got:
                    cache[sym] = closed_only(got[sym], now)
        known = [x for x in syms if x in cache and x not in first]
        if not known:
            return
        since = min((cache[x].t.iloc[-1] for x in known if len(cache[x])), default=pd.Timestamp(open_dt))
        got = with_deadline(data.minute_bars, known, since.to_pydatetime(), deadline_s=deadline_s)
        for sym in known:
            if sym in got:
                cache[sym] = closed_only(pd.concat([cache[sym], got[sym]], ignore_index=True)
                                         .drop_duplicates("t", keep="last").sort_values("t"), now)

    def fetch_bars(watch: list[str], now: dt.datetime) -> None:
        """Newly closed bars for the watched names, read once per closed minute (a new name at once)."""
        minute = (pd.Timestamp(now) - pd.Timedelta(seconds=SETTLE_S)).floor("min")
        todo = watch if read_minute[0] != minute else [x for x in watch if x not in bars]
        if todo:
            refresh(bars, todo, now, 30.0)
        read_minute[0] = minute

    proposed: dict[str, pd.DataFrame] = {}                    # bars of scan candidates not (yet) confirmed

    def join(new: list[str], now: dt.datetime) -> None:
        """Names that just entered the universe: read what the rule needs about each, once."""
        if not new or prev is None:
            return
        prior = with_deadline(data.prior_session, new, prev, prev_close, deadline_s=60.0)
        vols = with_deadline(data.daily_volumes, new, day, deadline_s=60.0)
        for sym in new:
            pb = prior.get(sym)
            if pb is None or len(pb) < sl.PREV_MIN_BARS or rule_curve is None:
                names[sym] = sl.NameState(pd.Timestamp(now), done="no_history")
                continue
            ctxs[sym] = sl.rev_context(pb, vols.get(sym, []), rule_curve)
            done = ended.get(sym, "") or ("attempts" if used.get(sym, 0) >= sl.MAX_ATTEMPTS else "")
            names[sym] = sl.NameState(pd.Timestamp(now), attempts=used.get(sym, 0), done=done)
        allow(set(new))
        log("universe", joined=new, size=len(universe.joined), scan=universe.scans)

    def gates(now: dt.datetime) -> list[str]:
        out = [f"entries_off:{r}" for r in off]
        if kill_on:
            out.append("kill_file")
        if va.latched:
            out.append(f"latched:{va.latch_reason}")
        stop_why = day_stopped(losers, realised)
        if stop_why:
            out.append(f"day_stop:{stop_why}")
        if va.trades_by_day.get(day.isoformat(), 0) >= guard.limits.max_entries_per_day:
            out.append("max_entries_per_day")
        if store.broken:
            out.append("plan_not_persisted")
        if account_unsaved:
            out.append("account_not_persisted")
        if sum(1 for p in [plan, *held] if p is not None and p.active) >= MAX_OPEN_POSITIONS:
            out.append("exposure_exists")
        return out

    def consider(sym: str, now: dt.datetime) -> None:
        """One name, one newly closed bar: a fresh signal becomes an order, or a journaled reason why not."""
        nonlocal plan, staged
        st, b = names[sym], bars.get(sym)
        if st.done or b is None or sym not in ctxs:
            return
        sig, fresh = sl.fresh_signal(b, ctxs[sym], st.start_index(b))
        if sig is None:
            return
        signal_t = pd.Timestamp(b.t.iloc[sig.bar_index])
        st.start_t, st.inclusive = signal_t, False            # never read this signal twice
        if not fresh:
            st.done = "missed"
            bump("missed")
            log("signal_missed", day=day, symbol=sym, signal_t=signal_t, newest_bar=b.t.iloc[-1], name_done="missed")
            return
        blockers = gates(now)
        age = (pd.Timestamp(now) - signal_t).total_seconds()
        if age > 120 + SETTLE_S + poll_s:
            blockers.append("stale_bar")                      # the signal bar is not the minute just ended
        q = None
        try:
            q = with_deadline(data.quote, sym)
        except Exception:  # noqa: BLE001 — unknown fails the spread must below
            q = None
        quote_age = (pd.Timestamp(now) - q[2]).total_seconds() if q else None
        if q is None:
            blockers.append("no_quote")
        elif quote_age is not None and quote_age > guard.limits.max_quote_age_s:
            blockers.append("quote_age")
        s, why = sl.stage(sym, st.attempts + 1, sig, b, day, (q[1] - q[0]) if q else None)
        row: dict[str, Any] = {"day": day, "symbol": sym, "trial": sl.TRIAL, "signal_t": signal_t, "attempt": st.attempts + 1,
                               "nbbo": [q[0], q[1]] if q else None, "quote_age_s": quote_age,
                               "trigger": s.trigger if s else round(sig.trigger, 2),
                               "stop": s.stop if s else round(sig.stop, 2), "target": s.target if s else None}
        if s is None:
            st.done = why                                      # spread, collar, risk: the name is finished
            bump(why)
            log("signal_blocked", blockers=[why, *blockers], name_done=why, **row)
            return
        skew: float | None = None
        if not blockers:
            skew = measure_skew(broker, clock)
            if skew is None or abs(skew) > SKEW_MAX_S:
                blockers.append("clock_skew")
            else:
                pager.resolve("paper-s:clock-skew", "Sleeve S clock check: ok", "Clock skew is back in range.")
        qty = 0
        if not blockers:
            risk = va.equity * RISK_PCT / 100
            qty = min(size_position(s.trigger, s.stop, risk, va.settled_cash, min(va.equity, guard.limits.max_notional)),
                      guard.limits.max_qty)
            if qty < 1:
                blockers.append("cash_not_settled" if va.settled_cash < s.trigger else "size_zero")
        if blockers:
            for k in blockers:
                bump(k.split(":")[0])
            log("signal_blocked", blockers=blockers, **row)
            if "clock_skew" in blockers:
                log("clock_skew", skew_s=skew, max_s=SKEW_MAX_S, action="entry skipped")
                pager.fire("paper-s:clock-skew", "Sleeve S skipped an entry: clock check failed",
                           "The broker clock could not be read, so the local clock could not be checked."
                           if skew is None else
                           f"The local clock is {page.ratio(skew, '+.1f')} s off the broker's (limit 2 s).", 4)
            return
        p = TradePlan(date=day.isoformat(), strategy=STRATEGY, symbol=sym, qty=qty, trigger=s.trigger, limit=s.limit,
                      stop=s.stop, target=s.target, attempt=s.attempt, seq=plan_seq(s.attempt))
        p.log.append(staged_note(s))
        made.append(p)
        store.save(p)
        before = plan, staged
        plan, staged = p, s                                    # in play before it is sent (see gap_place)
        oms.place_entry(p)
        log("entry_placed" if p.state == "entry_working" else "entry_not_placed", trade_id=p.trade_id, qty=qty,
            limit=s.limit, expires=s.expires_at, state=p.state, detail=p.log[-1:] if p.log else None, **row)
        if not p.active:
            plan, staged = before
            st.done = "not_placed"
            bump("not_placed")

    def manage(p: TradePlan, now: dt.datetime) -> None:
        """The day's plan: cancel an entry the simulation would not have filled; exit an open position."""
        if p.state == "entry_working":
            b = bars.get(p.symbol)
            if staged is None:
                verdict: str | None = "staged_unreadable"      # its life and its stop cannot be judged: it may not rest
            elif b is not None:
                verdict = sl.entry_verdict(b, staged, p.filled_qty, now)
            else:                                              # no bars read: a gap order still ends with its minute
                verdict = "expired" if isinstance(p, GapPlan) and now >= staged.expires_at else None
            if verdict is None and (now >= entry_end or kill_on):
                verdict = "kill_file" if kill_on else "entry_window_closed"
            if verdict is None and va.latched:
                verdict = "latched"                            # an execution stop fired in the session (DEC-0073)
            if verdict is not None:
                oms.cancel_entry_remainder(p)
                log("entry_cancelled", trade_id=p.trade_id, symbol=p.symbol, why=verdict, filled=p.filled_qty,
                    state=p.state, **({"code": p.code} if isinstance(p, GapPlan) else {}))
                if p.state == "aborted":
                    bump(verdict)
        if p.state in ACTIVE_POSITION:
            q = None
            try:
                q = with_deadline(data.quote, p.symbol)
                quote_down.pop(p.trade_id, None)
                quote_paged.discard(p.trade_id)
            except Exception:  # noqa: BLE001
                log("data_timeout", what="quote", symbol=p.symbol)
                since = quote_down.setdefault(p.trade_id, now)
                if (now - since).total_seconds() >= QUOTE_OUTAGE_PAGE_S and p.trade_id not in quote_paged:
                    quote_paged.add(p.trade_id)                # asked once an outage; the pager sends one a day
                    pager.once_per_day("paper-s:data-timeout", "Gap Hunter has no quotes for an open position",
                                       "Quotes for its open position have failed for 2 minutes. Exits that need a "
                                       "quote wait; the resting stop still protects it. The session's journal "
                                       "(data_timeout) has each failure.", 4)
            # a target is sold on a quote no older than the entry gate allows: a stale bid over the target (a halt
            # after a run-up) would ask for a sale that cannot fill, again at every poll
            fresh = q if q is not None and (pd.Timestamp(now) - q[2]).total_seconds() <= guard.limits.max_quote_age_s \
                else None
            b = bars.get(p.symbol)
            # the end-of-day steps below need nothing but the position; the target and the stagnation stop need the fill
            target = entry_t = None
            if not isinstance(p, GapPlan):
                target = sl.target_price(p.target, p.avg_entry, p.stop) if p.avg_entry else None
                entry_t = sl.entry_bar_time(b, staged) if b is not None and staged is not None else None
            if now >= verify_dt:
                oms.exit_now(p, None, reason="eod_verify", market=True)
            elif now >= market_dt:
                oms.exit_now(p, None, reason="eod_market", market=True)
            elif now >= flatten_dt:
                if q:
                    oms.exit_now(p, round(q[0] - 0.02, 2), reason="eod_flatten")
                else:
                    oms.exit_now(p, None, reason="eod_flatten", market=True)
            elif isinstance(p, GapPlan):
                gap_exit(p, fresh, b, now)
            elif target is not None and (px := target_exit_limit(fresh, target)) is not None:
                oms.exit_now(p, px, reason="target")
            elif p.avg_entry and b is not None and entry_t is not None and \
                    sl.stagnant(b, entry_t, p.avg_entry, p.stop):
                oms.exit_now(p, None, reason="time_stop_5m", market=True)

    # ---- Gap Hunter (HYP-0071): one trade a day in the primary, the first registered gap entry to trigger ----
    def gap_end(reason: str, **kw: Any) -> None:
        """The day's one attempt is settled. Journaled once; a restart reads the row back."""
        nonlocal gap_done
        if not gap_done:
            gap_done = reason
            if gap_why_tally:
                kw = {**kw, "rules": {c: {"minutes": gap_why_tally[c], "last": gap_why_last.get(c)} for c in sorted(gap_why_tally)}}
            log("gap_day_done", **{"day": day, "symbol": primary, **kw, "reason": reason})   # HYP-0072 names its own

    def gap_select() -> None:
        """Choose the day's primary from the 09:25 pool, once. No pool, or none of today: no entry this session."""
        nonlocal primary, gctx, gap_selected
        gap_selected = True
        try:
            primary, gctx, info = gap_selection(day, open_dt)
        except Exception as e:  # noqa: BLE001 — unknown is "no primary"
            primary, gctx, info = None, None, {"why": "selection_failed", "error": e.__class__.__name__}
        log("gap_primary", day=day, symbol=primary, **info)
        if primary is not None:
            allow({primary})
        if rotate:
            rot_select()

    def gap_key(o: sl.GapOrder, b: pd.DataFrame, sym: str | None = None) -> str:
        trig, stop0 = sl.gap_cents(o)
        key = f"{o.code}|{pd.Timestamp(b.t.iloc[o.signal_i]).isoformat()}|{trig:.2f}|{stop0:.2f}"
        return f"{sym}|{key}" if rotate else key                # HYP-0072: a signal is a name's

    def gap_place(want: sl.GapOrder, b: pd.DataFrame, now: dt.datetime, minute: pd.Timestamp, now_min: int,
                  sym: str | None = None, rank: int | None = None) -> None:
        """The lowest valid order becomes a resting stop-limit, or a journaled reason why not. `sym`: the name it is
        in (HYP-0072's resting name; the primary otherwise), `rank` its tier-2 rank."""
        nonlocal plan, staged, gap_n
        sym = sym or primary
        assert sym is not None
        key = gap_key(want, b, sym)
        if key in gap_dead:
            return
        sent = orders_before + sum(orders_sent(x) for x in made)
        if sent >= GAP_ENTRY_ORDERS_MAX:
            gap_end("order_budget", orders=sent)               # re-pricing stops here; the cap itself is never reached
            return
        blockers = gates(now)
        if pd.Timestamp(b.t.iloc[-1]) != minute - pd.Timedelta(minutes=1):
            blockers.append("stale_bar")                       # no print in the minute just ended: treated as halted
        q = None
        try:
            q = with_deadline(data.quote, sym)
        except Exception:  # noqa: BLE001 — unknown fails the spread must below
            q = None
        quote_age = (pd.Timestamp(now) - q[2]).total_seconds() if q else None
        if q is None:
            blockers.append("no_quote")
        elif quote_age is not None and quote_age > guard.limits.max_quote_age_s:
            blockers.append("quote_age")
        s, why = sl.gap_stage(sym, gap_n + 1, want, b, day, (q[1] - q[0]) if q else None, now_min)
        trig, stop0 = sl.gap_cents(want)
        row: dict[str, Any] = {"day": day, "symbol": sym, "trial": trial, "code": want.code,
                               **({"rank": rank} if rank is not None else {}),
                               "signal_t": pd.Timestamp(b.t.iloc[want.signal_i]), "nbbo": [q[0], q[1]] if q else None,
                               "quote_age_s": quote_age, "trigger": trig, "stop": stop0}
        if s is None:
            gap_dead.add(key)                                  # spread, collar, risk: this signal is never sent
            bump(why)
            log("signal_blocked", blockers=[why, *blockers], dead=key, **row)
            return
        skew: float | None = None
        if not blockers:
            skew = measure_skew(broker, clock)
            if skew is None or abs(skew) > SKEW_MAX_S:
                blockers.append("clock_skew")
            else:
                pager.resolve("paper-s:clock-skew", "Sleeve S clock check: ok", "Clock skew is back in range.")
        qty = 0
        if not blockers:
            # sized at the fill the simulation expects (the trigger plus its slippage), as the engine sizes at the fill
            risk = va.equity * RISK_PCT / 100
            fill = s.trigger + max(sl.MIN_SLIP, s.spread / 2)
            qty = min(size_position(fill, s.stop, risk, va.settled_cash, min(va.equity, guard.limits.max_notional)),
                      guard.limits.max_qty)
            if qty < 1:
                blockers.append("cash_not_settled" if va.settled_cash < s.trigger else "size_zero")
        if blockers:
            said = f"{key}|{','.join(blockers)}"
            if said not in gap_said:                           # a re-priced order is asked every minute: one row a reason
                gap_said.add(said)
                for k in blockers:
                    bump(k.split(":")[0])
                log("signal_blocked", blockers=blockers, **row)
                if "clock_skew" in blockers:
                    log("clock_skew", skew_s=skew, max_s=SKEW_MAX_S, action="entry skipped")
                    pager.fire("paper-s:clock-skew", "Sleeve S skipped an entry: clock check failed",
                               "The broker clock could not be read, so the local clock could not be checked."
                               if skew is None else
                               f"The local clock is {page.ratio(skew, '+.1f')} s off the broker's (limit 2 s).", 4)
            return
        gap_n += 1                                             # each order is its own plan, with its own block of ids
        p = GapPlan(date=day.isoformat(), strategy=STRATEGY, symbol=sym, qty=qty, trigger=s.trigger, limit=s.limit,
                    stop=s.stop, target=0.0, attempt=gap_n, seq=plan_seq(gap_n), code=want.code,
                    signal_t=s.signal_t.isoformat(), expires=s.expires_at.isoformat(), spread=s.spread, bv=want.bv)
        made.append(p)
        store.save(p)
        before = plan, staged, gap_rested[0]
        plan, staged, gap_rested[0] = p, s, key                # in play before it is sent: if the broker's answer is
        oms.place_entry(p)                                     # lost, the loop's sync settles it from the order id
        placed = p.state == "entry_working"
        if not p.active:
            plan, staged, gap_rested[0] = before
            gap_dead.add(key)                                  # refused by the guard or the broker: not asked again
            bump("not_placed")
        log("entry_placed" if placed else "entry_not_placed", trade_id=p.trade_id, qty=qty, limit=s.limit,
            expires=s.expires_at, state=p.state, detail=p.log[-1:] if p.log else None, attempt=gap_n,
            **({} if p.active else {"dead": key}), **row)

    def gap_entries(now: dt.datetime) -> None:
        """Once for each minute, after its bars are read: has a valid order's trigger been reached (then the day's
        attempt is spent, filled or not); otherwise, which one order should rest now."""
        nonlocal gap_walked
        if gap_done or (grot[0] is None if rotate else (primary is None or gctx is None)):
            return
        if plan is not None and plan.filled_qty:
            gap_end("traded", code=plan.code if isinstance(plan, GapPlan) else None,
                    **({"symbol": plan.symbol, "rank": next((k for k, s, _ in grot[0].names if s == plan.symbol), None)}
                       if rotate and grot[0] is not None else {}))
            return
        minute = (pd.Timestamp(now) - pd.Timedelta(seconds=SETTLE_S)).floor("min")
        b = bars.get(primary) if primary is not None else None
        if minute == gap_minute[0] or (not rotate and (b is None or not len(b))):
            return
        if pd.Timestamp(now).floor("min") != minute:
            return      # the first seconds of a minute, whose predecessor's bar is not read yet: nothing is decided
        gap_minute[0] = minute
        local = minute.tz_convert(ET)
        now_min = local.hour * 60 + local.minute
        resting = plan if isinstance(plan, GapPlan) and plan.state == "entry_working" else None

        def withdraw(why: str) -> bool:
            """Cancel the resting entry and confirm it. True when nothing rests and nothing filled."""
            assert resting is not None
            oms.cancel_entry_remainder(resting)
            log("entry_cancelled", trade_id=resting.trade_id, symbol=resting.symbol, why=why, filled=resting.filled_qty,
                state=resting.state, code=resting.code)
            if resting.filled_qty:
                gap_end("traded", code=resting.code)           # it filled before the cancel: that is the day's trade
                return False
            if resting.active:
                gap_minute[0] = None                           # the cancel is not confirmed: decide again next poll
                return False
            finish(resting, now)
            return True

        if rotate:
            rotation_entries(now, minute, now_min, resting, withdraw)
            return
        assert b is not None and gctx is not None
        hit = sl.gap_walk(b, gctx, start=gap_walked)
        if hit is not None:
            # a closed bar reached the order that should have been resting: the attempt is spent, whatever rested
            if resting is not None and not withdraw("reached"):
                return
            gap_walked = max(len(b) - 1, 0)
            # "no_fill": the desk's own order was the one reached (the collar refused it); "missed": nothing rested
            why = "no_fill" if gap_rested[0] == gap_key(hit.order, b) else "missed"
            bump(why)
            gap_end(why, code=hit.order.code, bar=pd.Timestamp(b.t.iloc[hit.bar_i]))
            return
        gap_walked = max(len(b) - 1, 0)
        if now_min >= sl.GAP_LAST_MINUTE:
            if resting is None or withdraw("windows_closed"):
                gap_end("no_signal")                           # no rotation to another name: no trade today
            return
        reasons = sl.gap_reasons(b, gctx, now_min)
        gap_why_note(reasons, minute)
        want = sl.gap_choose([w.order for w in reasons.values() if w.order is not None])
        if resting is not None:
            if want is not None and sl.gap_cents(want) == (resting.trigger, resting.initial_stop):
                return                                         # the same order: it keeps resting
            if not withdraw("replaced" if want is not None else "withdrawn"):
                return
        if plan is None and want is not None and now < entry_end:
            gap_place(want, b, now, minute, now_min)

    def rotation_entries(now: dt.datetime, minute: pd.Timestamp, now_min: int, resting: GapPlan | None,
                         withdraw: Callable[[str], bool]) -> None:
        """HYP-0072 (DEC-0076), once for each minute: walk the tier-2 names to this minute (`rotation_walk`, the
        rule the shadow ran), then do what it says. An attempt in the name whose order was resting spends the day,
        filled or not; otherwise the order it says rests is the desk's one resting order, in its name, replaced
        after a confirmed cancel when it changes. Every order still goes through `gap_place` and its gates."""
        r0 = grot[0]
        assert r0 is not None
        pb = bars.get(primary) if primary is not None else None
        if gctx is not None and pb is not None and len(pb):
            gap_why_note(sl.gap_reasons(pb, gctx, now_min), minute)   # the pick's own rules, for the journal only
        for ev in rotation_walk(r0, bars, minute):
            kind = ev.pop("kind")
            if kind == "change" and pd.Timestamp(ev["minute"]) == minute:   # a restart's walk is journaled already
                at_ = pd.Timestamp(ev.pop("minute"))
                log("rotation_live", day=day, trial=trial, kind="change", at=at_,
                    minute=at_.tz_convert(ET).strftime("%H:%M"), **ev)
        if r0.done == "attempt":
            assert r0.rest is not None
            rank, sym, order = r0.rest                         # the order whose bar reached its trigger
            if resting is not None and not withdraw("reached"):
                return
            sb = bars[sym]
            why = "no_fill" if gap_rested[0] == gap_key(order, sb, sym) else "missed"
            bump(why)
            att = r0.attempt or {}
            gap_end(why, code=order.code, symbol=sym, rank=rank,
                    **({"bar": pd.Timestamp(att["bar"])} if att.get("bar") is not None else {}))
            return
        if r0.done:                                            # 11:00: the entry windows are over
            if resting is None or withdraw("windows_closed"):
                gap_end("no_signal")
            return
        want = r0.rest
        if resting is not None:
            if want is not None and want[1] == resting.symbol \
                    and sl.gap_cents(want[2]) == (resting.trigger, resting.initial_stop):
                return                                         # the same order in the same name: it keeps resting
            if not withdraw("replaced" if want is not None else "withdrawn"):
                return
        if plan is None and want is not None and now < entry_end:
            gap_place(want[2], bars[want[1]], now, minute, now_min, sym=want[1], rank=want[0])

    # ---- the rotation shadow (DEC-0076): beside HYP-0071, journal only. It places, cancels and changes no order,
    # reads its own bars into its own cache, and never writes HYP-0071's state. No R, no P&L, no exit. ----
    rot: list[Rotation | None] = [None]
    rot_bars: dict[str, pd.DataFrame] = {}
    rot_said: list[str] = []                                   # the error already journaled (one row a kind)

    def rot_log(kind: str, **kw: Any) -> None:
        log("rotation_shadow", day=day, trial=ROTATION_TRIAL, kind=kind, **kw)

    def rot_start() -> None:
        """The tier-2 names and their contexts, once a session. A restart reads the names back from the journal and
        walks the morning again without journaling it twice; a day already ended stays ended."""
        mine = [r for r in rows if r.get("event") == "rotation_shadow" and str(r.get("day")) == day.isoformat()]
        start = pd.Timestamp(open_dt) + pd.Timedelta(minutes=1)
        end = next((r for r in mine if r.get("kind") in ("attempt", "done")), None)
        if end is not None:
            rot[0] = Rotation([(int(r), str(s), {}) for r, s in (end.get("names") or [])], start,
                              done=str(end.get("done") or end.get("kind")), changes=int(end.get("changes") or 0),
                              rank_minutes=dict(end.get("rank_minutes") or {}),
                              attempt={k: end.get(k) for k in ("rank", "engine_fill", "spread_ok")}
                              if end.get("kind") == "attempt" else None)
            return
        said = next((r for r in mine if r.get("kind") == "names"), None)
        if said is not None:
            tier2 = [(int(r), str(s)) for r, s in (said.get("names") or [])]
            info: dict[str, Any] = {}
        else:
            tier2, info = rotation_tier2(day)
        names: list[tuple[int, str, dict[str, Any]]] = []
        missing: list[int] = []
        for rank, sym in tier2:
            _, ctx, _ = gap_selection(day, open_dt, symbol=sym)
            if ctx is None:
                missing.append(rank)                           # no context: the name never has an order
            else:
                names.append((rank, sym, ctx))
        r0 = rot[0] = Rotation(names, start)
        if said is None:
            rot_log("names", names=[[r, s] for r, s in tier2], no_context=missing, **info)
        if not names:
            r0.done = "no_names"
            rot_log("done", done="no_names", names=[], changes=0, rank_minutes={})
        done_rows = [r for r in mine if r.get("kind") == "change" and r.get("at")]
        r0.known = {pd.Timestamp(r["at"]).isoformat(): r.get("nbbo") for r in done_rows}
        rot_quiet[0] = max((pd.Timestamp(r["at"]) for r in done_rows), default=None)

    rot_quiet: list[pd.Timestamp | None] = [None]              # changes at or before this minute are journaled already

    def rot_step(now: dt.datetime) -> None:
        """Once a minute, after the desk's own work: the shadow's bars, then its walk to the minute just closed."""
        r = rot[0]
        if r is None or r.done:
            return
        minute = (pd.Timestamp(now) - pd.Timedelta(seconds=SETTLE_S)).floor("min")
        if pd.Timestamp(now).floor("min") != minute or r.next_k > minute:
            return                                             # nothing new to decide, or this minute's bars not read yet
        refresh(rot_bars, [s for _, s, _ in r.names], now, 10.0)
        evs = rotation_walk(r, rot_bars, minute)
        changed_now = any(e["kind"] == "change" and pd.Timestamp(e["minute"]) == minute for e in evs)
        if not r.done and r.rest is not None and r.next_k == minute + pd.Timedelta(minutes=1) \
                and (changed_now or r.rest[2].one_bar):
            try:                                               # the decision is this minute's: its quote, now
                q = with_deadline(data.quote, r.rest[1])
            except Exception:  # noqa: BLE001 — unknown fails the spread must
                q = None
            r.nbbo = [q[0], q[1]] if q else None
        for ev in evs:
            kind = ev.pop("kind")
            if kind == "change":
                at_ = pd.Timestamp(ev.pop("minute"))
                if rot_quiet[0] is not None and at_ <= rot_quiet[0]:
                    continue                                   # walked again after a restart: journaled already
                live = at_ == minute
                rot_log("change", at=at_, minute=at_.tz_convert(ET).strftime("%H:%M"), live=live,
                        **({"nbbo": r.nbbo} if live else {}), **ev)
            else:
                names = [[x[0], x[1]] for x in r.names]
                if kind == "attempt":
                    ev["bar"] = pd.Timestamp(ev["bar"])
                rot_log(kind, done=r.done, names=names, changes=r.changes, rank_minutes=dict(r.rank_minutes), **ev)

    def gap_why_note(reasons: dict[str, sl.GapWhy], minute: pd.Timestamp) -> None:
        """Tally this minute's reason for each rule, and journal the reasons when one of them changed."""
        for code, w in reasons.items():
            per = gap_why_tally.setdefault(code, {})
            per[w.why] = per.get(w.why, 0) + 1
            gap_why_last[code] = w.row()
        key = tuple((code, w.why) for code, w in reasons.items())
        if key and key != gap_why_seen[0]:
            gap_why_seen[0] = key
            log("gap_rules", day=day, symbol=primary, minute=minute.tz_convert(ET).strftime("%H:%M"),
                rules={code: w.row() for code, w in reasons.items()})

    def gap_save(p: GapPlan, s: sl.WTState) -> None:
        p.wt.update(entry_bar=s.entry_bar.isoformat(), partial_done=s.partial_done, last_bucket=s.last_bucket,
                    stop_reason=s.stop_reason, stop=s.stop, bv_fail=s.bv_fail,
                    bv_bar=s.bv_bar.isoformat() if s.bv_bar is not None else "")
        store.save(p)

    def gap_wt(p: GapPlan, b: pd.DataFrame | None, now: dt.datetime) -> sl.WTState | None:
        """The exit's state for a filled plan: started once its entry bar has closed, or put back after a restart
        from what the plan file kept. The entry bar is the first closed bar after the signal that reached the
        trigger, as the simulation enters; until it has closed, the stop at the broker is the whole exit."""
        if not p.avg_entry or p.avg_entry <= p.initial_stop:
            return None
        entry_bar = p.wt.get("entry_bar")
        if not entry_bar:
            if not p.wt.get("fill_seen"):
                p.wt["fill_seen"] = pd.Timestamp(now).isoformat()
                store.save(p)
            t = sl.entry_bar_time(b, staged) if b is not None and staged is not None else None
            if t is None:
                seen_at = pd.Timestamp(p.wt["fill_seen"])
                if (pd.Timestamp(now) - seen_at).total_seconds() < 120 + SETTLE_S:
                    return None
                t = seen_at.floor("min")                       # no bar shows the trigger: the minute the fill was seen in
            entry_bar = pd.Timestamp(t).isoformat()
        s = sl.wt_start(p.avg_entry, p.initial_stop, p.filled_qty, pd.Timestamp(entry_bar), None,
                        bv_fail=bool(p.wt.get("bv_fail")),
                        bv_bar=pd.Timestamp(p.wt["bv_bar"]) if p.wt.get("bv_bar") else None)
        s.partial_done = bool(p.wt.get("partial_done")) or p.partial_qty > 0
        s.last_bucket = int(p.wt.get("last_bucket", -1))
        s.stop_reason = str(p.wt.get("stop_reason", "stop"))
        s.stop = max(float(p.stop), float(p.wt.get("stop", 0.0)), s.entry if s.partial_done else s.stop0)
        gap_save(p, s)
        return s

    def gap_exit(p: GapPlan, q: tuple[float, float, pd.Timestamp] | None, b: pd.DataFrame | None,
                 now: dt.datetime) -> None:
        """The registered gap exit for the plan in play (wt.live.setups_live, wt_step): half off at the first target
        on the bid, the stop to breakeven, the stagnation stop before that target, then the stop trailed under each
        completed five-minute low and out on a five-minute close under EMA9; and out after a breakout bar without
        volume. The protective stop itself rests at the broker."""
        nonlocal wt
        if p.wt.get("exit"):                                   # an exit already asked for, and not done yet
            oms.exit_now(p, None, reason=str(p.wt["exit"]), market=True)
            return
        if p.state != "in_position":
            return
        if wt is None:
            wt = gap_wt(p, b, now)
            if wt is None:
                return
        # the first target is a quote decision: the bid at or over it, sold with a limit at it, never on the mid
        if not wt.partial_done and wt.qty0 >= 2 and p.partial_ids \
                and 0 < sum(x.qty for x in broker.positions() if x.symbol == p.symbol) <= wt.qty0 - wt.partial_qty:
            # a first-target sale whose cancel was not confirmed, and that filled after all: the half is gone, so
            # the target is done and the stop goes to breakeven; the other half is never sold at the target too
            log("partial_filled", trade_id=p.trade_id, symbol=p.symbol, code=p.code, qty=wt.partial_qty,
                limit=wt.t1_price, reason="partial_t1", state=p.state, late=True)
            sl.wt_on_partial(wt)
            gap_save(p, wt)
        minute = str(pd.Timestamp(now).floor("min"))
        t1_due = not wt.partial_done and pd.Timestamp(now) >= wt.entry_bar + pd.Timedelta(minutes=1)
        # a try whose stop cancel was not confirmed sent no sale: inside its DEC-0071 hold it is asked again at the
        # next poll, on a fresh quote, instead of waiting for the next minute (DEC-0075)
        t1_held = t1_due and oms.held_for_exit(p)
        t1_hold = t1_due and bool(p.stop_id) and p.exit_hold_stop == p.stop_id     # running, or run out this poll
        if t1_due and (p.wt.get("t1_try") != minute or t1_held) \
                and (px := target_exit_limit(q, wt.t1_price)) is not None:
            p.wt["t1_try"] = minute                            # one try a minute: an unfilled try cost its time without
            store.save(p)                                      # half the stop, so it is never repeated at each poll
            reason = "target_all" if wt.qty0 < 2 else "partial_t1"
            sold = oms.partial_exit(p, wt.partial_qty, px, reason)
            if sold:
                log("partial_filled", trade_id=p.trade_id, symbol=p.symbol, code=p.code, qty=sold, limit=px,
                    reason=reason, state=p.state)
                if p.state == "in_position":
                    sl.wt_on_partial(wt)                       # the stop goes to breakeven (moved below)
                    gap_save(p, wt)
            if p.state != "in_position":
                return
        elif t1_hold:
            # the sale is not asked again now (the bid has left the target, or the hold ran out since reconcile): the
            # hold ends and the stop goes back in this poll, not at the next poll's reconcile, after its X3 check
            # (DEC-0075, DEC-0073). A cancel the broker reports only after this is replaced by the next reconcile.
            oms.end_hold(p)
            oms.ensure_stop(p)
        # the newest closed bar, once
        if b is not None and len(b) and str(b.t.iloc[-1]) != p.wt.get("bar"):
            last = pd.Timestamp(b.t.iloc[-1])
            wt_tries.clear()                                   # a stop the broker would not take is asked again each bar
            late = False
            if p.bv and not p.wt.get("bv_known"):
                at = np.nonzero((pd.to_datetime(b.t, utc=True) == wt.entry_bar).to_numpy())[0]
                got = sl.gap_bv(p.bv, b, gctx.get("pm_bars") if gctx else None, int(at[0])) if len(at) else None
                if got is not None:
                    wt.bv_bar, wt.bv_fail = pd.Timestamp(b.t.iloc[got[0]]).tz_convert("UTC"), got[1]
                    p.wt["bv_known"] = True
                    late = got[1] and last > wt.bv_bar         # its bar was not read when it closed: out now
            acts = sl.wt_step(b, wt)
            if late:
                acts = [sl.WTAction("exit", "breakout_volume_fail")]
            p.wt["bar"] = str(b.t.iloc[-1])
            gap_save(p, wt)
            for act in acts:
                if act.kind == "exit":
                    p.wt["exit"] = act.reason
                    store.save(p)
                    log("exit_signal", trade_id=p.trade_id, symbol=p.symbol, code=p.code, reason=act.reason)
                    oms.exit_now(p, None, reason=act.reason, market=True)
                    return
        # the stop where the exit wants it: breakeven after the target, then each completed five-minute low
        want = round(wt.stop, 2)
        if want > p.stop + 1e-9 and wt_tries.get(want, 0) < STOP_MOVE_TRIES:
            wt_tries[want] = wt_tries.get(want, 0) + 1
            moved = oms.move_stop(p, want)
            log("stop_moved" if moved else "stop_move_failed", trade_id=p.trade_id, symbol=p.symbol, code=p.code,
                stop=want, why="breakeven" if wt.stop_reason == "stop" else wt.stop_reason)
            if not moved and q is not None and 0 < float(q[0]) <= want:
                # the market is already under the stop the exit wants (a broker refuses such a stop): the
                # simulation is stopped out there, so the desk leaves too instead of keeping the old stop
                p.wt["exit"] = wt.stop_reason
                store.save(p)
                log("exit_signal", trade_id=p.trade_id, symbol=p.symbol, code=p.code, reason=wt.stop_reason,
                    why="stop_under_market")
                oms.exit_now(p, None, reason=wt.stop_reason, market=True)

    held_try: dict[str, dt.datetime] = {}
    loop_errs = [0]                                           # polls in a row that ended in loop_error
    quote_down: dict[str, dt.datetime] = {}                   # each open plan's first failed quote read in a row
    quote_paged: set[str] = set()                             # plans whose current quote outage has paged
    bare_polls: dict[str, int] = {}                           # polls in a row each plan's position had no resting stop
    while True:
        now = clock()
        if now < open_dt:
            sleep(min(60, (open_dt - now).total_seconds()))
            continue
        if now >= close_dt:
            break
        try:
            if killed() != kill_on:
                kill_on = not kill_on
                log("kill_state", on=kill_on)
            # ---- DEC-0073 X3: a position the desk owns with no resting stop, as the last poll left it. First and in
            # its own block: a protect step that raises cannot hide it, a failed read is unknown (never
            # "unprotected"), and it never costs the plan its exit management. A stop the desk replaces this poll
            # counts once, never twice. ----
            try:
                in_play = [p for p in [plan, *held] if p is not None and p.state in ACTIVE_POSITION]
                if in_play:
                    qty = {x.symbol: x.qty for x in broker.positions()}
                    for p in in_play:
                        q = qty.get(p.symbol, 0)
                        bare = q > 0 and not oms.held_for_exit(p) and oms.stop_cover(p.symbol) < q
                        bare_polls[p.trade_id] = bare_polls.get(p.trade_id, 0) + 1 if bare else 0
                        if bare and not xfired:                # once a stop has fired, it is not journaled again
                            log("unprotected", trade_id=p.trade_id, polls=bare_polls[p.trade_id])
            except Exception as e:  # noqa: BLE001
                log("unprotected_unread", error=e.__class__.__name__)
            # ---- sync and protect ----
            for p in [plan, *held]:
                if p is None or not p.active:
                    continue
                protect(p)
            # ---- positions no plan of today opened: out at once (retried every 5 minutes). Its own block: a
            # fault here must never cost the day's plan its exit management. ----
            try:
                sweep_positions()
                for h in held:
                    last = held_try.get(h.trade_id)
                    if h.state in ACTIVE_POSITION and now < verify_dt and \
                            (last is None or (now - last).total_seconds() >= HELD_EXIT_RETRY_S):
                        held_try[h.trade_id] = now
                        oms.exit_now(h, None, reason="adopted_exit", market=True)
                    close_out(h)
                held[:] = [h for h in held if h.active]
            except Exception as e:  # noqa: BLE001
                log("held_error", error=repr(e)[:300])
            # ---- bars ----
            if gap and not gap_selected:
                gap_select()                                   # at the first poll of the session: the pool is 09:25's
            if gap and not rotate and rot[0] is None:            # HYP-0072 trading is the rule itself: no shadow
                try:
                    rot_start()
                except Exception as e:  # noqa: BLE001 — the shadow must never cost the desk anything
                    rot[0] = Rotation([], pd.Timestamp(open_dt), done="error")
                    log("rotation_shadow_error", day=day, where="start", error=e.__class__.__name__)
            live = sorted(s for s, st in names.items() if not st.done)
            if gap and rotate:
                live = [s for _, s, _ in grot[0].names] if grot[0] is not None and not gap_done else []
            elif gap:
                live = [primary] if primary is not None and not gap_done else []
            watch = sorted(set(live) | ({plan.symbol} if plan is not None else set()))
            seen = {s: (bars[s].t.iloc[-1] if s in bars and len(bars[s]) else None) for s in watch}
            try:
                fetch_bars(watch, now)
            except Exception as e:  # noqa: BLE001 — no new bars: nothing is decided on old ones
                log("data_timeout", what="bars", error=e.__class__.__name__)
                watch = []
                if isinstance(plan, GapPlan) and plan.state == "entry_working":
                    # a gap order rests only while the newest bars say it should: unread bars, no order
                    oms.cancel_entry_remainder(plan)
                    gap_rested[0] = ""
                    log("entry_cancelled", trade_id=plan.trade_id, symbol=plan.symbol, why="bars_unread",
                        filled=plan.filled_qty, state=plan.state, code=plan.code)
            # ---- the plan in play ----
            if plan is not None:
                manage(plan, now)
                if not plan.active:
                    finish(plan, now)
            # ---- the universe: after the plan in play, so a slow scan never delays an exit ----
            if curve is not None and symbols and now < entry_end and universe.due(now):
                try:
                    cands = universe.candidates(with_deadline(data.snapshots, symbols, deadline_s=120.0), now)
                    refresh(proposed, cands, now, 60.0)
                    new = universe.admit(cands, proposed, now)
                    for sym in new:
                        bars[sym] = proposed.pop(sym)
                    join(new, now)
                except Exception as e:  # noqa: BLE001 — a failed scan is retried at the next mark
                    universe.last_scan = now
                    log("scan_failed", error=e.__class__.__name__)
            # ---- entries ----
            if gap:
                if watch:
                    gap_entries(now)
                try:
                    rot_step(now)                              # after the desk's own entries, never before
                except Exception as e:  # noqa: BLE001 — the shadow must never cost the desk anything
                    if e.__class__.__name__ not in rot_said:
                        rot_said.append(e.__class__.__name__)
                        log("rotation_shadow_error", day=day, where="step", error=e.__class__.__name__)
            elif now < entry_end:
                for sym in live:
                    b = bars.get(sym)
                    if plan is not None and sym == plan.symbol:
                        continue                               # its next attempt reads from the bar after its exit
                    if sym in watch and b is not None and len(b) and b.t.iloc[-1] != seen.get(sym):
                        consider(sym, now)
        except Exception as e:  # noqa: BLE001 — never crash with an open position; log and keep protecting
            log("loop_error", error=repr(e)[:300])
            loop_errs[0] += 1
            if loop_errs[0] == LOOP_ERROR_PAGE_POLLS:
                pager.once_per_day("paper-s:loop-error", "Gap Hunter's poll keeps failing",
                                   f"The last {page.count(loop_errs[0])} polls in a row failed. It keeps trying; "
                                   "the session's journal (loop_error) has each error.", 5)
        else:
            loop_errs[0] = 0
        sleep(poll_s)

    # ---- after the close ----
    try:
        for p in [plan, *held]:
            if p is not None and p.active:
                oms.sync(p)
        long_left = short_left = False
        for pos in broker.positions():
            owner = next((p for p in [plan, *held] if p is not None and p.symbol == pos.symbol and p.active), None)
            if pos.qty > 0:
                long_left = True
                if owner is not None and owner.state in ACTIVE_POSITION:
                    try:
                        oms.end_hold(owner)                    # no exit is asked again tonight (DEC-0071)
                        oms.ensure_stop(owner)                 # a GTC stop keeps protecting overnight
                    except Exception as e:  # noqa: BLE001 — one position's stop must not cost the others theirs
                        log("overnight_stop_failed", trade_id=owner.trade_id, error=e.__class__.__name__)
                protected: bool | None = None                 # a position left for the owner is not the desk's (X2)
                if pos.symbol not in left_alone:
                    try:
                        protected = oms.stop_cover(pos.symbol, gtc_only=True) >= pos.qty
                    except Exception:  # noqa: BLE001 — unread is unknown, never "unprotected"
                        protected = None
                log("END_OF_DAY_NOT_FLAT", symbol=pos.symbol, qty=pos.qty, protected=protected)
                pager.fire("paper-s:not-flat", "Sleeve S NOT FLAT at the close",
                           f"A long position of {page.count(pos.qty)} share(s) is still open after the close; the "
                           "session's journal (END_OF_DAY_NOT_FLAT) names every one. One this desk owns keeps a GTC "
                           "stop overnight and is sold at the next session's open. Check the broker.", 5)
            elif pos.qty < 0:
                short_left = True
                log("END_OF_DAY_NOT_FLAT", symbol=pos.symbol, qty=pos.qty, short=True,
                    cancelled=oms.cancel_resting(pos.symbol))
                pager.fire("paper-s:short-at-close", "Sleeve S is SHORT at the close",
                           f"Short {page.count(abs(pos.qty))} share(s). Nothing is bought back automatically; the "
                           "session's journal (END_OF_DAY_NOT_FLAT) names every one. Follow the not-flat runbook.", 5)
        flat = {pos.symbol for pos in broker.positions() if pos.qty}
        resting = {o.symbol for o in broker.open_orders()}
        for sym in sorted((guard.limits.allowlist & resting) - flat):
            cancelled = oms.cancel_resting(sym)                # flat: no order may outlive the session
            if cancelled:
                log("cancelled_resting_after_close", symbol=sym, orders=cancelled)
        for p in [plan, *held, *made]:
            if p is not None:
                close_out(p)
        if not long_left:                                     # verified: an earlier session's page is over
            pager.resolve("paper-s:not-flat", "Sleeve S: no long position after the close",
                          "The account held no long position after the close.")
        if not short_left:
            pager.resolve("paper-s:short-at-close", "Sleeve S: no short position after the close",
                          "The account held no short position after the close.")
    except Exception as e:  # noqa: BLE001
        log("END_OF_DAY_NOT_FLAT", error=f"could not verify flat after the close: {e!r}"[:300])
        pager.fire("paper-s:not-flat", "Sleeve S could not verify flat after the close",
                   "The broker could not be read after the close, or the end-of-day checks failed part way. Check "
                   "the account; the session's journal (END_OF_DAY_NOT_FLAT) has the error.", 5)
    log("session_end", trial=trial, entries_off=off, **({"primary": primary is not None, "gap_done": gap_done}
                                                         if gap else {}),
        **({"rotation_shadow": rot[0].summary()} if gap and rot[0] is not None else {}),
        **({"rotation": grot[0].summary()} if rotate and grot[0] is not None else {}), universe=len(universe.joined), scans=universe.scans,
        entries=va.trades_by_day.get(day.isoformat(), 0), closed=closed_n, realised_R=round(realised, 4),
        day_stop=day_stopped(losers, realised), blocked=dict(sorted(counts.items())),
        virtual=asdict(va) if va_ok else None)


if __name__ == "__main__":
    run()
