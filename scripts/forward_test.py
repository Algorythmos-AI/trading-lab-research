"""Nightly FORWARD test (DEC-0009, DEC-0010): after each session closes, re-run the frozen rules on that day's data
(delayed SIP, >15 min old) and append hypothetical trades to the forward ledger (var/forward/forward_trades.jsonl).

Frozen rules (no parameter may change without a new decision record):
  * legacy candidates (DEC-0009): B (QQQ signals, QQQM-equivalent costs, M3); watchlist bull flag (ATR stop, M1, W3);
    intraday-runner bull flag (HYP-0007, M1)
  * round 3 (DEC-0010, from its approval date): the ten SPEC-0001 trials HYP-0010..0019 (GG-1..4 on Sets F and P,
    MP-1, REV-1), run through the same per-day code as the batch runners (r3_run.gg_day, r3_intraday.intraday_day)
    and admitted at US$600, the account the hypotheses state

Bookkeeping (fixes D7):
  * a strategy that completes a session writes its own marker; a failing strategy writes an error row and no marker,
    so the next run retries it
  * the session marker is written once every strategy the session requires has its marker
  * catch-up: each run processes the newest MAX_CATCHUP incomplete sessions, oldest first, never before FORWARD_FROM
    (earlier dates are the holdout, DEC-0005)

Usage: python scripts/forward_test.py [YYYY-MM-DD]   (default: every incomplete completed session, up to MAX_CATCHUP)"""
from __future__ import annotations

import datetime as dt
import functools
import json
import shutil
import sys
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_pool import SplitStore, build_one, universe_symbols  # noqa: E402
from r3_intraday import intraday_day  # noqa: E402
from r3_run import GG, SpreadAt, admit, gg_day, trade_row  # noqa: E402

from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.runner import minute_bars  # noqa: E402
from wt.core.clock import ET, et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR, FORWARD_LEDGER, FORWARD_WATCHLIST_DIR, load_yaml  # noqa: E402
from wt.data.alpaca import SIP_DELAY_MIN, AlpacaREST  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import DAILY, load_daily  # noqa: E402
from wt.scanner.features import PMCache, build_candidates  # noqa: E402
from wt.scanner.pool import POOL_DIR, DailyIndex, PoolConfig  # noqa: E402
from wt.scanner.ranking import rank  # noqa: E402
from wt.signals import setups  # noqa: E402
from wt.specs.loader import load_spec  # noqa: E402

FWD = FORWARD_LEDGER.parent          # runtime state (ADR 0002), git-ignored
LOG = FORWARD_LEDGER

FORWARD_FROM = dt.date(2026, 9, 28)   # first forward session; everything earlier is the holdout (DEC-0005) or before it
R3_FROM = dt.date(2026, 9, 28)        # DEC-0010: every round-3 trial runs nightly "from the approval date onward"
MAX_CATCHUP = 5                       # sessions per run
POOL_MIN_FREE_GB = 1.0                # one day's pool is small; the multi-year batch build keeps its own 3 GB floor
R3_EQUITY = 600.0                     # HYP-0010..0019 are stated for a US$600 account
R3_P_RELAX: frozenset[str] = frozenset()   # Set P musts relaxed by the count guard (DEC-0010); none until it rules
LEGACY = ("B_qqq_qqqm", "watchlist_bull_flag_atr_M1", "hod_bull_flag_atr_M1")
R3_HYP = {"r3:F:GG-1": "HYP-0010", "r3:F:GG-2": "HYP-0011", "r3:F:GG-3": "HYP-0012", "r3:F:GG-4": "HYP-0013",
          "r3:P:GG-1": "HYP-0014", "r3:P:GG-2": "HYP-0015", "r3:P:GG-3": "HYP-0016", "r3:P:GG-4": "HYP-0017",
          "r3:MP-1": "HYP-0018", "r3:REV-1": "HYP-0019"}

Unit = tuple[tuple[str, ...], Callable[[], dict[str, list[dict]]]]


def read_log() -> list[dict]:
    if not LOG.exists():
        return []
    rows = []
    for line in LOG.read_text().splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue                      # a torn last line from an interrupted run
        if isinstance(r, dict):
            rows.append(r)
    return rows


def required(d: dt.date) -> set[str]:
    return set(LEGACY) | (set(R3_HYP) if d >= R3_FROM else set())


def done_by_session(rows: list[dict]) -> dict[str, set[str]]:
    """Strategies that have completed each session. A session marker written before per-strategy markers existed
    stands for the three legacy strategies, unless that session also logged an error (which one failed is unknown)."""
    done: dict[str, set[str]] = defaultdict(set)
    old_errors = {str(r.get("session")) for r in rows if "error" in r and "strategy" not in r}
    for r in rows:
        s = str(r.get("session"))
        if r.get("strategy_marker"):
            done[s].add(r["strategy"])
        elif r.get("session_marker") and s not in old_errors:
            done[s].update(LEGACY)
    return done


def pending_sessions(sessions: list[dt.date], closes: dict, now: dt.datetime, done: dict[str, set[str]],
                     max_n: int = MAX_CATCHUP) -> list[dt.date]:
    """Completed sessions (closed more than SIP_DELAY_MIN ago) that still owe a strategy: the newest max_n, oldest
    first, so a strategy that keeps failing on an old session never starves the newest one."""
    ready = [x for x in sessions if x >= FORWARD_FROM
             and et(x, closes.get(x, "16:00")) + dt.timedelta(minutes=SIP_DELAY_MIN) <= now]
    return [x for x in ready if required(x) - done.get(str(x), set())][-max_n:]


@functools.lru_cache(maxsize=1)
def spec_version() -> str:
    return str(load_spec("SPEC-0001")["version"])


def marker(d: dt.date, name: str, n: int) -> dict:
    rec = {"session": str(d), "strategy": name, "strategy_marker": True, "n_trades": n}
    if name in R3_HYP:
        rec.update(hyp=R3_HYP[name], spec="SPEC-0001", spec_version=spec_version(), equity=R3_EQUITY,
                   relax=sorted(R3_P_RELAX) if name.startswith("r3:P:") else [])
    return rec


def run_session(d: dt.date, units: list[Unit], done: set[str]) -> set[str]:
    """Run every unit that still owes a strategy for session d. Returns the strategies now complete."""
    need, complete = required(d) - done, set(done)
    for names, fn in units:
        todo = [n for n in names if n in need]
        if not todo:
            continue
        try:
            res = fn()
        except Exception as e:  # noqa: BLE001 — one strategy failing must not block the others; retried next run
            append({"session": str(d), "strategy": ",".join(todo), "error": repr(e)[:500]})
            continue
        for n in todo:
            rows = res.get(n, [])
            for t in rows:
                append({"session": str(d), **t, "strategy": n})
            append(marker(d, n, len(rows)))
            complete.add(n)
    if need and required(d) <= complete:          # only the run that completes the session writes its marker
        n_trades = sum(1 for r in read_log() if r.get("session") == str(d) and "R" in r)
        append({"session": str(d), "session_marker": True, "n_trades": n_trades})
    return complete


def by_strategy(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[r["strategy"]].append(r)
    return out


class Context:
    """The heavy inputs of a run, built once and only when a strategy needs them."""

    def __init__(self, a: AlpacaREST, sessions: list[dt.date], closes: dict):
        self.a, self.sessions, self.closes = a, sessions, closes

    @functools.cached_property
    def raw(self) -> pd.DataFrame:
        return load_daily()

    @functools.cached_property
    def daily(self) -> DailyIndex:
        return DailyIndex(self.raw)

    @functools.cached_property
    def splits(self) -> SplitStore:
        return SplitStore(self.a, self.raw)

    @functools.cached_property
    def shares(self) -> SharesOutstanding:
        return SharesOutstanding()

    @functools.cached_property
    def spec(self) -> dict:
        return load_spec("SPEC-0001")

    @functools.cached_property
    def spread_at(self) -> SpreadAt:
        return SpreadAt(self.a)

    def ensure_pool(self, d: dt.date) -> None:
        """Build the day's causal pool if it isn't there yet (Sets F and P, and MP-1's Tier 2, read it)."""
        if (POOL_DIR / f"{d}.parquet").exists():
            return
        free = shutil.disk_usage(DATA_DIR).free / 1e9
        if free < POOL_MIN_FREE_GB:
            raise RuntimeError(f"only {free:.1f} GB free; the pool build needs {POOL_MIN_FREE_GB} GB")
        cache = PMCache()
        build_one(self.a, d, self.sessions, self.daily, universe_symbols(), self.splits, cache, self.shares, PoolConfig())
        cache.save()

    def close(self) -> None:
        if "spread_at" in self.__dict__:
            self.spread_at.save()


def r3_gg(ctx: Context, d: dt.date, which: str) -> dict[str, list[dict]]:
    ctx.ensure_pool(d)
    per_trial = gg_day(ctx.a, d, which, ctx.spec, ctx.spread_at, ctx.closes.get(d, "16:00"),
                       R3_P_RELAX if which == "P" else frozenset())
    out = {}
    for trial in GG:
        cands = per_trial[trial][0] if trial in per_trial else []
        res = admit(cands, R3_EQUITY, ctx.spec)
        out[f"r3:{which}:{trial}"] = [trade_row(d, c, tr, r) for c, tr, r in res.admitted]
    return out


def r3_intraday(ctx: Context, d: dt.date, trial: str) -> dict[str, list[dict]]:
    if trial == "MP-1":
        ctx.ensure_pool(d)                # MP-1's universe includes Set F's Tier 2 from the pool
    cands = intraday_day(ctx.a, d, trial, ctx.sessions, ctx.closes, ctx.daily, ctx.splits, ctx.shares, ctx.spec,
                         ctx.spread_at, {})
    res = admit(cands, R3_EQUITY, ctx.spec)
    return {f"r3:{trial}": [trade_row(d, c, tr, r) for c, tr, r in res.admitted]}


def units_for(ctx: Context, d: dt.date) -> list[Unit]:
    a, sessions = ctx.a, ctx.sessions
    return [
        (("B_qqq_qqqm",), lambda: by_strategy(run_B(a, d, sessions))),
        (("watchlist_bull_flag_atr_M1",), lambda: by_strategy(run_watchlist_flag(a, d, sessions, ctx.raw))),
        (("hod_bull_flag_atr_M1",), lambda: by_strategy(run_hod_flag(a, d, ctx.raw))),
        (tuple(f"r3:F:{t}" for t in GG), lambda: r3_gg(ctx, d, "F")),
        (tuple(f"r3:P:{t}" for t in GG), lambda: r3_gg(ctx, d, "P")),
        (("r3:MP-1",), lambda: r3_intraday(ctx, d, "MP-1")),
        (("r3:REV-1",), lambda: r3_intraday(ctx, d, "REV-1")),
    ]


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
    FORWARD_WATCHLIST_DIR.mkdir(parents=True, exist_ok=True)
    (FORWARD_WATCHLIST_DIR / f"{d}.json").write_text(json.dumps({"date": str(d), "top": top, "forward": True}, default=str))
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
    if day and dt.date.fromisoformat(day) < FORWARD_FROM:
        raise SystemExit(f"{day} is before FORWARD_FROM ({FORWARD_FROM}); earlier sessions are the holdout (DEC-0005)")
    a = AlpacaREST(per_minute=150)
    now = dt.datetime.now(ET)
    cal = a.calendar((now.date() - dt.timedelta(days=60)).isoformat(), now.date().isoformat())
    sessions = sorted(cal.date)
    closes = {r.date: r.close for r in cal.itertuples()}
    done = done_by_session(read_log())
    if day:
        d = dt.date.fromisoformat(day)
        if d not in closes or et(d, closes[d]) + dt.timedelta(minutes=SIP_DELAY_MIN) > now:
            raise SystemExit(f"{d} is not a completed session yet")
        days = [d] if required(d) - done.get(str(d), set()) else []
    else:
        days = pending_sessions(sessions, closes, now, done)
    if not days:
        print("nothing to do: every completed session since", FORWARD_FROM, "has all its strategies")
        return
    ready = []
    for d in days:                        # daily bars first, so the store is loaded once with every pending day in it
        try:
            update_daily(a, d, now)
            ready.append(d)
        except Exception as e:  # noqa: BLE001 — without the day's bars nothing can run; retried next run
            append({"session": str(d), "strategy": "daily_update", "error": repr(e)[:500]})
            print(d, "daily update failed:", repr(e)[:200], flush=True)
    ctx = Context(a, sessions, closes)
    try:
        for d in ready:
            complete = run_session(d, units_for(ctx, d), done.get(str(d), set()))
            missing = sorted(required(d) - complete)
            print(d, "complete" if not missing else f"incomplete, will retry: {missing}", flush=True)
    finally:
        ctx.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
