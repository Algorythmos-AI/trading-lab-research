"""Paper runner for Robot B's sleeve S, the stock desk (DEC-0066). MODE must be 'paper'.

First slice: the reversal rule on a universe known at scan time (HYP-0070), in one US$600 virtual book (HYP-0069).

What it shares with sleeve Q (wt.live.runner_b): nothing at run time. Its own paper account and key pair
(APCA_S_KEY_ID, APCA_S_SECRET_KEY; never APCA_API_*), journal (data/live/smallcap_journal.jsonl), plans and state
(var/smallcap/), kill file (var/smallcap/KILL), strategy tag (S) and process lock. It never reads or writes
data/live/plan_*.json, data/live/journal.jsonl or the QQQ rule's virtual account.

It refuses to start without its own key pair, or when its account is sleeve Q's. It places no entry while DEC-0066
does not read ACCEPTED, or while any of the session gates below is closed. A refusal turns entries off, never exit
management.

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
to start (key pair, account), a second runner, no lease, the session's close unknown, the stop rule, a position
adopted, a position over the hard caps, a short, a clock-skew block, and not flat (or not verified flat) after the
close. A page is fixed words and guarded counts: never a symbol, a price, an amount or an error's text; the journal
row written just before it holds those. The `armed` row says whether this session pages.

Not in this slice: the gap entries (which need the order manager's partial exit).
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
from dataclasses import asdict, replace
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
from wt.oms.manager import ACTIVE_POSITION, OMS, PlanStore, TradePlan
from wt.ops import alerts as page
from wt.ops import locks
from wt.ops.alerts import Alerts, Pager
from wt.risk import stop_rule
from wt.risk.pretrade import Context, PreTradeGuard, load_limits
from wt.risk.virtual_account import StateError, VirtualAccount

STRATEGY = "S"
DIR = STATE_DIR / "smallcap"
PLANS = DIR / "plans"
KILL = DIR / "KILL"
VA_PATH = DIR / "virtual_account.json"
JOURNAL = DATA_DIR / "live" / "smallcap_journal.jsonl"
RECORD = ROOT / "research" / "decisions" / "DEC-0066-robot-b-sleeve-s-paper-desk.md"
RUNNER_LOCK = locks.RUNNER_LOCK_S          # "paper-s-runner": the deploy gate reads it too
KEY_ID, KEY_SECRET = "APCA_S_KEY_ID", "APCA_S_SECRET_KEY"
Q_KEY_ID = "APCA_API_KEY_ID"

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
ENTRY_CUTOFF_MIN = 30           # no new entry in the last half hour before the close
SEQ_BLOCK = 1000                # each plan's order ids come from its own block of sequence numbers (see plan_seq)
BAR_PAGES = 20
CONNECT_TRIES, CONNECT_WAIT_S = 5, 15.0
RUNNER_LOCK_WAIT_S = 10.0       # how long a starting runner waits for its own process lock


# ---- journal ------------------------------------------------------------------------------------------------------
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


def key_refusal(environ: Mapping[str, str]) -> str | None:
    """Why the key pair in the environment may not run sleeve S, or None. It never falls back to sleeve Q's keys."""
    kid, secret = environ.get(KEY_ID, "").strip(), environ.get(KEY_SECRET, "").strip()
    if not kid or not secret:
        return f"{KEY_ID} and {KEY_SECRET} are not both set"
    if kid == environ.get(Q_KEY_ID, "").strip():
        return f"{KEY_ID} is sleeve Q's key ({Q_KEY_ID})"
    return None


def account_refusal(own: str | None, q_account: Callable[[], str | None] | None) -> str | None:
    """Why this account may not run sleeve S, or None. `q_account` reads sleeve Q's account number, or is None when
    this machine holds no keys for it. A number that cannot be read is not a number that differs."""
    if not own:
        return "sleeve S's account number could not be read"
    if q_account is None:
        return None
    try:
        other = q_account()
    except Exception as e:  # noqa: BLE001 — unknown is a refusal
        return f"sleeve Q's account number could not be read ({e.__class__.__name__})"
    if not other:
        return "sleeve Q's account number could not be read"
    return "this is sleeve Q's account" if str(other) == str(own) else None


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
                p = PlanStore(f).load()
            except (OSError, ValueError, TypeError) as e:
                log("plan_unreadable", file=f.name, error=e.__class__.__name__)
                self.broken = True
                continue
            if p is not None:
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
    for row in p.log:
        if isinstance(row, list) and len(row) == 6 and row[0] == "staged":
            try:
                return sl.Staged(p.symbol, int(row[3]), pd.Timestamp(row[1]), p.trigger, p.limit, p.stop,
                                 float(row[5]), dt.datetime.fromisoformat(row[2]), float(row[4]))
            except (TypeError, ValueError):
                return None
    return None


# ---- the session ---------------------------------------------------------------------------------------------------
def run(day: dt.date | None = None, poll_s: float = 10.0, broker: Any = None, rest: Any = None,
        now_fn: Callable[[], dt.datetime] | None = None, sleep_fn: Callable[[float], None] | None = None,
        account_number: str | None = None, q_account: Callable[[], str | None] | None = None,
        environ: Mapping[str, str] | None = None, alerts: Any = None) -> None:
    """broker, rest, now_fn, sleep_fn, account_number, q_account and alerts are injected by the replay tests;
    production builds them from sleeve S's own keys. A run with an injected broker pages only through `alerts`."""
    if env("MODE", "backtest") != "paper":
        raise SystemExit("runner_s refuses to start: MODE must be 'paper'")
    pager = Pager(alerts if alerts is not None else (Alerts() if broker is None else None))
    try:
        _start(day, poll_s, broker, rest, now_fn, sleep_fn, account_number, q_account, environ, pager)
    finally:
        pager.close()                                         # also on a refusal: its page is still delivered


def _start(day: dt.date | None, poll_s: float, broker: Any, rest: Any, now_fn: Callable[[], dt.datetime] | None,
           sleep_fn: Callable[[float], None] | None, account_number: str | None,
           q_account: Callable[[], str | None] | None, environ: Mapping[str, str] | None, pager: Pager) -> None:
    e = os.environ if environ is None else environ
    why = key_refusal(e)
    if why:
        log("refuse_to_start", reason=why)
        pager.once_per_day("paper-s:refused-keys", "Sleeve S refused to start: key pair",
                           "Its own key pair is missing or is not its own; the session's journal (refuse_to_start) "
                           "says which. No order was sent and nothing is managed. See the position alerts "
                           "runbook.", 4)
        raise SystemExit(f"runner_s refuses to start: {why}")
    clock = now_fn or (lambda: dt.datetime.now(ET))
    sleep = sleep_fn or time.sleep
    day = day or clock().date()
    if broker is not None:
        _guarded(day, poll_s, broker, rest, clock, sleep, account_number, q_account, pager)
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
        reader: Callable[[], str | None] | None = None
        if e.get(Q_KEY_ID, "").strip():
            def reader() -> str | None:
                from wt.brokers.alpaca_read import AccountReader
                return AccountReader().account_number()
        _guarded(day, poll_s, broker, rest, clock, sleep, getattr(broker, "account_number", None), reader, pager)


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


def _guarded(day: dt.date, poll_s: float, broker: Any, rest: Any, clock: Callable[[], dt.datetime],
             sleep: Callable[[float], None], account_number: str | None,
             q_account: Callable[[], str | None] | None, pager: Pager) -> None:
    why = account_refusal(account_number, q_account)
    if why:
        log("refuse_to_start", reason=why)
        pager.once_per_day("paper-s:refused-account", "Sleeve S refused to start: account",
                           "Its account could not be told apart from sleeve Q's, or is sleeve Q's; the session's "
                           "journal (refuse_to_start) says which. No order was sent and nothing is managed. See "
                           "the position alerts runbook.", 4)
        raise SystemExit(f"runner_s refuses to start: {why}")
    _session(day, poll_s, broker, rest, clock, sleep, pager)


def _session(day: dt.date, poll_s: float, broker: Any, rest: Any, clock: Callable[[], dt.datetime],
             sleep: Callable[[float], None], pager: Pager) -> None:
    off: list[str] = []                 # why entries are off for the whole session (exits keep being managed)

    def refuse(reason: str) -> None:
        off.append(reason)
        log("refuse_to_arm", reason=reason, exits_only=True)

    if not accepted():
        refuse("DEC-0066 does not read ACCEPTED")
    if sl.TRIAL not in switched_on():
        refuse(f"{sl.TRIAL} is not switched on (config/risk.yaml S.switched_on; DEC-0066 section 2)")
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
                       open_orders=broker.open_orders(), kill=KILL.exists(), latched=va.latched,
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
        log("entry_filled", trade_id=p.trade_id, symbol=p.symbol, qty=p.filled_qty, price=p.avg_entry,
            nbbo=nbbo(p.symbol))

    made: list[TradePlan] = []                                # plans created by this process today
    oms = OMS(broker, guard=guard, context=context, persist=store.save, on_entry=on_entry, strategy=STRATEGY,
              sleep=sleep)

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
        px = px if px is not None else p.stop
        entry = p.avg_entry or 0.0
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
            r_mult = (px - entry) / (entry - p.stop) if attributed and entry > p.stop else None
            if log("trade_closed", day=trade_day, trial=sl.TRIAL if attributed else None, symbol=p.symbol,
                   entry=entry, exit=px, exit_price_estimated=estimated, stop=p.stop, qty=p.filled_qty, R=r_mult,
                   reason=p.exit_reason, trade_id=p.trade_id, origin=p.origin,
                   booked=attributed and priced and va_ok,
                   virtual=asdict(va) if va_ok else None):
                journaled.add(p.trade_id)
                if attributed and trade_day == day:
                    x = -1.0 if r_mult is None or estimated else float(r_mult)
                    closed_n, realised = closed_n + 1, realised + x
                    losers = losers + 1 if x < 0 else 0
        if va_ok and not account_unsaved and p.trade_id in journaled:
            p.recorded = True
            store.save(p)

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

    try:
        sweep_positions()
        for p in [plan, *held]:
            if p is not None:
                acts = oms.reconcile({p.symbol}, {}, plan=p)
                if acts:
                    log("reconcile_startup", actions=acts)
    except Exception as e:  # noqa: BLE001
        log("startup_reconcile_error", error=repr(e)[:300])

    # ---- the universe and the names in it ----
    curve: np.ndarray | None = None
    rule_curve: np.ndarray | None = None
    symbols: list[str] = []
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

    kill_on = KILL.exists()
    log("armed", day=day, trial=sl.TRIAL, entries_off=off, kill=kill_on, flatten=flatten_dt, symbols=len(symbols),
        resumed_plan=plan.trade_id if plan else None, held=[p.trade_id for p in held],
        day_stop=day_stopped(losers, realised), skew_s=measure_skew(broker, clock),
        virtual=asdict(va) if va_ok else None, stock_feed="sip", pages=pager.alerts is not None, role=role,
        lease=lease_state, record_accepted=accepted())

    def close_out(p: TradePlan) -> None:
        book(p, dt.date.fromisoformat(p.date))

    def finish(p: TradePlan, when: dt.datetime) -> None:
        """The day's plan reached a terminal state: book it and move its name on."""
        nonlocal plan, staged
        close_out(p)
        traded = p.state == "closed" and bool(p.filled_qty)
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
        oms.place_entry(p)
        log("entry_placed" if p.state == "entry_working" else "entry_not_placed", trade_id=p.trade_id, qty=qty,
            limit=s.limit, expires=s.expires_at, state=p.state, detail=p.log[-1:] if p.log else None, **row)
        if p.active:
            plan, staged = p, s
        else:
            st.done = "not_placed"
            bump("not_placed")

    def manage(p: TradePlan, now: dt.datetime) -> None:
        """The day's plan: cancel an entry the simulation would not have filled; exit an open position."""
        if p.state == "entry_working":
            b = bars.get(p.symbol)
            if staged is None:
                verdict: str | None = "staged_unreadable"      # its life and its stop cannot be judged: it may not rest
            else:
                verdict = sl.entry_verdict(b, staged, p.filled_qty, now) if b is not None else None
            if verdict is None and (now >= entry_end or kill_on):
                verdict = "kill_file" if kill_on else "entry_window_closed"
            if verdict is not None:
                oms.cancel_entry_remainder(p)
                log("entry_cancelled", trade_id=p.trade_id, symbol=p.symbol, why=verdict, filled=p.filled_qty,
                    state=p.state)
                if p.state == "aborted":
                    bump(verdict)
        if p.state in ACTIVE_POSITION:
            q = None
            try:
                q = with_deadline(data.quote, p.symbol)
            except Exception:  # noqa: BLE001
                log("data_timeout", what="quote", symbol=p.symbol)
            b = bars.get(p.symbol)
            # the end-of-day steps below need nothing but the position; the target and the stagnation stop need the fill
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
            elif target is not None and (px := target_exit_limit(q, target)) is not None:
                oms.exit_now(p, px, reason="target")
            elif p.avg_entry and b is not None and entry_t is not None and \
                    sl.stagnant(b, entry_t, p.avg_entry, p.stop):
                oms.exit_now(p, None, reason="time_stop_5m", market=True)

    held_try: dict[str, dt.datetime] = {}
    while True:
        now = clock()
        if now < open_dt:
            sleep(min(60, (open_dt - now).total_seconds()))
            continue
        if now >= close_dt:
            break
        try:
            if KILL.exists() != kill_on:
                kill_on = not kill_on
                log("kill_state", on=kill_on)
            # ---- sync and protect ----
            for p in [plan, *held]:
                if p is None or not p.active:
                    continue
                oms.sync(p)
                acts = oms.reconcile({p.symbol}, {}, plan=p)
                if acts:
                    log("reconcile", actions=acts)
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
            live = sorted(s for s, st in names.items() if not st.done)
            watch = sorted(set(live) | ({plan.symbol} if plan is not None else set()))
            seen = {s: (bars[s].t.iloc[-1] if s in bars and len(bars[s]) else None) for s in watch}
            try:
                fetch_bars(watch, now)
            except Exception as e:  # noqa: BLE001 — no new bars: nothing is decided on old ones
                log("data_timeout", what="bars", error=e.__class__.__name__)
                watch = []
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
            if now < entry_end:
                for sym in live:
                    b = bars.get(sym)
                    if plan is not None and sym == plan.symbol:
                        continue                               # its next attempt reads from the bar after its exit
                    if sym in watch and b is not None and len(b) and b.t.iloc[-1] != seen.get(sym):
                        consider(sym, now)
        except Exception as e:  # noqa: BLE001 — never crash with an open position; log and keep protecting
            log("loop_error", error=repr(e)[:300])
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
                    oms.ensure_stop(owner)                     # a GTC stop keeps protecting overnight
                log("END_OF_DAY_NOT_FLAT", symbol=pos.symbol, qty=pos.qty)
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
    log("session_end", trial=sl.TRIAL, entries_off=off, universe=len(universe.joined), scans=universe.scans,
        entries=va.trades_by_day.get(day.isoformat(), 0), closed=closed_n, realised_R=round(realised, 4),
        day_stop=day_stopped(losers, realised), blocked=dict(sorted(counts.items())),
        virtual=asdict(va) if va_ok else None)


if __name__ == "__main__":
    run()
