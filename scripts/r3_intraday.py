"""Round-3 (SPEC-0001) intraday trial runner: MP-1 (micro pullback) and REV-1 (reversal hybrid, long). Streamed per
day: bars are kept only for symbols that signal (disk, D30).

MP-1 universe = Set F Tier-2 names (09:31-10:00) plus SCN-HOD names (09:35-11:30).
  HOD fetch superset (exact, D9): the day's volume >= 1M, a traded range touching $1-10, and a known float <= 20M.
REV-1 universe = SCN-REV. Fetch superset: $15-250, day volume >= 500k, open-to-low drop >= 3%.
  `--recall-days N` measures what that superset misses on N random days fetched in full.
Both: NBBO spread must at the signal, spread-based slippage, strict collar, 2 attempts per stock, admission at
US$600/1,000/2,000; --counts-only never writes R.

Usage: PYTHONPATH=src .venv/bin/python scripts/r3_intraday.py EXP-0015-r3-dev 2019-01-02 2025-09-25 --trial MP-1
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_pool import SplitStore, market_guard  # noqa: E402
from r3_run import EQUITIES, SpreadAt, set_names  # noqa: E402

from wt.backtest.controls import control_signal  # noqa: E402
from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.portfolio import Candidate as PCand  # noqa: E402
from wt.backtest.portfolio import admit_day  # noqa: E402
from wt.core.clock import et, to_utc_iso  # noqa: E402
from wt.core.config import ROOT  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.tape import trade_tags  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import load_daily  # noqa: E402
from wt.scanner.catalyst import best_catalyst_spec  # noqa: E402
from wt.scanner.intraday import hod_mask, volume_curve  # noqa: E402
from wt.scanner.pool import PM_BARS_DIR, POOL_DIR, DailyIndex  # noqa: E402
from wt.signals.bars import et_minutes  # noqa: E402
from wt.signals.musts import spread_ok  # noqa: E402
from wt.signals.spec_setups import micro_pullback_1m, reversal_long  # noqa: E402
from wt.specs.loader import load_spec  # noqa: E402


def rth_bars(a: AlpacaREST, d: dt.date, symbols: list[str], close: str = "16:00") -> dict[str, pd.DataFrame]:
    if not symbols:
        return {}
    b = a.bars(symbols, "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, close)))
    return {s: g.sort_values("t").reset_index(drop=True) for s, g in b.groupby("symbol")} if len(b) else {}


def adv(daily: DailyIndex, splits, sym: str, d: dt.date, n: int) -> float:
    h = splits.adjust_asof(daily.before(sym, d, n), d)
    return float(h.v.mean()) if len(h) else 0.0


CTL: list = []           # control inputs of the current day: (sym, prio, bars, signal, costs, flatten, exit_style)


def chains(fn, b: pd.DataFrame, ctx: dict, sym: str, prio: int, d: dt.date, spread_at: SpreadAt, exit_style: str,
           flatten: int, skips: dict) -> list[PCand]:
    out, start = [], 0
    for att in (1, 2):
        sig = fn(b, ctx, start=start)
        if sig is None:
            break
        spr = spread_at(sym, pd.Timestamp(b.t.iloc[sig.bar_index]))
        if not spread_ok(spr):
            skips["spread"] = skips.get("spread", 0) + 1
            break
        costs = Costs(slippage_per_share=max(0.01, spr / 2))
        if att == 1:
            CTL.append((sym, prio, b, sig, costs, flatten, exit_style))
        probe = simulate(b, sig, REGISTRY[exit_style](), costs, sym, str(d), 1e9, 1e9, 1e9, flatten_idx=flatten)
        if probe is None:
            skips["no_fill"] = skips.get("no_fill", 0) + 1
            break

        def resim(cash, risk, sig=sig, costs=costs):
            tr = simulate(b, sig, REGISTRY[exit_style](), costs, sym, str(d), risk, cash, cash, flatten_idx=flatten)
            if tr is not None:
                tr.tags.update(trigger=sig.trigger, slip=costs.slippage_per_share)
            return tr, (tr.r_multiple(costs) if tr else None)

        out.append(PCand(sym, att, prio, probe.entry_time, resim))
        nxt = np.nonzero(pd.to_datetime(b.t, utc=True) > probe.exits[-1][0])[0]
        if not len(nxt):
            break
        start = int(nxt[0])
    return out


def flatten_idx(b: pd.DataFrame, d: dt.date, close: str) -> int:
    return min(len(b) - 1, int(np.searchsorted(pd.to_datetime(b.t, utc=True), pd.Timestamp(et(d, close)) - pd.Timedelta(minutes=10))))


def mp_day(a, d, p, daily, splits, shares, spec, spread_at, close, skips) -> list[PCand]:
    today = daily.on(d)
    sup = today[(today.v >= 1_000_000) & (today.l <= 10.0) & (today.h >= 1.0)]
    sup = [s for s in sup.index if (fl := shares.asof(s, d)) is not None and fl <= 20_000_000]
    pool_f = POOL_DIR / f"{d}.parquet"
    tier2 = []
    if pool_f.exists():
        pool = pd.read_parquet(pool_f)
        tier2 = set_names(pool, "F", spec, set())
    t2syms = [s for s, _ in tier2]
    syms = sorted(set(sup) | set(t2syms))
    if not syms:
        return []
    bars = rth_bars(a, d, syms, close)
    news = a.news(syms, to_utc_iso(et(p, "16:00")), to_utc_iso(et(d, "11:30")))
    cat_times: dict[str, list] = {}
    for n in news:
        if n.get("headline") and best_catalyst_spec([n["headline"]])[0] == "qualifying":
            for s in n.get("symbols", []):
                cat_times.setdefault(s, []).append(pd.Timestamp(n["created_at"]))
    pm_all = pd.read_parquet(PM_BARS_DIR / f"{d}.parquet") if (PM_BARS_DIR / f"{d}.parquet").exists() else pd.DataFrame()
    prio = {s: r for s, r in tier2}
    out = []
    curve = volume_curve()
    for s in syms:
        b = bars.get(s)
        if b is None or len(b) < 30:
            continue
        m = et_minutes(b)
        mask = np.zeros(len(b), bool)
        if s in sup:
            mask |= hod_mask(b, adv(daily, splits, s, d, 20), shares.asof(s, d), cat_times.get(s, []), curve=curve)
        if s in prio:
            mask |= (m >= 571) & (m < 600)
        if not mask.any():
            continue
        pm = pm_all[pm_all.symbol == s].sort_values("t") if len(pm_all) else None
        ctx = {"mp_mask": mask, "pm_bars": pm}
        out += chains(micro_pullback_1m, b, ctx, s, prio.get(s, 9), d, spread_at, "WT", flatten_idx(b, d, close), skips)
    return out


def rev_superset(daily: DailyIndex, d: dt.date, sessions: list[dt.date], drop_min: float | None = 0.03) -> list[str]:
    today = daily.on(d)
    sup = today[(today.l <= 250.0) & (today.h >= 15.0) & (today.v >= 500_000)]
    if drop_min is not None:
        sup = sup[(sup.o - sup.l) / sup.o >= drop_min]
    return sorted(sup.index)


def rev_day(a, d, p, daily, splits, spread_at, close, skips, syms) -> tuple[list[PCand], set[str]]:
    if not syms:
        return [], set()
    bars, prev = rth_bars(a, d, syms, close), rth_bars(a, p, syms, "16:00")
    curve = volume_curve()
    out, signalled = [], set()
    for s in syms:
        b, pb = bars.get(s), prev.get(s)
        if b is None or pb is None or len(b) < 30 or len(pb) < 60:
            continue
        ctx = {"prev_rth": pb, "adv5": adv(daily, splits, s, d, 5), "adv20": adv(daily, splits, s, d, 20), "curve": curve}
        c = chains(reversal_long, b, ctx, s, 5, d, spread_at, "REV5", flatten_idx(b, d, close), skips)
        if c:
            signalled.add(s)
        out += c
    return out, signalled


def intraday_day(a, d: dt.date, trial: str, sessions: list[dt.date], closes: dict, daily: DailyIndex, splits: SplitStore,
                 shares, spec: dict, spread_at: SpreadAt, skips: dict) -> list[PCand]:
    """One session of MP-1 or REV-1: admission candidates. Fills CTL with the day's control inputs.

    Shared by the batch runner and the nightly forward test, so both follow exactly the pre-registered path. MP-1
    reads Set F's Tier 2 from the day's causal pool, so that pool must exist first."""
    p, close = sessions[sessions.index(d) - 1], closes.get(d, "16:00")
    CTL.clear()
    if trial == "MP-1":
        today = daily.on(d)
        splits.refresh(sorted(today[(today.v >= 1_000_000) & (today.l <= 10.0)].index), d)
        return mp_day(a, d, p, daily, splits.sf, shares, spec, spread_at, close, skips)
    syms = rev_superset(daily, d, sessions)
    splits.refresh(syms, d)
    cands, _ = rev_day(a, d, p, daily, splits.sf, spread_at, close, skips, syms)
    return cands


def control_cands(trial: str, seed: int, d: dt.date) -> list[PCand]:
    out = []
    for sym, prio, b, sig, costs, flatten, style in CTL:
        cs = control_signal(b, sig, trial, seed)
        if cs is None:
            continue
        probe = simulate(b, cs, REGISTRY[style](), costs, sym, str(d), 1e9, 1e9, 1e9, flatten_idx=flatten)
        if probe is None:
            continue

        def resim(cash, risk, b=b, cs=cs, costs=costs, flatten=flatten, sym=sym, style=style):
            tr = simulate(b, cs, REGISTRY[style](), costs, sym, str(d), risk, cash, cash, flatten_idx=flatten)
            return tr, (tr.r_multiple(costs) if tr else None)

        out.append(PCand(sym, 1, prio, probe.entry_time, resim))
    return out


def main(exp: str, start: str, end: str, trial: str, counts_only: bool, recall_days: int, n_control: int = 0,
         tape: bool = False) -> None:
    spec = load_spec("SPEC-0001")
    a = AlpacaREST(per_minute=150, shared=True)
    spread_at = SpreadAt(a)
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    cal = a.calendar((s - dt.timedelta(days=60)).isoformat(), e.isoformat())
    sessions, closes = sorted(cal.date), {r.date: r.close for r in cal.itertuples()}
    raw = load_daily()
    daily, splits, shares = DailyIndex(raw), SplitStore(a, raw), SharesOutstanding()
    days = [d for d in sessions if s <= d <= e]
    out = ROOT / "research" / "experiments" / exp
    out.mkdir(parents=True, exist_ok=True)
    if trial == "REV-1" and recall_days:
        rng = random.Random(1515)
        sample = sorted(rng.sample(days, min(recall_days, len(days))))
        missed = found = 0
        for d in sample:
            market_guard(set(sessions))
            p = sessions[sessions.index(d) - 1]
            full = rev_superset(daily, d, sessions, drop_min=None)
            narrow = set(rev_superset(daily, d, sessions))
            splits.refresh(full)
            _, sig_full = rev_day(a, d, p, daily, splits.sf, spread_at, closes.get(d, "16:00"), {}, full)
            found += len(sig_full)
            missed += len(sig_full - narrow)
        rec = {"days": [str(x) for x in sample], "signalled_symbols_full": found, "missed_by_superset": missed,
               "recall": (1 - missed / found) if found else None}
        (out / "rev_recall.json").write_text(json.dumps(rec, indent=1))
        print(json.dumps(rec))
        return
    trades = {str(eq): [] for eq in EQUITIES}
    count, skips = 0, {}
    csum, cn = np.zeros(n_control), np.zeros(n_control)
    oos0 = dt.date.fromisoformat(spec["evaluation"]["oos_span"][0])
    for n, d in enumerate(days, 1):
        market_guard(set(sessions))
        cands = intraday_day(a, d, trial, sessions, closes, daily, splits, shares, spec, spread_at, skips)
        for seed in range(n_control if (d >= oos0 and not counts_only) else 0):
            cres = admit_day(control_cands(trial, seed, d), 600.0, spec["risk"]["max_consecutive_losers_per_day"],
                             spec["risk"]["max_daily_loss_R"], spec["risk"]["per_trade_risk_pct_of_equity"])
            rs = [r for _, _, r in cres.admitted if r is not None]
            csum[seed] += sum(rs)
            cn[seed] += len(rs)
        for eq in EQUITIES:
            res = admit_day(cands, eq, spec["risk"]["max_consecutive_losers_per_day"], spec["risk"]["max_daily_loss_R"],
                            spec["risk"]["per_trade_risk_pct_of_equity"])
            if eq == 600.0:
                count += len(res.admitted)
            for _, reason in res.skipped:
                skips[f"{reason}@{int(eq)}"] = skips.get(f"{reason}@{int(eq)}", 0) + 1
            if not counts_only and tape and eq == 600.0:
                for _, tr, _ in res.admitted:
                    tr.tags.update(trade_tags(a, tr.symbol, tr.entry_time, tr.tags["trigger"], tr.stop0, ten_second=(trial == "MP-1")))
            if not counts_only:
                trades[str(eq)] += [{"date": str(d), "symbol": tr.symbol, "setup": tr.setup, "attempt": c.attempt,
                                     "entry_time": str(tr.entry_time), "entry": tr.entry, "stop0": tr.stop0, "qty": tr.qty,
                                     "R": r, "exit_reason": tr.exits[-1][3], "exit_time": str(tr.exits[-1][0]), "tags": tr.tags}
                                    for c, tr, r in res.admitted]
        if n % 20 == 0:
            spread_at.save()
            print(f"{n}/{len(days)} {d} count@600 {count}", flush=True)
    spread_at.save()
    meta = {"spec": "SPEC-0001", "trial": trial, "span": [start, end], "days": len(days), "count_at_600": count, "skips": skips}
    name = f"{'counts' if counts_only else 'results'}_{trial}.json"
    body = meta if counts_only else {**meta, "trades": trades,
                                     "control_means": {trial: [float(s / n) for s, n in zip(csum, cn, strict=False) if n > 0]}}
    (out / name).write_text(json.dumps(body, default=str, indent=None if not counts_only else 1))
    print(json.dumps({"count_at_600": count}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("exp")
    ap.add_argument("start")
    ap.add_argument("end")
    ap.add_argument("--trial", choices=["MP-1", "REV-1"], required=True)
    ap.add_argument("--counts-only", action="store_true")
    ap.add_argument("--recall-days", type=int, default=0)
    ap.add_argument("--control", type=int, default=0, help="random-entry control seeds (not trials)")
    ap.add_argument("--tape", action="store_true", help="fetch descriptive tape tags (and MP-1 10-second view) per trade")
    args = ap.parse_args()
    main(args.exp, args.start, args.end, args.trial, args.counts_only, args.recall_days, args.control, args.tape)
