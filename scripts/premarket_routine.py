"""SPEC-0001 pre-market routine: a FORWARD DRY RUN (RTN-01..07). No broker calls; only market data is read.

For each session:
  08:00 ET  tier1        gap scanner on live data up to 08:00 (Tier-1 pool)
  08:30 ET  charts       chart musts at 08:30: EMAs, window vs ATR, triggers, former runner, splits
  09:00 ET  tier2        funnel -> Tier 2 (<= 4) and pre-market structure (flag / flat top / consolidation)
  09:15 ET  tickets      primary stock + staged GG-1 tickets (trigger, stop, 2R target, size from a read-only
                         US$600 virtual account, D31)
  11:31 ET  signals      which setups fired on today's bars 09:30-11:30 (ORB 09:30-09:50, Gap-and-Go 09:30-10:00,
                         patterns 09:50-11:00, micro pullback 09:31-11:30); same causal code as the backtest
Stage files go to var/routine/<date>/ (runtime state, ADR 0002).

Live data is "hybrid" (SPEC-0001 routine.data_live, K-31): the SIP tape up to the free plan's 15-minute delay plus IEX for
the latest minutes. IEX alone has no bars before 08:00 ET and few for small caps. The nightly forward test re-evaluates
the day on full SIP, and the scorecard reports the agreement (D23). Each stage logs `sip_through_et`.
Exits quietly on non-sessions (RTN-07). --replay YYYY-MM-DD runs every stage at once on historical data.

Usage: PYTHONPATH=src .venv/bin/python scripts/premarket_routine.py [--replay 2018-12-20] [--feed hybrid|sip|iex]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from wt.core.clock import ET, et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR, ROUTINE_DIR  # noqa: E402
from wt.data.alpaca import AlpacaREST, HybridFeed  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import ASSETS, load_daily_tail, tail_rows_for  # noqa: E402
from wt.risk.virtual_account import VirtualAccount  # noqa: E402
from wt.scanner.features import PMCache  # noqa: E402
from wt.scanner.pool import DailyIndex, PoolConfig, build_day  # noqa: E402
from wt.scanner.ranking import SpecCandidate, funnel  # noqa: E402
from wt.signals.musts import next_half_dollar_above  # noqa: E402
from wt.signals.spec_setups import SETUPS  # noqa: E402
from wt.specs.loader import load_spec  # noqa: E402

OUT = ROUTINE_DIR
VA_PATH = DATA_DIR / "live" / "virtual_account_gg.json"      # read-only here (D31); never B's account
STAGES = [("08:00", "tier1"), ("08:30", "charts"), ("09:00", "tier2"), ("09:15", "tickets")]


def minus(hhmm: str, minutes: int) -> str:
    t = dt.datetime(2000, 1, 1, *map(int, hhmm.split(":"))) - dt.timedelta(minutes=minutes)
    return t.strftime("%H:%M")


def wait_until(d: dt.date, hhmm: str, replay: bool) -> None:
    if replay:
        return
    while (now := dt.datetime.now(ET)) < et(d, hhmm):
        time.sleep(min(60, (et(d, hhmm) - now).total_seconds()))


def spec_cands(pool: pd.DataFrame) -> list[SpecCandidate]:
    return [SpecCandidate(symbol=r.symbol, price=r.price_0925, gap_pct=r.gap_pct, pm_volume=r.pm_volume, rvol_pm=r.rvol_pm,
                          float_shares=None if pd.isna(r.float_shares) else r.float_shares, catalyst_status=r.catalyst_status,
                          catalyst_category=r.catalyst_category, catalyst_score=r.catalyst_score,
                          former_runner=bool(r.former_runner), chart_ok=bool(r.chart_ok),
                          pm_pattern=isinstance(r.pm_pattern, str)) for r in pool.itertuples()]


def sip_through(a) -> str | None:
    t = getattr(a, "sip_through", None)
    return None if t is None else t.tz_convert(ET).strftime("%H:%M")


def write(folder: Path, name: str, body) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps(body, indent=1, default=str))


def run(d: dt.date, feed: str, replay: bool) -> Path | None:
    spec = load_spec("SPEC-0001")
    a = HybridFeed(AlpacaREST(per_minute=30, shared=True))         # small budget next to the paper runner (D6)
    cal = a.calendar((d - dt.timedelta(days=60)).isoformat(), d.isoformat())
    sessions = sorted(cal.date)
    if d not in sessions:
        print(f"{d}: not a session; nothing to do")
        return None
    i = sessions.index(d)
    p, prev_sessions = sessions[i - 1], sessions[max(0, i - 25): i]
    assets = pd.read_parquet(ASSETS)
    universe = set(assets[~assets.is_fund_like & ~assets.has_dot].symbol)
    # Only each symbol's last rows: the whole store peaks near 3 GB. The tail grows with the age of a replayed day,
    # and any lookup it could not answer exactly raises TailWindowExceeded instead of using a shortened history.
    raw, tail = load_daily_tail(tail_rows_for(d, PoolConfig.daily_lookback))
    daily = DailyIndex(raw, tail)
    from build_pool import SplitStore
    splits = SplitStore(a, raw, persist=False, tail=tail)         # read shared caches, never write them
    cache, shares = PMCache(since=prev_sessions[0]), SharesOutstanding()     # the RVOL baselines' sessions only
    folder = OUT / str(d)
    pool, pmb = pd.DataFrame(), pd.DataFrame()
    for hhmm, name in STAGES:
        wait_until(d, hhmm, replay)
        cfg = PoolConfig(snapshot=(minus(hhmm, 25), hhmm), feed=feed)
        pool, pmb, stats = build_day(d, p, a, daily, universe, splits.sf, cache, shares, prev_sessions, cfg,
                                     split_refresh=splits.refresh)
        f = funnel(spec_cands(pool), spec) if len(pool) else {"tier1": [], "tier2": [], "primary": None, "dropped": []}
        body = {"stage": name, "as_of_et": hhmm, "feed": feed, "sip_through_et": sip_through(a), "stats": vars(stats),
                "tier1": f["tier1"]}
        if name in ("charts", "tier2", "tickets") and len(pool):
            cols = ["symbol", "price_0925", "gap_pct", "trend_ok", "window_ok", "window_room", "atr14", "pm_consolidation",
                    "pm_pattern", "former_runner", "suspect_split", "chart_ok", "catalyst_category"]
            body["charts"] = pool[pool.symbol.isin([x["symbol"] for x in f["tier1"]])][cols].to_dict(orient="records")
        if name in ("tier2", "tickets"):
            body["tier2"], body["primary"] = f["tier2"], f["primary"]
        if name == "tickets":
            body["tickets"] = tickets(pool, f, spec)
        write(folder, f"{hhmm.replace(':', '')}_{name}", body)
    wait_until(d, "11:31", replay)
    write(folder, "1131_signals", {**signals(a, d, pool, pmb, f, feed), "sip_through_et": sip_through(a)})
    return folder


def tickets(pool: pd.DataFrame, f: dict, spec: dict) -> list[dict]:
    """Staged GG-1 tickets for Tier-2 names. The 09:30 bar isn't known yet, so the stop is the pattern low, or
    PMH - $0.20 (the GG-1 cap). No Tier-2 names (or an empty pool, which has no columns at all): no tickets."""
    if not len(pool) or not f["tier2"]:
        return []
    try:
        va = VirtualAccount.load(VA_PATH) if VA_PATH.exists() else VirtualAccount()
    except Exception:  # noqa: BLE001 — a missing or corrupt file means the default US$600 account; never written here
        va = VirtualAccount()
    risk = va.equity * spec["risk"]["per_trade_risk_pct_of_equity"] / 100
    rows, out = pool.set_index("symbol"), []
    for t in f["tier2"]:
        r = rows.loc[t["symbol"]]
        levels = [x for x in (r.pm_pattern_trigger, r.pm_high) if isinstance(x, float) and not math.isnan(x)]
        if not levels:
            continue
        lvl = min(levels)
        trig = round(lvl + 0.01, 2)
        stop = round(r.pm_pattern_stop - 0.01, 2) if lvl == r.pm_pattern_trigger else round(trig - 0.20, 2)
        stop = max(stop, round(trig - 0.20, 2))
        R = round(trig - stop, 4)                                   # price precision; avoids 0.0999999 -> one share short
        qty = int(min(risk / R + 1e-9, va.settled_cash / trig + 1e-9)) if R > 0 else 0
        out.append({"symbol": t["symbol"], "primary": t["primary"], "trigger": trig, "stop": stop, "target_2R": round(trig + 2 * R, 2),
                    "next_half_dollar": next_half_dollar_above(trig), "qty": qty, "risk_usd": round(qty * R, 2),
                    "note": "dry run; valid 09:31-10:00 only if the 09:30 bar trades >= 100k shares and doesn't break the level first"})
    return out


def signals(a: AlpacaREST, d: dt.date, pool: pd.DataFrame, pm_all: pd.DataFrame, f: dict, feed: str) -> dict:
    names = [t["symbol"] for t in f["tier2"]]
    if not names:
        return {"tier2": [], "signals": []}
    b = a.bars(names, "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, "11:31")), feed=feed)
    rows = pool.set_index("symbol")
    out = []
    from r3_run import ctx_for

    from wt.signals.bars import et_minutes
    for s in names:
        g = b[b.symbol == s].sort_values("t").reset_index(drop=True) if len(b) else pd.DataFrame()
        if len(g) < 5:
            continue
        pm = pm_all[pm_all.symbol == s].sort_values("t") if len(pm_all) else pd.DataFrame(columns=["t", "o", "h", "l", "c", "v"])
        ctx = ctx_for(rows.loc[s], pm)
        m = et_minutes(g)
        ctx["mp_mask"] = (m >= 571) & (m < 600)                    # Tier-2 names: micro pullbacks 09:31-10:00
        for trial, fn in SETUPS.items():
            if trial in ("REV-1",):
                continue
            try:
                sig = fn(g, ctx)
            except Exception as ex:  # noqa: BLE001 — log and keep going; this is a dry run
                out.append({"symbol": s, "trial": trial, "error": repr(ex)})
                continue
            if sig is not None:
                out.append({"symbol": s, "trial": trial, "signal_time": str(g.t.iloc[sig.bar_index]), "trigger": sig.trigger,
                            "stop": sig.stop, "target": sig.target, "setup": sig.setup})
    return {"tier2": names, "feed": feed, "signals": out}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--replay")
    ap.add_argument("--feed", default=None)
    args = ap.parse_args()
    if args.replay:
        day, feed, replay = dt.date.fromisoformat(args.replay), args.feed or "sip", True
    else:
        day, feed, replay = dt.datetime.now(ET).date(), args.feed or "hybrid", False
        wait_until(day, "07:55", False)
    folder = run(day, feed, replay)
    print("wrote", folder)
