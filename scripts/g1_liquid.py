"""G1 liquid-universe track: S2 extreme reversal and S3 VWAP pullback on each day's top-30 most liquid
stocks (price $15-250, prior-20-session average dollar volume; point-in-time). Dev span only.
Usage: python scripts/g1_liquid.py EXP-0007-g1-liquid-dev"""
from __future__ import annotations

import datetime as dt
import itertools
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.runner import StratConfig, save_experiment  # noqa: E402
from wt.core.clock import et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402
from wt.data.universe import load_daily  # noqa: E402
from wt.signals import setups  # noqa: E402

DEV_START, DEV_END = dt.date(2019, 2, 1), dt.date(2025, 9, 25)
MIN = DATA_DIR / "minute_liquid"


def universe(daily: pd.DataFrame) -> dict[dt.date, list[str]]:
    d = daily[["symbol", "date", "c", "v"]].copy()
    d["dv"] = d.c * d.v
    d = d.sort_values(["symbol", "date"])
    d["adv20"] = d.groupby("symbol").dv.transform(lambda s: s.rolling(20).mean().shift(1))
    d["pc"] = d.groupby("symbol").c.shift(1)
    assets = pd.read_parquet(DATA_DIR / "daily" / "assets.parquet").set_index("symbol")
    lev = set(assets[assets.name.str.contains(r"ProShares|Direxion|UltraPro|Ultra |Leveraged|2X|3X|Bull |Bear |iShares|SPDR|Invesco|Vanguard|ETF|Fund", case=False, na=False)].index)
    d = d[(d.pc.between(15, 250)) & d.adv20.notna() & ~d.symbol.isin(lev | {"SPY", "QQQ", "SPYM", "QQQM", "IWM"})]
    out = {}
    for day, g in d[(d.date >= DEV_START) & (d.date <= DEV_END)].groupby("date"):
        out[day] = list(g.nlargest(30, "adv20").symbol)
    return out


def bars_for(a: AlpacaREST, day: dt.date, syms: list[str]) -> dict[str, pd.DataFrame]:
    MIN.mkdir(parents=True, exist_ok=True)
    f = MIN / f"{day}.parquet"
    if not f.exists():
        df = a.bars(syms, "1Min", to_utc_iso(et(day, "09:30")), to_utc_iso(et(day, "16:00")), feed="sip")
        df.to_parquet(f)
    df = pd.read_parquet(f)
    return {s: g.sort_values("t").reset_index(drop=True) for s, g in df.groupby("symbol")}


def main(exp_id: str) -> None:
    a, daily = AlpacaREST(), load_daily()
    uni = universe(daily)
    cal = a.calendar(DEV_START.isoformat(), DEV_END.isoformat())
    early = {r.date: r.close for r in cal.itertuples() if r.close != "16:00"}
    # S2 removed from the liquid universe after 0 signals in 150 sessions x 30 large caps (DEC-0006);
    # its 12 partially-evaluated configs remain counted as trials (n_trials_extra below).
    variants = [("S3", {"touch_tol": t}, mg) for t, mg in itertools.product((0.001, 0.002), ("M1", "M3", "M4"))]
    cfgs = [StratConfig(name=f"{s}|{'_'.join(f'{k}{v}' for k, v in p.items())}|{mg}", setup=s, management=mg, params=p)
            for s, p, mg in variants]
    trades = {c.name: [] for c in cfgs}
    for n, (day, syms) in enumerate(sorted(uni.items()), 1):
        bars = bars_for(a, day, syms)
        close = early.get(day, "16:00")
        hh, mm = map(int, close.split(":"))
        flat = (hh * 60 + mm) - 570 - 10
        for c, (s, p, mg) in zip(cfgs, variants, strict=False):
            for sym, b in bars.items():
                if len(b) < flat:
                    continue
                start, attempts = 0, 0
                while attempts < 2:
                    fn = setups.s2_extreme_reversal if s == "S2" else setups.s3_vwap_pullback
                    sig = fn(b, window=(15, flat - 30), start=start, **p)
                    if sig is None:
                        break
                    tr = simulate(b, sig, REGISTRY[mg](), Costs(), sym, str(day), 6, 1e9, 1e9, flatten_idx=flat)
                    attempts += 1
                    if tr is None:
                        start = sig.bar_index + 1
                        continue
                    trades[c.name].append({"date": str(day), "symbol": sym, "R": tr.r_multiple(Costs()),
                                           "exit_reason": tr.exits[-1][3], "mfe_R": tr.mfe, "entry_time": str(tr.entry_time)})
                    ex = tr.exits[-1][0]
                    start = int(b.index[b.t == ex][0]) + 1 if (b.t == ex).any() else len(b)
        if n % 50 == 0:
            print(f"{n}/{len(uni)} {day}", {k: len(v) for k, v in list(trades.items())[:2]}, flush=True)
    res = {}
    for name, tl in trades.items():
        r = np.array([t["R"] for t in tl])
        res[name] = {"trades": tl, "summary": {"n": len(r), "expectancy_R": float(r.mean()) if len(r) else 0.0}}
        print(f"{name:<40} n={len(r):<6} E={res[name]['summary']['expectancy_R']:+.3f}R", flush=True)
    save_experiment(exp_id, cfgs, {"n_trials": len(cfgs) + 12, "n_trials_note": "+12 S2 configs dropped (DEC-0006)",
                                   "results": res})


if __name__ == "__main__":
    main(sys.argv[1])
