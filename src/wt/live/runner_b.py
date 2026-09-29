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
  * refusals (disk floor, untrustworthy state, stale macro calendar, blocked account) are journaled and exit 0.
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
from wt.core.clock import ET, et, to_utc_iso
from wt.core.config import DATA_DIR, ROOT, env
from wt.data.alpaca import DATA, AlpacaREST
from wt.oms.manager import ACTIVE_POSITION, OMS, PlanStore, TradePlan
from wt.risk import events
from wt.risk.pretrade import Context, PreTradeGuard, load_limits
from wt.risk.virtual_account import StateError, VirtualAccount
from wt.signals import setups

SIG, TRADE, STRATEGY = "QQQ", "QQQM", "B"
LIVE = DATA_DIR / "live"
KILL = ROOT / "KILL"          # while this file exists: no new entries (exits and stops keep being managed)
RISK_PCT, MAX_SPREAD_PCT, STALE_S = 1.0, 0.10, 150
DATA_DEADLINE_S = 15.0        # any single market-data call
MIN_FREE_GB = 3.0
FALLBACK_STOP_PCT = 1.0       # protective stop for a position with no plan on record (then alert)
T = TypeVar("T")
_pool = cf.ThreadPoolExecutor(max_workers=4, thread_name_prefix="data")


def log(event: str, **kw: Any) -> None:
    """Append to the journal. Never raises: a full disk must not kill a runner that holds a position (H4)."""
    rec = {"ts": dt.datetime.now(dt.UTC).isoformat(), "event": event, **kw}
    line = json.dumps(rec, default=str)
    try:
        LIVE.mkdir(parents=True, exist_ok=True)
        with open(LIVE / "journal.jsonl", "a") as f:
            f.write(line + "\n")
    except OSError as e:
        print(f"JOURNAL WRITE FAILED ({e.__class__.__name__}): {line}", file=sys.stderr, flush=True)
    print(line, flush=True)


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
        """sigma = mean over prior 14 sessions of mean |close(:59/:29 marks)/open - 1| (same as backtest); SIP history."""
        prior = [d for d in sessions if d < day][-14:]
        vals, prev_close = [], None
        for d in prior:
            b = self.a.bars([SIG], "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, "15:59")), feed="sip")
            if len(b) > 60:
                vals.append(float(np.mean(np.abs(b.c.iloc[29::30].to_numpy() / b.o.iloc[0] - 1))))
                prev_close = float(b.c.iloc[-1])
        return float(np.mean(vals)), prev_close


def book(plan: TradePlan, oms: OMS, va: VirtualAccount, va_path: Any, day: dt.date, nxt: dt.date) -> None:
    """Account a closed plan once, with the real fill price (C1). Idempotent by trade id."""
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
    va.record_round_trip(day, nxt, cost=plan.filled_qty * entry, proceeds=plan.filled_qty * px, trade_id=plan.trade_id)
    va.save(va_path)
    plan.recorded = True
    r_mult = (px - entry) / (entry - plan.stop) if entry > plan.stop else None
    log("trade_closed", day=day, symbol=plan.symbol, entry=entry, exit=px, exit_price_estimated=estimated,
        stop=plan.stop, qty=plan.filled_qty, R=r_mult, reason=plan.exit_reason, trade_id=plan.trade_id,
        virtual=asdict(va))


def run(day: dt.date | None = None, poll_s: float = 20.0, broker: Any = None, rest: Any = None,
        now_fn: Callable[[], dt.datetime] | None = None, sleep_fn: Callable[[float], None] | None = None) -> None:
    """broker/rest/now_fn/sleep_fn are injected by the session simulation tests; production uses the defaults."""
    if env("MODE", "backtest") != "paper":
        raise SystemExit("runner_b refuses to start: MODE must be 'paper'")
    clock = now_fn or (lambda: dt.datetime.now(ET))
    sleep = sleep_fn or time.sleep
    now = clock()
    day = day or now.date()
    free_gb = shutil.disk_usage(ROOT).free / 1e9
    if free_gb < MIN_FREE_GB:
        log("refuse_to_arm", reason=f"free disk {free_gb:.1f} GB under the {MIN_FREE_GB:.0f} GB floor")
        return
    if broker is None:
        from wt.brokers.alpaca_paper import AlpacaPaperBroker  # asserts the paper-only lock
        broker = AlpacaPaperBroker()
    a = rest if rest is not None else AlpacaREST(per_minute=150)
    acct = broker.account()
    if not acct.is_paper or acct.blocked:
        log("refuse_to_arm", reason="account not paper or blocked")
        return
    data = LiveData(a)
    cal = a.calendar((day - dt.timedelta(days=40)).isoformat(), (day + dt.timedelta(days=10)).isoformat())
    if day not in set(cal.date):
        log("no_session", day=day)
        return
    sessions = sorted(cal.date)
    nxt = next(d for d in sessions if d > day)
    row = cal[cal.date == day].iloc[0]
    open_dt, close_dt = et(day, str(row.open)[:5]), et(day, str(row.close)[:5])
    if now >= close_dt:
        log("no_session", day=day, reason="started after the close")
        return
    if now < open_dt - dt.timedelta(hours=3):
        log("too_early", day=day, reason="started more than 3 h before the open; the scheduled start will run it")
        return
    flatten_dt, market_dt, verify_dt = (close_dt - dt.timedelta(minutes=m) for m in (10, 5, 2))
    va_path = LIVE / "virtual_account.json"
    try:
        va = VirtualAccount.load(va_path)
    except StateError as e:
        log("refuse_to_arm", reason=str(e))
        return
    va.roll(day)
    if not events.coverage_ok(day):
        log("refuse_to_arm", reason="macro calendar < 30 days ahead")
        return

    store = PlanStore(LIVE / f"plan_{day.isoformat()}.json")
    plan: TradePlan | None = store.load()
    guard = PreTradeGuard(load_limits(STRATEGY))

    def context(symbol: str) -> Context:
        return Context(now=clock(),
                       position_qty=sum(p.qty for p in broker.positions() if p.symbol == symbol),
                       open_orders=broker.open_orders(), kill=KILL.exists(), latched=va.latched,
                       session_open=open_dt, session_close=close_dt,
                       entries_today=va.trades_by_day.get(day.isoformat(), 0),
                       orders_today=plan.seq if plan else 0)

    def on_entry(p: TradePlan) -> None:
        if va.count_entry(day, p.trade_id):
            va.save(va_path)
            log("entry_filled", trade_id=p.trade_id, qty=p.filled_qty, price=p.avg_entry)

    oms = OMS(broker, guard=guard, context=context, persist=store.save, on_entry=on_entry, strategy=STRATEGY,
              sleep=sleep)
    sigma, prev_close = data.sigma_and_prev_close(day, sessions)
    log("armed", day=day, sigma=sigma, prev_close=prev_close, flatten=flatten_dt, kill=KILL.exists(),
        resumed_plan=plan.state if plan else None, virtual=asdict(va))

    def fallback_stops() -> dict[str, float]:
        if plan is not None and plan.active:
            return {}
        return {p.symbol: round(p.avg_price * (1 - FALLBACK_STOP_PCT / 100), 2) for p in broker.positions()
                if p.symbol == TRADE and p.qty > 0}

    acts = oms.reconcile({TRADE}, fallback_stops(), plan=plan)
    if acts:
        log("reconcile_startup", actions=acts)
    if plan is not None:
        book(plan, oms, va, va_path, day, nxt)          # a close that happened while we were down (C4)

    while True:
        now = clock()
        if now < open_dt:
            sleep(min(60, (open_dt - now).total_seconds()))
            continue
        if now >= close_dt:
            break
        try:
            if plan is not None:
                oms.sync(plan)
                book(plan, oms, va, va_path, day, nxt)
            acts = oms.reconcile({TRADE}, fallback_stops(), plan=plan)
            if acts:
                log("reconcile", actions=acts)
            try:
                q = with_deadline(data.quote, TRADE)
            except (TimeoutError, cf.TimeoutError):
                q = None
                log("data_timeout", what="quote")
            last_mid = (q[0] + q[1]) / 2 if q else None
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
                book(plan, oms, va, va_path, day, nxt)
            if now >= verify_dt:
                qty = sum(p.qty for p in broker.positions() if p.symbol == TRADE)
                if qty != 0 and plan is not None and plan.state in ACTIVE_POSITION:
                    oms.exit_now(plan, None, reason="eod_verify", market=True)
                    book(plan, oms, va, va_path, day, nxt)
            if plan is not None and plan.state == "entry_working" and now >= et(day, "15:30"):
                oms.cancel_entry_remainder(plan)
            # ---- entries (at most one per day; never while any exposure exists) ----
            if plan is None and now < flatten_dt - dt.timedelta(minutes=20):
                blockers = []
                if KILL.exists():
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
                if not len(closed) or (pd.Timestamp(now) - closed.t.iloc[-1]).total_seconds() > STALE_S:
                    blockers.append("stale_signal_data")
                if not q or (q[1] - q[0]) / ((q[0] + q[1]) / 2) * 100 > MAX_SPREAD_PCT:
                    blockers.append("spread_or_no_quote")
                sig = None if blockers else setups.b_intraday_momentum(closed.reset_index(drop=True), sigma, prev_close)
                if sig and sig.bar_index == len(closed) - 1:          # only act on the bar that just closed
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
                            store.save(plan)
                            oms.place_entry(plan)
                            log("entry_placed" if plan.state == "entry_working" else "entry_not_placed",
                                trigger=trig, stop=stop, target=plan.target, qty=qty, ratio=ratio, policy=pol,
                                state=plan.state, detail=plan.log[-1:] if plan.log else None)
                        else:
                            log("signal_skipped_size", qty=qty, R=R)
                elif blockers and now.minute in (0, 30) and now.second < poll_s:
                    log("blocked", blockers=blockers)
        except Exception as e:  # noqa: BLE001 — never crash with an open position; log and keep protecting
            log("loop_error", error=repr(e)[:300])
        sleep(poll_s)

    # ---- after the close ----
    try:
        qty = sum(p.qty for p in broker.positions() if p.symbol == TRADE)
        if qty > 0:
            if plan is not None and plan.state in ACTIVE_POSITION:
                oms.ensure_stop(plan)                    # GTC stop keeps protecting overnight
            log("END_OF_DAY_NOT_FLAT", qty=qty, plan=plan.log if plan else None)
        else:
            cancelled = oms.cancel_resting(TRADE)        # flat: no GTC stop may outlive the position
            if cancelled:
                log("cancelled_resting_after_close", orders=cancelled)
        if plan is not None:
            book(plan, oms, va, va_path, day, nxt)
    except Exception as e:  # noqa: BLE001
        log("END_OF_DAY_NOT_FLAT", error=f"could not verify flat after the close: {e!r}"[:300])
    log("session_end", virtual=asdict(va))


if __name__ == "__main__":
    run()
