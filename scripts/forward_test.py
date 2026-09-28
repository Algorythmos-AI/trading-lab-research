"""Nightly FORWARD test (DEC-0009): after each session closes, re-run the frozen candidate rules on that
day's data (delayed SIP, >15 min old) and append hypothetical trades to research/forward/forward_trades.jsonl.
Frozen rules: B (QQQ signals, QQQM-equivalent costs, M3); watchlist bull flag (ATR stop, M1, W3);
intraday-runner bull flag (HYP-0007, M1). No parameters may change without a new decision record.
Usage: python scripts/forward_test.py [YYYY-MM-DD]   (default: last completed session)"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.runner import minute_bars  # noqa: E402
from wt.core.clock import ET, et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR, ROOT, load_yaml  # noqa: E402
from wt.data.alpaca import SIP_DELAY_MIN, AlpacaREST  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import DAILY, load_daily  # noqa: E402
from wt.scanner.features import PMCache, build_candidates  # noqa: E402
from wt.scanner.ranking import rank  # noqa: E402
from wt.signals import setups  # noqa: E402

FWD = ROOT / "research" / "forward"
LOG = FWD / "forward_trades.jsonl"


def done_days() -> set[str]:
    if not LOG.exists():
        return set()
    return {json.loads(x)["session"] for x in LOG.read_text().splitlines() if '"session_marker"' in x}


def append(rec: dict) -> None:
    FWD.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps(rec, default=str) + "\n")


def daily_end(d: dt.date, now: dt.datetime) -> str:
    """End of the daily-bar request for session d: the next midnight ET, capped at now - SIP_DELAY_MIN.

    The free plan refuses any SIP request that reaches into the last 15 minutes (HTTP 403, DEC-0003), and an
    end of tomorrow's date does, so the nightly run ~20 minutes after the close failed on 2026-09-28.
    """
    return to_utc_iso(min(et(d + dt.timedelta(days=1), "00:00"), now - dt.timedelta(minutes=SIP_DELAY_MIN)))


def update_daily(a: AlpacaREST, d: dt.date, now: dt.datetime | None = None) -> None:
    f = DAILY.parent / "chunks" / f"chunk_zupd_{d}.parquet"
    if f.exists():
        return
    end = daily_end(d, now or dt.datetime.now(ET))
    syms = sorted(set(pd.concat([pd.read_parquet(x, columns=["symbol"]) for x in (DAILY.parent / "chunks").glob("chunk_0*.parquet")]).symbol))
    parts = [a.bars(syms[i:i + 200], "1Day", d.isoformat(), end) for i in range(0, len(syms), 200)]
    pd.concat(parts, ignore_index=True).to_parquet(f)


def run_B(a: AlpacaREST, d: dt.date, sessions: list[dt.date]) -> list[dict]:
    prior = [x for x in sessions if x < d][-14:]
    vals = []
    for x in prior:
        b = a.bars(["QQQ"], "1Min", to_utc_iso(et(x, "09:30")), to_utc_iso(et(x, "15:59")))
        if len(b) > 60:
            vals.append(float(np.mean(np.abs(b.c.iloc[29::30].to_numpy() / b.o.iloc[0] - 1))))
            pc = float(b.c.iloc[-1])
    b = a.bars(["QQQ"], "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, "15:59"))).reset_index(drop=True)
    sig = setups.b_intraday_momentum(b, sigma=float(np.mean(vals)), prev_close=pc) if len(b) > 200 else None
    if not sig:
        return []
    cst = Costs(slippage_per_share=0.022)
    tr = simulate(b, sig, REGISTRY["M3"](), cst, "QQQ", str(d), 6, 1e9, 1e9, flatten_idx=len(b) - 11)
    return [{"strategy": "B_qqq_qqqm", "R": tr.r_multiple(cst), "exit": tr.exits[-1][3]}] if tr else []


def run_watchlist_flag(a, d, sessions, daily) -> list[dict]:
    cache, so = PMCache(), SharesOutstanding()
    cands = build_candidates(d, daily, sessions, a, cache, so, with_quotes=True)
    cache.save()
    top, _ = rank(cands, load_yaml("ranking.yaml"))
    (ROOT / "watchlist" / f"{d}.json").write_text(json.dumps({"date": str(d), "top": top, "forward": True}, default=str))
    bars = minute_bars(a, d, [t["symbol"] for t in top])
    out = []
    for t in top:
        b = bars.get(t["symbol"])
        if b is None or len(b) < 60:
            continue
        sig = setups.s1_bull_flag_5m(b, window=(0, 120), atr_stop_mult=1.5)
        if sig:
            tr = simulate(b, sig, REGISTRY["M1"](), Costs(), t["symbol"], str(d), 6, 1e9, 1e9, flatten_idx=min(380, len(b) - 1))
            if tr:
                out.append({"strategy": "watchlist_bull_flag_atr_M1", "symbol": t["symbol"], "R": tr.r_multiple(Costs())})
    return out


def run_hod_flag(a, d, daily) -> list[dict]:
    import r2_intraday_hod as h
    dd = daily.sort_values(["symbol", "date"]).copy()
    dd["pc"] = dd.groupby("symbol").c.shift(1)
    dd["adv20"] = dd.groupby("symbol").v.transform(lambda s: s.rolling(20).mean().shift(1))
    g = dd[(dd.date == d) & dd.pc.between(2, 30) & (dd.h / dd.pc - 1 >= 0.10) & (dd.v >= 1e6) & dd.adv20.notna()].set_index("symbol")
    if not len(g):
        return []
    f_t = h.volume_curve()
    bars = a.bars(list(g.index), "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, "15:59")))
    out = []
    for sym, b in bars.groupby("symbol"):
        b = b.sort_values("t").reset_index(drop=True)
        cum = np.cumsum(b.v.to_numpy())
        pc, adv = float(g.loc[sym, "pc"]), float(g.loc[sym, "adv20"])
        q = next((i for i in range(15, min(120, len(b) - 1)) if b.c.iloc[i] >= 1.10 * pc and 2 <= b.c.iloc[i] <= 30
                  and cum[i] / max(1.0, adv * f_t[min(i, len(f_t) - 1)]) >= 5), None)
        if q is None:
            continue
        sig = setups.s1_bull_flag_5m(b, window=(q + 1, 120), start=q, atr_stop_mult=1.5)
        if sig:
            tr = simulate(b, sig, REGISTRY["M1"](), Costs(), sym, str(d), 6, 1e9, 1e9, flatten_idx=min(380, len(b) - 1))
            if tr:
                out.append({"strategy": "hod_bull_flag_atr_M1", "symbol": sym, "R": tr.r_multiple(Costs())})
    return out


def main(day: str | None = None) -> None:
    a = AlpacaREST(per_minute=150)
    now = dt.datetime.now(ET)
    cal = a.calendar((now.date() - dt.timedelta(days=60)).isoformat(), now.date().isoformat())
    sessions = sorted(cal.date)
    closes = {r.date: r.close for r in cal.itertuples()}
    d = dt.date.fromisoformat(day) if day else max(x for x in sessions if et(x, closes[x]) + dt.timedelta(minutes=16) <= now)
    if str(d) in done_days():
        print("already done", d)
        return
    update_daily(a, d, now)
    daily = load_daily()
    trades = []
    for fn in (lambda: run_B(a, d, sessions), lambda: run_watchlist_flag(a, d, sessions, daily), lambda: run_hod_flag(a, d, daily)):
        try:
            trades += fn()
        except Exception as e:  # noqa: BLE001 — one strategy failing must not block the others
            append({"session": str(d), "error": repr(e)})
    for t in trades:
        append({"session": str(d), **t})
    append({"session": str(d), "session_marker": True, "n_trades": len(trades)})
    print(d, trades)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
