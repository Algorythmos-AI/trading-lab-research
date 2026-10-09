"""Nightly FORWARD test (DEC-0009, DEC-0010): after each session closes, re-run the frozen rules on that day's data
(delayed SIP, >15 min old) and append hypothetical trades to the forward ledger (var/forward/forward_trades.jsonl).

Frozen rules (no parameter may change without a new decision record):
  * legacy candidates (DEC-0009): B (QQQ signals, QQQM-equivalent costs, M3); watchlist bull flag (ATR stop, M1, W3);
    intraday-runner bull flag (HYP-0007, M1)
  * the two bull flags run as v2 (DEC-0011 H-LA, new trials restarted from zero): the watchlist prefilters on the
    09:25 pre-market gap instead of d's open, and the HOD flag requires cumulative volume >= 1M by the qualifying bar
    instead of full-day volume; both use split-adjusted prior closes (and ADV20). Their v1 rows
    (`watchlist_bull_flag_atr_M1`, `hod_bull_flag_atr_M1`) stay in the ledger untouched and are look-ahead biased:
    scorecards must report them as `biased` (BIASED), never pooled with the v2 keys
  * round 3 (DEC-0010, from its approval date): the ten SPEC-0001 trials HYP-0010..0019 (GG-1..4 on Sets F and P,
    MP-1, REV-1), run through the same per-day code as the batch runners (r3_run.gg_day, r3_intraday.intraday_day)
    and admitted at US$600, the account the hypotheses state

Bookkeeping (fixes D7):
  * a strategy that completes a session writes its own marker; a failing strategy writes an error row and no marker,
    so the next run retries it
  * the session marker is written once every strategy the session requires has its marker
  * catch-up: each run processes the newest MAX_CATCHUP incomplete sessions, oldest first, never before FORWARD_FROM
    (earlier dates are the holdout, DEC-0005)

Ledger integrity (audit PR 5c): append() is the only writer. It holds an exclusive lock (a sibling .lock file), writes
one line, flushes and fsyncs. Every row carries git_sha, ts (UTC) and prev_sha256, the sha256 of the previous line
(GENESIS on a fresh file's first line), so verify_chain() detects an edited, dropped or inserted line. Trade rows and
markers carry a key, and a key already in the ledger is never written again: a session starts with a
session_started row, and a run killed between a strategy's trade rows and its marker re-runs that strategy without
duplicating what it had written. Rows written before this change have no chain or key and stay as they are.

Usage: python scripts/forward_test.py [YYYY-MM-DD]   (default: every incomplete completed session, up to MAX_CATCHUP)"""
from __future__ import annotations

import contextlib
import datetime as dt
import functools
import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_pool import ScanFailed, SplitStore, build_one, scan_failure, universe_symbols  # noqa: E402
from r3_intraday import intraday_day  # noqa: E402
from r3_run import GG, SpreadAt, admit, gg_day, set_names, trade_row  # noqa: E402

from wt.backtest.engine import Costs, simulate  # noqa: E402
from wt.backtest.management import REGISTRY  # noqa: E402
from wt.backtest.runner import minute_bars  # noqa: E402
from wt.core import ledger  # noqa: E402
from wt.core.clock import ET, et, to_utc_iso  # noqa: E402
from wt.core.config import DATA_DIR, FORWARD_LEDGER, FORWARD_WATCHLIST_DIR, ROOT, load_yaml  # noqa: E402
from wt.data.alpaca import SIP_DELAY_MIN, AlpacaREST  # noqa: E402
from wt.data.edgar import SharesOutstanding  # noqa: E402
from wt.data.universe import DAILY, TailMeta, TailWindowExceeded, load_daily, load_daily_tail, tail_rows_for  # noqa: E402
from wt.ops.alerts import Alerts  # noqa: E402
from wt.ops.locks import job_lock  # noqa: E402
from wt.ops.safeio import atomic_replace  # noqa: E402
from wt.scanner.explain import explain, from_pool, pool_musts  # noqa: E402
from wt.scanner.features import PMCache, build_candidates  # noqa: E402
from wt.scanner.pool import POOL_DIR, SPLIT_CHECK_HI, SPLIT_CHECK_LO, DailyIndex, PoolConfig  # noqa: E402
from wt.scanner.ranking import rank  # noqa: E402
from wt.signals import setups  # noqa: E402
from wt.specs.loader import load_spec  # noqa: E402

FWD = FORWARD_LEDGER.parent          # runtime state (ADR 0002), git-ignored
LOG = FORWARD_LEDGER

FORWARD_FROM = dt.date(2026, 9, 28)   # first forward session; everything earlier is the holdout (DEC-0005) or before it
R3_FROM = dt.date(2026, 9, 28)        # DEC-0010: every round-3 trial runs nightly "from the approval date onward"
MAX_CATCHUP = 5                       # sessions per run
CANDIDATE_LOOKBACK = 90               # build_candidates' runner scan: sessions before d
TAIL_LOOKBACK = 300                   # the longest daily lookback of any forward strategy (pool: daily_lookback)
REFRESH_DAYS = 5                      # newest update chunks fetched again on every run (late prints, corrections)
LOCK_WAIT_S = 120.0                   # a ledger append waits this long for another writer, then fails the unit
GENESIS = "0" * 64                    # prev_sha256 of the first line of a fresh ledger
POOL_MIN_FREE_GB = 1.0                # one day's pool is small; the multi-year batch build keeps its own 3 GB floor
R3_EQUITY = 600.0                     # HYP-0010..0019 are stated for a US$600 account
R3_P_RELAX: frozenset[str] = frozenset()   # Set P musts relaxed by the count guard (DEC-0010); none until it rules
LEGACY = ("B_qqq_qqqm", "watchlist_bull_flag_atr_M1_v2", "hod_bull_flag_atr_M1_v2")
LEGACY_V1 = ("B_qqq_qqqm", "watchlist_bull_flag_atr_M1", "hod_bull_flag_atr_M1")   # what a pre-D7 session marker covers
BIASED = frozenset({"watchlist_bull_flag_atr_M1", "hod_bull_flag_atr_M1"})         # DEC-0011 H-LA: look-ahead
HOD_VOL_MIN = 1_000_000               # HOD v2: cumulative shares by the qualifying bar (v1: the full day's volume)
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


V2 = ("watchlist_bull_flag_atr_M1_v2", "hod_bull_flag_atr_M1_v2")
# DEC-0011: the v2 flags are NEW trials (85 -> 87). Pre-registration means they start on DEC-0011's acceptance date,
# never before it and never backfilled. Set this date in the PR that marks DEC-0011 accepted; until then they don't run.
V2_FROM: dt.date | None = None


def required(d: dt.date) -> set[str]:
    out = {"B_qqq_qqqm"} | (set(R3_HYP) if d >= R3_FROM else set())
    if V2_FROM is not None and d >= V2_FROM:
        out |= set(V2)
    return out


def done_by_session(rows: list[dict]) -> dict[str, set[str]]:
    """Strategies that have completed each session. A session marker written before per-strategy markers existed
    stands for the three legacy strategies of that time (LEGACY_V1), unless that session also logged an error (which
    one failed is unknown). The v2 flags are new trials, so no old marker covers them."""
    done: dict[str, set[str]] = defaultdict(set)
    old_errors = {str(r.get("session")) for r in rows if "error" in r and "strategy" not in r}
    for r in rows:
        s = str(r.get("session"))
        if r.get("strategy_marker"):
            done[s].add(r["strategy"])
        elif r.get("session_marker") and s not in old_errors:
            done[s].update(LEGACY_V1)
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


def trade_key(d: dt.date, strategy: str, t: dict, i: int) -> str:
    """session|strategy|symbol|entry time (or the row's index when a strategy records none, e.g. B)."""
    return f"{d}|{strategy}|{t.get('symbol', '')}|{t.get('entry_time') or i}"


def run_session(d: dt.date, units: list[Unit], done: set[str]) -> set[str]:
    """Run every unit that still owes a strategy for session d. Returns the strategies now complete.

    Two-phase: a session_started row, then per strategy its trade rows and its marker, then the session marker. All
    are keyed, so a rerun after a crash anywhere in between writes only what is missing."""
    need, complete = required(d) - done, set(done)
    if need:
        append({"session": str(d), "session_started": True, "need": sorted(need), "key": f"{d}|session_started"})
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
            for i, t in enumerate(rows):
                append({"session": str(d), **t, "strategy": n, "key": trade_key(d, n, t, i)})
            append({**marker(d, n, len(rows)), "key": f"{d}|{n}|strategy_marker"})
            complete.add(n)
    if need and required(d) <= complete:          # only the run that completes the session writes its marker
        n_trades = sum(1 for r in read_log() if r.get("session") == str(d) and "R" in r)
        append({"session": str(d), "session_marker": True, "n_trades": n_trades, "key": f"{d}|session_marker"})
    return complete


def by_strategy(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[r["strategy"]].append(r)
    return out


class Context:
    """The heavy inputs of a run, built once and only when a strategy needs them."""

    def __init__(self, a: AlpacaREST, sessions: list[dt.date], closes: dict, oldest: dt.date | None = None):
        self.a, self.sessions, self.closes, self.oldest = a, sessions, closes, oldest

    @functools.cached_property
    def _store(self) -> tuple[pd.DataFrame, TailMeta | None]:
        """Each symbol's last rows, enough for every lookback from the oldest session this run evaluates (the whole
        store peaks near 3 GB). WT_DAILY_FULL=1 loads everything, as before."""
        if self.oldest is None or os.environ.get("WT_DAILY_FULL") == "1":
            return load_daily(), None
        return load_daily_tail(tail_rows_for(self.oldest, max(PoolConfig.daily_lookback, TAIL_LOOKBACK)))

    @property
    def raw(self) -> pd.DataFrame:
        return self._store[0]

    @property
    def tail(self) -> TailMeta | None:
        return self._store[1]

    @functools.cached_property
    def daily(self) -> DailyIndex:
        return DailyIndex(self.raw, self.tail)

    @functools.cached_property
    def splits(self) -> SplitStore:
        return SplitStore(self.a, self.raw, tail=self.tail)

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
        """Build the day's causal pool if it isn't there yet (Sets F and P, and MP-1's Tier 2, read it).

        A scan with no data (DEC-0024, decision 2) raises ScanFailed: the unit that asked records an error and no
        marker, and the session is retried on the next run. A pool that an earlier failed scan saved for a session
        still owed holds no names; it is removed and rebuilt, so it cannot be read as a day with nothing to trade."""
        path = POOL_DIR / f"{d}.parquet"
        if path.exists():
            if not scan_failure(pool_stats(path)):
                return
            print(f"{d}: the saved pool came from a scan with no data; rebuilding it")
            path.unlink()
        free = shutil.disk_usage(DATA_DIR).free / 1e9
        if free < POOL_MIN_FREE_GB:
            raise RuntimeError(f"only {free:.1f} GB free; the pool build needs {POOL_MIN_FREE_GB} GB")
        cache = PMCache(since=self.sessions[0])       # this run's calendar: every session the pool build asks about
        try:
            st = build_one(self.a, d, self.sessions, self.daily, universe_symbols(), self.splits, cache, self.shares,
                           PoolConfig(), refuse_failed=True)
        except ScanFailed as e:
            page("forward:scan-failed", "Forward test: the scan had no data", f"{e}. The round-3 trials recorded an "
                 "error for this session, not a day without trades, and it will be retried on the next run.", 4)
            raise
        cache.save()
        low = collapse(d, vars(st))
        if low:
            page("forward:scan-thin", "Forward test: the scan looks thin", f"{d}: {'; '.join(low)}. The session is "
                 "recorded as normal; check the data feed.", 3)

    def close(self) -> None:
        if "spread_at" in self.__dict__:
            self.spread_at.save()


def tally(reasons) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in reasons:
        out[str(r)] = out.get(str(r), 0) + 1
    return dict(sorted(out.items()))


def trial_record(cands: list, res, skips=()) -> dict:
    """Counts for one trial's day: chains that reached admission, what stopped the others, and what admission did."""
    return {"candidates": len(cands), "skips": tally(s["reason"] for s in skips), "admitted": len(res.admitted),
            "admission_skips": tally(why for _, why in res.skipped)}


def gg_record(d: dt.date, which: str, spec: dict, relax, per_trial: dict, results: dict) -> dict:
    """The funnel of record for one set on one session, in counts: the pool the trials read, how many names it
    traded, and each trial's skips. Set F also gets the step and reason counts of wt.scanner.explain."""
    pool = pd.read_parquet(POOL_DIR / f"{d}.parquet")
    body = {"pool": {k: v for k, v in (pool.attrs.get("stats") or {}).items() if type(v) is int},
            "pool_rows": len(pool), "names": len(set_names(pool, which, spec, set(relax))),
            "trials": {t: trial_record(per_trial[t][0] if t in per_trial else [], results[t],
                                       per_trial[t][1] if t in per_trial else ()) for t in GG}}
    if which == "F":
        body["funnel"] = explain(from_pool(pool), spec, pool_musts(pool)).flat()
    return body


def note_funnel(d: dt.date, part: str, build: Callable[[], dict], section: str = "parts") -> None:
    """Write one part of the session's funnel record to var/forward/funnel/<d>.json, beside the ledger and never in
    it. Counts only. It describes what the unit did after the unit has decided, and nothing here can fail a unit:
    an error is printed and the trades are returned as they were."""
    try:
        path = FWD / "funnel" / f"{d}.json"
        doc = json.loads(path.read_text()) if path.exists() else {"session": str(d), "parts": {}}
        doc.setdefault(section, {})[part] = {**build(), "git_sha": git_sha()}
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(doc, indent=1, sort_keys=True)
        atomic_replace(path, lambda tmp: tmp.write_text(text))
    except Exception as e:  # noqa: BLE001 — a description must never cost a trial its session
        print(f"funnel record {d} {part}: {e!r}")


def pool_stats(path: Path) -> dict:
    """The counts saved with a pool file, or {} when it has none or cannot be read."""
    try:
        return dict(pd.read_parquet(path, columns=["symbol"]).attrs.get("stats") or {})
    except Exception:  # noqa: BLE001 — an unreadable pool is for the unit that reads it to report
        return {}


COLLAPSE_KEYS = ("universe", "snapshot_symbols")      # counts that barely move from day to day
COLLAPSE_RATIO, COLLAPSE_MIN_DAYS, COLLAPSE_LOOKBACK = 0.5, 5, 10


def tier1_count(path: Path) -> int | None:
    """How many names the funnel put in Tier 1 from a saved pool, or None when that cannot be told."""
    try:
        pool = pd.read_parquet(path)
        if not len(pool):
            return 0
        return int(explain(from_pool(pool), load_spec("SPEC-0001"), pool_musts(pool)).counts.get("tier1", 0))
    except Exception:  # noqa: BLE001 — the thin check only informs
        return None


def collapse(d: dt.date, stats: dict) -> list[str]:
    """Which of the day's scan counts fell below half the median of the last sessions' pools (DEC-0024, 2.3), plus
    a day that kept nothing, or put nothing in Tier 1, although the earlier days usually did. It only informs:
    nothing is blocked. Quiet until five earlier pools exist."""
    earlier = sorted(p for p in POOL_DIR.glob("*.parquet") if p.stem < str(d))[-COLLAPSE_LOOKBACK:]
    paths = [(p, s) for p, s in ((p, pool_stats(p)) for p in earlier) if s and not scan_failure(s)]
    past = [s for _, s in paths]
    out = []
    if len(past) >= COLLAPSE_MIN_DAYS:
        for k in COLLAPSE_KEYS:
            med = float(np.median([s.get(k) or 0 for s in past]))
            if med > 0 and (stats.get(k) or 0) < COLLAPSE_RATIO * med:
                out.append(f"{k} {stats.get(k) or 0} against a median of {med:.0f}")
        if (stats.get("kept") or 0) == 0 and float(np.median([s.get("kept") or 0 for s in past])) > 0:
            out.append("no name kept")
        elif (stats.get("kept") or 0) > 0 and tier1_count(POOL_DIR / f"{d}.parquet") == 0:
            t1 = [n for n in (tier1_count(p) for p, _ in paths) if n is not None]
            if len(t1) >= COLLAPSE_MIN_DAYS and float(np.median(t1)) > 0:
                out.append("no name reached Tier 1")
    return out


def page(key: str, title: str, message: str, priority: int) -> None:
    """One alert a day for `key`. An alert that cannot be sent never changes what the forward test records."""
    try:
        Alerts().once_per_day(key, title, message, priority)
    except Exception as e:  # noqa: BLE001
        print(f"alert {key}: {e!r}")


def signal_names(per_trial: dict) -> dict[str, list[str]]:
    """Per GG trial, the names on which the registered rule fired at least once: every first signal, whether the
    spread must then passed (the control inputs), failed (a `spread` skip) or the chain went on to admission."""
    out = {}
    for trial in GG:
        cands, skips, ctl = per_trial[trial] if trial in per_trial else ([], [], [])
        names = {c[0] for c in ctl} | {c.chain for c in cands if c.attempt == 1}
        names |= {s["symbol"] for s in skips if s.get("reason") == "spread"}
        out[trial] = sorted(names)
    return out


def note_signals(d: dt.date, per_trial: dict) -> None:
    """Keep Set F's signal names for the session in var/forward/signals/<d>.json, so the weekly scorecard can count
    how many the dry run also saw (DEC-0023, section 2). Names and nothing else: no time, price or result. Runtime
    state, never published. Like the funnel record it cannot fail a unit or change a trade."""
    try:
        path = FWD / "signals" / f"{d}.json"
        text = json.dumps({"session": str(d), "set": "F", "signals": signal_names(per_trial), "git_sha": git_sha()},
                          indent=1, sort_keys=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_replace(path, lambda tmp: tmp.write_text(text))
    except Exception as e:  # noqa: BLE001 — a description must never cost a trial its session
        print(f"signal names {d}: {e!r}")


# ---- sealed shadow outcomes (DEC-0023, section 4) ---------------------------------------------------------------
# What the registered exit simulation says of a signal that admission refused for cash or for a day stop. Written
# beside the ledger and never in it. SEALED: no code reads an R from these files; only the number resolved is
# counted. The seal opens once, by an experiment with its own id, after the round-3 evaluation is recorded and 30
# outcomes are resolved. A name that failed the funnel, a signal that failed a must, and a later attempt whose
# earlier attempt was not admitted are not refused signals and get no outcome.
SEALED_DIR_NAME = "sealed"
SHADOW_REASONS = ("unfunded", "day_stop_consecutive_losers", "day_stop_loss_R")


def shadow_rows(d: dt.date, strategy: str, res, spec: dict) -> list[dict]:
    """One row per refused signal: the candidate simulated alone at the registered equity and risk, as if nothing
    else were held that day. `resolved` is False when even the whole account could not fund it."""
    risk = R3_EQUITY * spec["risk"]["per_trade_risk_pct_of_equity"] / 100
    rows = []
    for cand, why in res.skipped:
        if why not in SHADOW_REASONS:
            continue
        tr, r = cand.resim(R3_EQUITY, risk)
        row = {"session": str(d), "strategy": strategy, "symbol": cand.chain, "attempt": cand.attempt,
               "refused": why, "signal_time": str(cand.entry_time), "resolved": tr is not None and r is not None}
        if row["resolved"]:
            row.update(R=float(r), entry=tr.entry, qty=tr.qty, exit_time=str(tr.exits[-1][0]))
        rows.append(row)
    return rows


def note_shadow(d: dt.date, part: str, results: dict[str, object], spec: dict) -> None:
    """Seal the day's shadow outcomes for the trials in `results` ({strategy: DayResult}) and record how many were
    refused and resolved, as counts, in the funnel record. Called after the unit's trades are decided; like the
    funnel record it can never fail a unit or change a trade."""
    try:
        by = {name: shadow_rows(d, name, res, spec) for name, res in results.items()}
        path = FWD / SEALED_DIR_NAME / f"{d}.json"
        doc = json.loads(path.read_text()) if path.exists() else {"session": str(d), "sealed": True, "parts": {}}
        doc["parts"][part] = {"rows": [r for rows in by.values() for r in rows], "git_sha": git_sha()}
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(doc, indent=1, sort_keys=True)
        atomic_replace(path, lambda tmp: tmp.write_text(text))
    except Exception as e:  # noqa: BLE001 — a shadow outcome must never cost a trial its session
        print(f"shadow outcomes {d} {part}: {e!r}")
        return
    note_funnel(d, part, lambda: {name: {"refused": len(rows), "resolved": sum(r["resolved"] for r in rows)}
                                  for name, rows in by.items()}, section="shadow")


def r3_gg(ctx: Context, d: dt.date, which: str) -> dict[str, list[dict]]:
    ctx.ensure_pool(d)
    relax = R3_P_RELAX if which == "P" else frozenset()
    per_trial = gg_day(ctx.a, d, which, ctx.spec, ctx.spread_at, ctx.closes.get(d, "16:00"), relax)
    out, results = {}, {}
    for trial in GG:
        cands = per_trial[trial][0] if trial in per_trial else []
        res = results[trial] = admit(cands, R3_EQUITY, ctx.spec)
        out[f"r3:{which}:{trial}"] = [trade_row(d, c, tr, r) for c, tr, r in res.admitted]
    note_funnel(d, f"set_{which}", lambda: gg_record(d, which, ctx.spec, relax, per_trial, results))
    note_shadow(d, f"set_{which}", {f"r3:{which}:{t}": r for t, r in results.items()}, ctx.spec)
    if which == "F":                      # the dry run follows Set F; Set P relaxes musts the dry run applies
        note_signals(d, per_trial)
    return out


def r3_intraday(ctx: Context, d: dt.date, trial: str) -> dict[str, list[dict]]:
    if trial == "MP-1":
        ctx.ensure_pool(d)                # MP-1's universe includes Set F's Tier 2 from the pool
    skips: dict = {}
    cands = intraday_day(ctx.a, d, trial, ctx.sessions, ctx.closes, ctx.daily, ctx.splits, ctx.shares, ctx.spec,
                         ctx.spread_at, skips)
    res = admit(cands, R3_EQUITY, ctx.spec)
    note_funnel(d, trial, lambda: {**trial_record(cands, res),
                                   "skips": {str(k): v for k, v in sorted(skips.items()) if type(v) is int}})
    out = {f"r3:{trial}": [trade_row(d, c, tr, r) for c, tr, r in res.admitted]}
    note_shadow(d, trial, {f"r3:{trial}": res}, ctx.spec)
    return out


def units_for(ctx: Context, d: dt.date) -> list[Unit]:
    a, sessions = ctx.a, ctx.sessions
    return [
        (("B_qqq_qqqm",), lambda: by_strategy(run_B(a, d, sessions))),
        (("watchlist_bull_flag_atr_M1_v2",), lambda: by_strategy(run_watchlist_flag(a, d, sessions, ctx.raw, ctx.splits,
                                                                                     ctx.tail))),
        (("hod_bull_flag_atr_M1_v2",), lambda: by_strategy(run_hod_flag(a, d, ctx.daily, ctx.splits))),
        (tuple(f"r3:F:{t}" for t in GG), lambda: r3_gg(ctx, d, "F")),
        (tuple(f"r3:P:{t}" for t in GG), lambda: r3_gg(ctx, d, "P")),
        (("r3:MP-1",), lambda: r3_intraday(ctx, d, "MP-1")),
        (("r3:REV-1",), lambda: r3_intraday(ctx, d, "REV-1")),
    ]


@functools.lru_cache(maxsize=1)
def git_sha() -> str:
    """Short HEAD of the checkout running the job, computed once per run."""
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return out.stdout.strip() or "unknown"


def _keys(lines: list[bytes]) -> set[str]:
    keys = set()
    for line in lines:
        if b'"key"' in line:
            with contextlib.suppress(ValueError):          # a torn line has no usable key
                r = json.loads(line)
                if isinstance(r, dict) and r.get("key"):
                    keys.add(str(r["key"]))
    return keys


def append(rec: dict) -> bool:
    """Append one row to the ledger: the only writer (see the module docstring). Returns False, writing nothing, when
    the row's key is already in the ledger."""
    FWD.mkdir(parents=True, exist_ok=True)
    with job_lock(LOG.name, root=LOG.parent, wait_s=LOCK_WAIT_S, poll_s=0.05) as got:
        if not got:
            raise TimeoutError(f"{LOG.name}: another writer held the lock for {LOCK_WAIT_S:.0f}s")
        data = LOG.read_bytes() if LOG.exists() else b""
        lines = [x for x in data.split(b"\n") if x]
        if rec.get("key") and str(rec["key"]) in _keys(lines):
            return False
        row = {**rec, "git_sha": git_sha(), "ts": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
               "prev_sha256": ledger.expected_prev(lines)}         # the rule verify_chain checks
        out = json.dumps(row, default=str).encode() + b"\n"
        if data and not data.endswith(b"\n"):
            out = b"\n" + out                              # end a torn line from a killed writer; verify_chain reports it
        with open(LOG, "ab") as f:
            f.write(out)
            f.flush()
            os.fsync(f.fileno())
    return True


def verify_chain(path: Path | None = None) -> list[str]:
    """Problems in the ledger's hash chain; empty when intact (the rules live in wt.core.ledger)."""
    return ledger.verify_chain(path or LOG)


def daily_end(d: dt.date, now: dt.datetime) -> str:
    """End of the daily-bar request for session d: the next midnight ET, capped at now - SIP_DELAY_MIN.

    The free plan refuses any SIP request that reaches into the last 15 minutes (HTTP 403, DEC-0003), and an
    end of tomorrow's date does, so the nightly run ~20 minutes after the close failed on 2026-09-28.
    """
    return to_utc_iso(min(et(d + dt.timedelta(days=1), "00:00"), now - dt.timedelta(minutes=SIP_DELAY_MIN)))


def update_days(chunks: Path, pending: list[dt.date], n: int = REFRESH_DAYS) -> list[dt.date]:
    """The pending sessions plus the newest n update chunks' sessions."""
    have = set()
    for f in chunks.glob("chunk_zupd_*.parquet"):
        with contextlib.suppress(ValueError):          # a hand-named file is read by load_daily, never refreshed
            have.add(dt.date.fromisoformat(f.stem.removeprefix("chunk_zupd_")))
    return sorted(set(pending) | set(sorted(have | set(pending))[-n:]))


def update_daily(a: AlpacaREST, pending: list[dt.date], now: dt.datetime | None = None) -> list[dt.date]:
    """Fetch each pending session's daily bars into chunks/chunk_zupd_<d>.parquet, and fetch the newest REFRESH_DAYS
    update chunks again, each replaced atomically. The first fetch runs ~20 minutes after the close, before late
    prints and vendor corrections settle, so it must not be the only one; a base rebuild still wins over any update
    chunk (load_daily). Returns the pending sessions whose bars are on disk. A failed fetch keeps the chunk that
    was there; a pending session without one is logged and retried next run."""
    now = now or dt.datetime.now(ET)
    chunks = DAILY.parent / "chunks"
    syms = sorted(set(pd.concat([pd.read_parquet(x, columns=["symbol"]) for x in chunks.glob("chunk_0*.parquet")]).symbol))
    ready = []
    for d in update_days(chunks, pending):
        f = chunks / f"chunk_zupd_{d}.parquet"
        try:
            end = daily_end(d, now)
            parts = [a.bars(syms[i:i + 200], "1Day", d.isoformat(), end) for i in range(0, len(syms), 200)]
            atomic_replace(f, pd.concat(parts, ignore_index=True).to_parquet)
        except Exception as e:  # noqa: BLE001 — without the day's bars nothing can run; retried next run
            print(d, "daily update failed:", repr(e)[:200], flush=True)
            if d in pending and not f.exists():
                append({"session": str(d), "strategy": "daily_update", "error": repr(e)[:500]})
        if d in pending and f.exists():
            ready.append(d)
    return ready


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


def run_watchlist_flag(a, d, sessions, daily, splits: SplitStore, tail: TailMeta | None = None) -> list[dict]:
    """Watchlist bull flag v2: the frozen ranking and entry, on candidates prefiltered by the 09:25 pre-market gap
    (v1 used d's open, known only at 09:30) with split-adjusted prior closes."""
    start = sessions[max(0, sessions.index(d) - CANDIDATE_LOOKBACK)]
    if tail is not None and not tail.covers(start):          # build_candidates filters the raw frame by date
        raise TailWindowExceeded(f"watchlist {d}: the tail load holds every symbol only from {tail.complete_from}")
    cache, so = PMCache(since=sessions[0]), SharesOutstanding()
    cands = build_candidates(d, daily, sessions, a, cache, so, with_quotes=True, causal=True,
                             split_refresh=lambda syms: splits.refresh(syms, d, split_like=syms))
    cache.save()
    top, _ = rank(cands, load_yaml("ranking.yaml"))
    FORWARD_WATCHLIST_DIR.mkdir(parents=True, exist_ok=True)       # v2 file: the v1 watchlists stay as they were
    (FORWARD_WATCHLIST_DIR / f"{d}_v2.json").write_text(json.dumps({"date": str(d), "top": top, "forward": True,
                                                                    "strategy": "watchlist_bull_flag_atr_M1_v2"}, default=str))
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
                out.append({"strategy": "watchlist_bull_flag_atr_M1_v2", "symbol": t["symbol"], "R": tr.r_multiple(Costs()),
                            "entry_time": str(tr.entry_time)})
    return out


def hod_superset(daily: DailyIndex, d: dt.date, splits: SplitStore) -> pd.DataFrame:
    """HOD v2 fetch superset for d, indexed by symbol with pc and adv20: prior close $2-30, and from d's daily bar a
    high >= +10% and volume >= 1M. Only a superset, so no look-ahead: the qualifying bar needs a close >= +10% and
    cumulative volume >= 1M, and the day's high and volume are at least that. As in v1, 20 prior daily bars are
    required. Prior close and ADV20 are on d's share basis (R-C2); raw moves that look like a split are refreshed."""
    today = daily.on(d)
    today = today[today.v >= HOD_VOL_MIN]
    rows = []
    for s, r in today.iterrows():
        hist = daily.before(s, d, 20)
        if len(hist) == 20:
            rows.append((s, r.o, r.h, r.c, float(hist.c.iloc[-1]), hist.date.iloc[-1]))
    t = pd.DataFrame(rows, columns=["symbol", "o", "h", "c", "pc", "pdate"]).set_index("symbol")
    if not len(t):
        return t.assign(adv20=[])
    hi, lo = 1 + SPLIT_CHECK_HI, 1 + SPLIT_CHECK_LO
    like = sorted(t.index[(t.o / t.pc >= hi) | (t.o / t.pc <= lo) | (t.c / t.pc >= hi) | (t.c / t.pc <= lo)])
    sf = splits.refresh(like, d, split_like=like)
    t["pc"] = t.pc * [sf.factor(s, d) / sf.factor(s, x) for s, x in zip(t.index, t.pdate, strict=True)]
    g = t[t.pc.between(2, 30) & (t.h / t.pc - 1 >= 0.10)].copy()
    g["adv20"] = [float(sf.adjust_asof(daily.before(s, d, 20), d).v.mean()) for s in g.index]
    return g


def hod_qualify(b: pd.DataFrame, pc: float, adv: float, f_t: np.ndarray) -> int | None:
    """HOD v2 qualification: the first 1-minute bar in 09:45-11:30 closing >= +10% over the prior close, at $2-30, with
    cumulative volume >= 1M and >= 5x the expected cumulative volume by then. Only bars up to the decision bar count."""
    c, cum = b.c.to_numpy(float), np.cumsum(b.v.to_numpy(float))
    return next((i for i in range(15, min(120, len(b) - 1)) if c[i] >= 1.10 * pc and 2 <= c[i] <= 30
                 and cum[i] >= HOD_VOL_MIN and cum[i] / max(1.0, adv * f_t[min(i, len(f_t) - 1)]) >= 5), None)


def run_hod_flag(a, d, daily: DailyIndex, splits: SplitStore) -> list[dict]:
    """HOD bull flag v2 (DEC-0011 H-LA): v1 fetched only names whose FULL-DAY volume reached 1M, known at the close."""
    import r2_intraday_hod as h
    g = hod_superset(daily, d, splits)
    if not len(g):
        return []
    f_t = h.volume_curve()
    bars = a.bars(list(g.index), "1Min", to_utc_iso(et(d, "09:30")), to_utc_iso(et(d, "15:59")))
    out = []
    for sym, b in bars.groupby("symbol"):
        b = b.sort_values("t").reset_index(drop=True)
        q = hod_qualify(b, float(g.loc[sym, "pc"]), float(g.loc[sym, "adv20"]), f_t)
        if q is None:
            continue
        sig = setups.s1_bull_flag_5m(b, window=(q + 1, 120), start=q, atr_stop_mult=1.5)
        if sig:
            tr = simulate(b, sig, REGISTRY["M1"](), Costs(), sym, str(d), 6, 1e9, 1e9, flatten_idx=min(380, len(b) - 1))
            if tr:
                out.append({"strategy": "hod_bull_flag_atr_M1_v2", "symbol": sym, "R": tr.r_multiple(Costs()),
                            "entry_time": str(tr.entry_time)})
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
    ready = update_daily(a, days, now)    # daily bars first, so the store is loaded once with every pending day in it
    ctx = Context(a, sessions, closes, min(ready) if ready else None)
    try:
        for d in ready:
            complete = run_session(d, units_for(ctx, d), done.get(str(d), set()))
            missing = sorted(required(d) - complete)
            print(d, "complete" if not missing else f"incomplete, will retry: {missing}", flush=True)
    finally:
        ctx.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
