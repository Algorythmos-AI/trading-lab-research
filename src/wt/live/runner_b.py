"""Paper runner for strategy B (intraday momentum): signals on QQQ, orders on QQQM. MODE must be 'paper'.

Minimum safety set (plan rev 7, Step 4): server-side stop at entry (OMS), reconcile at startup + every loop,
kill file, flatten at close-10 min (market fallback at close-5), macro-event policy, virtual US$ account with
loss-limit latch, max 1 trade/day, data-freshness and spread checks, JSONL journal + decision logs.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import time
from dataclasses import asdict

import numpy as np
import pandas as pd

from wt.backtest.engine import size_position
from wt.core.clock import ET, et, to_utc_iso
from wt.core.config import DATA_DIR, ROOT, env
from wt.data.alpaca import DATA, AlpacaREST
from wt.oms.manager import OMS, TradePlan, reconcile
from wt.risk import events
from wt.risk.virtual_account import VirtualAccount
from wt.signals import setups

SIG, TRADE = "QQQ", "QQQM"
LIVE = DATA_DIR / "live"
KILL = ROOT / "KILL"          # touch this file to stop new entries (existing stops stay)
RISK_PCT, MAX_SPREAD_PCT, STALE_S = 1.0, 0.10, 150


def log(event: str, **kw) -> None:
    LIVE.mkdir(parents=True, exist_ok=True)
    rec = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "event": event, **kw}
    with open(LIVE / "journal.jsonl", "a") as f:
        f.write(json.dumps(rec, default=str) + "\n")
    print(rec, flush=True)


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
        return (q["bp"], q["ap"], pd.Timestamp(q["t"])) if q else None

    def sigma_and_prev_close(self, day: dt.date, sessions: list[dt.date]) -> tuple[float, float]:
        """sigma = mean over prior 14 sessions of mean |close(:59/:29 marks)/open - 1| (same as backtest); SIP history."""
        prior = [d for d in sessions if d < day][-14:]
        vals, prev_close = [], None
        for d in prior:
            b = self.a.bars([SIG], "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, "15:59")), feed="sip")
            if len(b) > 60:
                vals.append(float(np.mean(np.abs(b.c.iloc[29::30].to_numpy() / b.o.iloc[0] - 1))))
                prev_close = float(b.c.iloc[-1])
        return float(np.mean(vals)), prev_close


def run(day: dt.date | None = None, poll_s: float = 20.0) -> None:
    if env("MODE", "backtest") != "paper":
        raise SystemExit("runner_b refuses to start: MODE must be 'paper'")
    from wt.brokers.alpaca_paper import AlpacaPaperBroker
    a, broker = AlpacaREST(per_minute=150), AlpacaPaperBroker()
    acct = broker.account()
    if not acct.is_paper or acct.blocked:
        raise SystemExit("account not paper or blocked")
    oms, data = OMS(broker), LiveData(a)
    day = day or dt.datetime.now(ET).date()
    cal = a.calendar((day - dt.timedelta(days=40)).isoformat(), (day + dt.timedelta(days=10)).isoformat())
    if day not in set(cal.date):
        log("no_session", day=day)
        return
    sessions = sorted(cal.date)
    nxt = next(d for d in sessions if d > day)
    close = cal[cal.date == day].close.iloc[0]
    close_dt = et(day, close)
    flatten_dt, market_dt = close_dt - dt.timedelta(minutes=10), close_dt - dt.timedelta(minutes=5)
    va_path = LIVE / "virtual_account.json"
    LIVE.mkdir(parents=True, exist_ok=True)
    va = VirtualAccount.load(va_path)
    va.roll(day)
    if not events.coverage_ok(day):
        log("refuse_to_arm", reason="macro calendar < 30 days ahead")
        return
    sigma, prev_close = data.sigma_and_prev_close(day, sessions)
    log("armed", day=day, sigma=sigma, prev_close=prev_close, flatten=flatten_dt, virtual=asdict(va))
    plan: TradePlan | None = None
    acts = reconcile(broker, {TRADE}, {}, managed={TRADE})
    if acts:
        log("reconcile_startup", actions=acts)
    while True:
        now = dt.datetime.now(ET)
        if now < et(day, "09:30"):
            time.sleep(min(60, (et(day, "09:30") - now).total_seconds()))
            continue
        if now >= close_dt:
            break
        try:
            if plan:
                oms.sync(plan)
            stop_for = {TRADE: plan.stop} if plan and plan.state in ("in_position", "exiting") else {}
            acts = reconcile(broker, {TRADE}, stop_for, managed={TRADE})
            if acts:
                log("reconcile", actions=acts)
            q = data.quote(TRADE)
            last_mid = (q[0] + q[1]) / 2 if q else None
            # ---- exits ----
            if plan and plan.state in ("in_position", "exiting"):
                if now >= market_dt:
                    oms.exit_now(plan, limit_price=round(q[0] - 0.05, 2) if q else plan.stop, reason="eod_market")
                elif now >= flatten_dt:
                    oms.exit_now(plan, limit_price=round(q[0] - 0.02, 2) if q else plan.stop, reason="eod_flatten")
                elif last_mid and last_mid >= plan.target:
                    oms.exit_now(plan, limit_price=round(q[0] - 0.01, 2), reason="target")
                if plan.state == "closed":
                    fills = [x for x in plan.log if x[0] == "exited"]
                    px = fills[-1][2] if fills else plan.stop
                    va.record_round_trip(day, nxt, cost=plan.filled_qty * (plan.avg_entry or 0), proceeds=plan.filled_qty * px)
                    va.save(va_path)
                    r_mult = (px - (plan.avg_entry or 0)) / ((plan.avg_entry or 0) - plan.stop) if plan.avg_entry and plan.avg_entry > plan.stop else None
                    log("trade_closed", day=day, symbol=TRADE, entry=plan.avg_entry, exit=px, stop=plan.stop,
                        qty=plan.filled_qty, R=r_mult, plan=plan.log, virtual=asdict(va))
            if plan and plan.state == "entry_working" and now >= et(day, "15:30"):
                oms.cancel_entry_remainder(plan)
            # ---- entries (at most one per day) ----
            if plan is None and now < flatten_dt - dt.timedelta(minutes=20):
                blockers = []
                if KILL.exists():
                    blockers.append("kill_file")
                if va.latched:
                    blockers.append(f"latched:{va.latch_reason}")
                if va.trades_by_day.get(day.isoformat(), 0) >= 1:
                    blockers.append("max_1_trade_per_day")
                pol, ev = events.policy(now)
                if pol in ("skip", "blackout"):
                    blockers.append(f"event:{pol}:{ev}")
                bars = data.bars_today(SIG, day)
                closed = bars[bars.t <= pd.Timestamp(now) - pd.Timedelta(minutes=1)] if len(bars) else bars
                if not len(closed) or (pd.Timestamp(now) - closed.t.iloc[-1]).total_seconds() > STALE_S:
                    blockers.append("stale_signal_data")
                if not q or (q[1] - q[0]) / ((q[0] + q[1]) / 2) * 100 > MAX_SPREAD_PCT:
                    blockers.append("spread_or_no_quote")
                sig = None if blockers else setups.b_intraday_momentum(closed.reset_index(drop=True), sigma, prev_close)
                if sig and sig.bar_index == len(closed) - 1:          # only act on the bar that just closed
                    sq = data.quote(SIG)
                    ratio = last_mid / ((sq[0] + sq[1]) / 2)
                    trig = math.ceil(sig.trigger * ratio * 100) / 100
                    stop = math.floor(sig.stop * ratio * 100) / 100
                    R = trig - stop
                    risk = va.equity * RISK_PCT / 100 * (0.5 if pol == "reduce" else 1.0)
                    qty = size_position(trig, stop, risk, va.settled_cash, va.equity)
                    if qty >= 1 and R > 0:
                        plan = TradePlan(date=day.isoformat(), strategy="B", symbol=TRADE, qty=qty, trigger=trig,
                                         limit=round(trig + 0.1 * R, 2), stop=stop, target=round(trig + 2 * R, 2))
                        oms.place_entry(plan)
                        log("entry_placed", trigger=trig, stop=stop, target=plan.target, qty=qty, ratio=ratio, policy=pol)
                    else:
                        log("signal_skipped_size", qty=qty, R=R)
                elif blockers and now.minute in (0, 30) and now.second < poll_s:
                    log("blocked", blockers=blockers)
        except Exception as e:  # noqa: BLE001 — never crash with an open position; log and keep protecting
            log("loop_error", error=repr(e))
        time.sleep(poll_s)
    if plan and plan.state not in ("closed", "aborted"):
        log("END_OF_DAY_NOT_FLAT", plan=plan.log)
    log("session_end", virtual=asdict(va))


if __name__ == "__main__":
    run()
