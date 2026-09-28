"""Round-3 (SPEC-0001) trial runner for the Gap-and-Go sets F and P (DEC-0010).

  Set F = the spec funnel's Tier 2 (<= 4 names; primary funded first)
  Set P = the frozen baseline ranking.yaml Top-10 from the same causal pool, plus the chart musts (catalyst tagged)
Trials: GG-1 .. GG-4 per set, exits WT, day-level admission at US$600 / 1,000 / 2,000 (portfolio.py).

Per signal: the NBBO spread in the signal minute must be <= $0.05 (unknown fails, D28). Slippage =
max($0.01, half the spread) (D13), with a strict collar (D38).

  --counts-only   writes trade COUNTS per trial and never writes or prints R (count guard, D16)
  --relax a,b     drops chart musts from Set P (order fixed in DEC-0010: window, pm_consolidation, emas)
  --control       random entries through the same layers (not trials)

Usage:
  PYTHONPATH=src .venv/bin/python scripts/r3_run.py EXP-0015-r3-dev 2019-01-02 2025-09-25 --set F [--counts-only]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.engine import Costs, EntrySignal, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.portfolio import Candidate as PCand  # noqa: E402
from wt.backtest.portfolio import admit_day  # noqa: E402
from wt.backtest.runner import minute_bars  # noqa: E402
from wt.core.clock import et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR, ROOT, load_yaml  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.scanner.pool import PM_BARS_DIR, POOL_DIR  # noqa: E402
from wt.scanner.ranking import Candidate, SpecCandidate, funnel, rank  # noqa: E402
from wt.signals.musts import spread_ok  # noqa: E402
from wt.signals.patterns import Pattern  # noqa: E402
from wt.signals.spec_setups import ATTEMPTS, SETUPS  # noqa: E402
from wt.specs.loader import load_spec  # noqa: E402

GG = ["GG-1", "GG-2", "GG-3", "GG-4"]
EQUITIES = (600.0, 1000.0, 2000.0)
QUOTE_CACHE = DATA_DIR / "signal_spreads.json"


class SpreadAt:
    """NBBO spread in the signal minute (cached). None = unknown (fails the must)."""

    def __init__(self, a: AlpacaREST):
        self.a = a
        self.cache = json.loads(QUOTE_CACHE.read_text()) if QUOTE_CACHE.exists() else {}

    def __call__(self, symbol: str, t: pd.Timestamp) -> float | None:
        key = f"{symbol}|{t.isoformat()}"
        if key not in self.cache:
            j = self.a.get("https://data.alpaca.markets/v2/stocks/quotes",
                           {"symbols": symbol, "start": to_utc_iso(t.to_pydatetime()),
                            "end": to_utc_iso((t + pd.Timedelta(minutes=1)).to_pydatetime()), "feed": "sip", "limit": 1000}, tries=3)
            q = [x for x in ((j.get("quotes") or {}).get(symbol) or []) if x.get("bp", 0) > 0 and x.get("ap", 0) >= x.get("bp", 0)]
            self.cache[key] = (q[-1]["ap"] - q[-1]["bp"]) if q else None
        return self.cache[key]

    def save(self):
        QUOTE_CACHE.write_text(json.dumps(self.cache))


def set_names(pool: pd.DataFrame, which: str, spec: dict, relax: set[str]) -> list[tuple[str, int]]:
    """(symbol, priority) for the day's traded names."""
    if pool.empty:
        return []
    if which == "F":
        cands = [SpecCandidate(symbol=r.symbol, price=r.price_0925, gap_pct=r.gap_pct, pm_volume=r.pm_volume,
                               rvol_pm=r.rvol_pm, float_shares=None if pd.isna(r.float_shares) else r.float_shares,
                               catalyst_status=r.catalyst_status, catalyst_category=r.catalyst_category,
                               catalyst_score=r.catalyst_score, former_runner=bool(r.former_runner),
                               chart_ok=bool(r.chart_ok), pm_pattern=r.pm_pattern is not None and r.pm_pattern == r.pm_pattern)
                 for r in pool.itertuples()]
        out = funnel(cands, spec)
        return [(t["symbol"], 0 if t["primary"] else t["rank"]) for t in out["tier2"]]
    base = [Candidate(symbol=r.symbol, price=r.price_0925, gap_pct=r.gap_pct, rvol_tod=r.rvol_tod_base,
                      pm_dollar_vol=r.pm_dollar_vol, spread_pct=None if pd.isna(r.spread_pct) else r.spread_pct,
                      spread_abs=None if pd.isna(r.spread_abs) else r.spread_abs,
                      float_shares=None if pd.isna(r.float_shares) else r.float_shares, pm_volume=r.pm_volume,
                      catalyst_type=r.catalyst_type_v1, catalyst_score=r.catalyst_score_v1)
            for r in pool.itertuples()]
    top, _ = rank(base, load_yaml("ranking.yaml"))
    rows = pool.set_index("symbol")
    keep = []
    for t in top:
        r = rows.loc[t["symbol"]]
        ok = (("emas" in relax or r.trend_ok) and ("window" in relax or r.window_ok) and
              ("pm_consolidation" in relax or r.pm_consolidation) and not r.suspect_split)
        if ok:
            keep.append((t["symbol"], t["rank"]))
    return keep


def ctx_for(row, pm: pd.DataFrame) -> dict:
    pat = None
    if isinstance(row.pm_pattern, str):
        pat = Pattern(row.pm_pattern, float(row.pm_pattern_trigger), float(row.pm_pattern_stop), -1, float(row.pm_pattern_trigger))
    return {"pm_high": None if pd.isna(row.pm_high) else float(row.pm_high), "pm_pattern": pat,
            "pm_bars": pm.reset_index(drop=True), "overhead": list(row.overhead_levels) if row.overhead_levels is not None else []}


def run_day(d: dt.date, names: list[tuple[str, int]], pool: pd.DataFrame, pm_all: pd.DataFrame, bars_by: dict,
            spread_at: SpreadAt, trial: str, close_hhmm: str) -> tuple[list[PCand], list[dict]]:
    """Pass 1 for one GG trial: signal chains per name -> admission candidates (+ skip log)."""
    rows = pool.set_index("symbol")
    fn, max_att = SETUPS[trial], ATTEMPTS[trial]
    hh, mm = map(int, close_hhmm.split(":"))
    cands, skips = [], []
    for sym, prio in names:
        b = bars_by.get(sym)
        if b is None or len(b) < 30:
            skips.append({"symbol": sym, "reason": "no_rth_bars"})
            continue
        flatten = min(len(b) - 1, int(np.searchsorted(pd.to_datetime(b.t, utc=True), pd.Timestamp(et(d, close_hhmm)) - pd.Timedelta(minutes=10))))
        pm = pm_all[pm_all.symbol == sym].sort_values("t") if len(pm_all) else pd.DataFrame(columns=["t", "o", "h", "l", "c", "v"])
        ctx = ctx_for(rows.loc[sym], pm)
        start = 0
        for att in range(1, max_att + 1):
            sig = fn(b, ctx, start=start)
            if sig is None:
                break
            t_sig = pd.Timestamp(b.t.iloc[sig.bar_index])
            spr = spread_at(sym, t_sig)
            if not spread_ok(spr):
                skips.append({"symbol": sym, "reason": "spread", "spread": spr})
                break
            costs = Costs(slippage_per_share=max(0.01, (spr or 0) / 2))

            def resim(cash, risk, b=b, sig=sig, costs=costs, flatten=flatten, sym=sym):
                tr = simulate(b, sig, REGISTRY["WT"](), costs, sym, str(d), risk_dollars=risk, cash=cash,
                              max_notional=cash, flatten_idx=flatten)
                return (tr, tr.r_multiple(costs) if tr else None)

            probe = simulate(b, sig, REGISTRY["WT"](), costs, sym, str(d), risk_dollars=1e9, cash=1e9, max_notional=1e9,
                             flatten_idx=flatten)
            if probe is None:
                skips.append({"symbol": sym, "reason": "no_fill"})
                break
            cands.append(PCand(sym, att, prio, probe.entry_time, resim))
            exit_t = probe.exits[-1][0]
            nxt = np.nonzero(pd.to_datetime(b.t, utc=True) > exit_t)[0]
            if not len(nxt):
                break
            start = int(nxt[0])
    return cands, skips


def main(exp: str, start: str, end: str, which: str, counts_only: bool, relax: set[str]) -> None:
    spec = load_spec("SPEC-0001")
    a = AlpacaREST(per_minute=150, shared=True)
    spread_at = SpreadAt(a)
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    days = sorted(dt.date.fromisoformat(f.stem) for f in POOL_DIR.glob("*.parquet") if s <= dt.date.fromisoformat(f.stem) <= e)
    cal = a.calendar(start, end)
    closes = {r.date: r.close for r in cal.itertuples()}
    results = {f"{which}:{t}": {str(eq): [] for eq in EQUITIES} for t in GG}
    counts = {f"{which}:{t}": 0 for t in GG}
    skipped = {f"{which}:{t}": {} for t in GG}
    for n, d in enumerate(days, 1):
        pool = pd.read_parquet(POOL_DIR / f"{d}.parquet")
        pmf = PM_BARS_DIR / f"{d}.parquet"
        pm_all = pd.read_parquet(pmf) if pmf.exists() else pd.DataFrame()
        names = set_names(pool, which, spec, relax)
        if not names:
            continue
        close = closes.get(d, "16:00")
        bars_by = minute_bars(a, d, [x for x, _ in names], close_hhmm=close)
        for trial in GG:
            key = f"{which}:{trial}"
            cands, skips = run_day(d, names, pool, pm_all, bars_by, spread_at, trial, close)
            for sk in skips:
                skipped[key][sk["reason"]] = skipped[key].get(sk["reason"], 0) + 1
            for eq in EQUITIES:
                res = admit_day(cands, eq, spec["risk"]["max_consecutive_losers_per_day"], spec["risk"]["max_daily_loss_R"],
                                spec["risk"]["per_trade_risk_pct_of_equity"])
                for _, reason in res.skipped:
                    skipped[key][f"{reason}@{int(eq)}"] = skipped[key].get(f"{reason}@{int(eq)}", 0) + 1
                if eq == 600.0:
                    counts[key] += len(res.admitted)
                if not counts_only:
                    for c, tr, r in res.admitted:
                        results[key][str(eq)].append({"date": str(d), "symbol": tr.symbol, "setup": tr.setup, "attempt": c.attempt,
                                                      "priority": c.priority, "entry_time": str(tr.entry_time), "entry": tr.entry,
                                                      "stop0": tr.stop0, "qty": tr.qty, "R": r, "exit_reason": tr.exits[-1][3],
                                                      "exit_time": str(tr.exits[-1][0]), "tags": tr.tags})
        if n % 20 == 0:
            spread_at.save()
            print(f"{n}/{len(days)} {d} counts@600 {counts}", flush=True)
    spread_at.save()
    out = ROOT / "research" / "experiments" / exp
    out.mkdir(parents=True, exist_ok=True)
    meta = {"spec": "SPEC-0001", "spec_version": spec["version"], "set": which, "relax": sorted(relax), "days": len(days),
            "span": [start, end], "counts_at_600": counts, "skips": skipped}
    if counts_only:
        (out / f"counts_{which}.json").write_text(json.dumps(meta, indent=1, default=str))
        print(json.dumps({"counts_at_600": counts}, indent=1))
    else:
        (out / f"results_{which}.json").write_text(json.dumps({**meta, "trades": results}, default=str))
        print(json.dumps({"counts_at_600": counts}, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("exp")
    ap.add_argument("start")
    ap.add_argument("end")
    ap.add_argument("--set", dest="which", choices=["F", "P"], required=True)
    ap.add_argument("--counts-only", action="store_true")
    ap.add_argument("--relax", default="")
    args = ap.parse_args()
    main(args.exp, args.start, args.end, args.which, args.counts_only, {x for x in args.relax.split(",") if x})
