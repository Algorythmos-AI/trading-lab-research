"""EXP-0048: Robot B's paper execution, measured against the backtest's fill model (pure; no I/O, no network).

Reads a snapshot of the host's runner records (the hash-chained journal, the per-day plan files, the replay records)
and returns aggregates only: how far B's paper fills sat from the prices the backtest engine would have booked, how
long each step took, which execution incidents the order manager noted, what blocked the runner and how often the
replayed rule agreed with it. No per-trade value leaves this module; `aggregate()` is the only output.

The fill model is `wt.backtest.engine.simulate`, read in R of the paper trade (QQQM prices):
  entry   model = trigger + slip; the engine's max(trigger, bar open) gap term needs a QQQM bar, which the host does
          not record, so the entry shortfall against the model is an upper bound (a gap would charge the model too)
  stop    model = stop - stop slip (same caveat for a gap through the stop)
  target  model = target (touch fill, the recorded default)
  flatten model = the flatten bar's open - slip: not measurable here (no QQQM bar); counted, never measured
`slip` is B's registered $0.022 per QQQ share (1c per QQQM share), carried to QQQM by the runner's own `ratio`, so
the model charge in R is the one the backtest's R-multiples carry. A shortfall is positive when paper did worse.
"""
from __future__ import annotations

import datetime as dt
import math
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

SLIP_PER_SHARE_SIGNAL = 0.022         # B's frozen cost: 1c per QQQM share = 2.2c in QQQ units (the active-strategy
                                      # file; scripts/g1_etf.py and holdout_b.py run Costs(slippage_per_share=0.022))
INCIDENTS = ("exit_failed", "exit_deferred", "exit_unfilled_restopped", "exit_cancel_unconfirmed",
             "entry_remainder_canceled", "entry_cancel_unconfirmed", "stop_resize_deferred", "entry_not_at_broker")
BLOCKERS = ("plan_not_persisted", "account_not_persisted", "kill_file", "latched", "max_1_trade_per_day",
            "exposure_exists", "event", "stale_signal_data", "spread_or_no_quote")
FAULTS = ("loop_error", "data_timeout", "decision_inputs_missing", "decision_inputs_unavailable", "decision_error",
          "reconcile", "clock_skew", "broker_connect_failed", "persist_failed", "account_save_failed",
          "journal_write_failed", "close_unknown", "startup_reconcile_error", "startup_positions_error",
          "signal_skipped_size", "signal_skipped_no_quote", "entry_not_placed", "refuse_to_arm", "no_session")
EXIT_KINDS = ("target", "stop", "eod_flatten")
POWER_Z = 1.959963984540054 + 0.8416212335729143      # two-sided 5 %, 80 % power


class SnapshotError(ValueError):
    """The snapshot cannot be read as registered (a broken chain, a missing record, a mismatch with the plans)."""


def _ts(v: Any) -> dt.datetime | None:
    if not isinstance(v, str):
        return None
    try:
        t = dt.datetime.fromisoformat(v)
    except ValueError:
        return None
    return t if t.tzinfo else None


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


@dataclass
class Session:
    day: str
    rows: list[Mapping[str, Any]] = field(default_factory=list)


def sessions(rows: Iterable[Mapping[str, Any]], last_day: str) -> list[Session]:
    """The journal cut into armed sessions (armed ... session_end), up to and including `last_day`.

    Rows outside any armed block (no_session, a refused start) are kept on a pseudo-session named by the row's own
    `day` or, without one, the previous session's day, so they are counted and never dropped."""
    out: list[Session] = []
    cur: Session | None = None
    for r in rows:
        ev = r.get("event")
        if ev == "armed":
            day = str(r.get("day"))
            if day > last_day:
                break
            cur = Session(day, [r])
            out.append(cur)
            continue
        if cur is None:
            day = str(r.get("day", ""))
            if day and day > last_day:
                break
            out.append(Session(day or "?", [r]))
            continue
        cur.rows.append(r)
        if ev == "session_end":
            cur = None
    return out


@dataclass(frozen=True)
class Fill:
    """One paper trade's execution facts (internal; never emitted)."""
    day: str
    ratio: float
    trigger: float
    limit: float
    stop: float
    target: float
    entry: float
    exit: float | None
    reason: str
    estimated: bool
    R_closed: float
    placed_latency_s: float | None
    fill_latency_s: float | None
    flatten_delay_s: float | None
    incidents: Mapping[str, int]
    exit_failed_kinds: Mapping[str, int]

    @property
    def r_ps(self) -> float:
        return self.trigger - self.stop

    @property
    def slip_ps(self) -> float:
        return SLIP_PER_SHARE_SIGNAL * self.ratio


def _first(rows: Sequence[Mapping[str, Any]], event: str) -> Mapping[str, Any] | None:
    return next((r for r in rows if r.get("event") == event), None)


def exit_failed_kind(msg: Any) -> str:
    s = str(msg).lower()
    if "within long position" in s or "insufficient" in s or "held for orders" in s:
        return "sell_exceeds_available"
    return "other"


def fills(sess: Sequence[Session], plans: Mapping[str, Mapping[str, Any]]) -> list[Fill]:
    """Every session's trade, journal joined to that day's plan file. Raises SnapshotError on any mismatch."""
    out: list[Fill] = []
    for s in sess:
        placed = _first(s.rows, "entry_placed")
        filled = _first(s.rows, "entry_filled")
        closed = _first(s.rows, "trade_closed")
        if placed is None and filled is None and closed is None:
            continue
        if placed is None or filled is None or closed is None:
            raise SnapshotError(f"{s.day}: a trade without its entry_placed, entry_filled and trade_closed rows")
        p = plans.get(s.day)
        if p is None:
            raise SnapshotError(f"{s.day}: no plan file for a journaled trade")
        trig, stop = _num(placed.get("trigger")), _num(placed.get("stop"))
        ratio, entry = _num(placed.get("ratio")), _num(filled.get("price"))
        if trig is None or stop is None or ratio is None or entry is None or trig <= stop:
            raise SnapshotError(f"{s.day}: entry_placed or entry_filled lacks a usable trigger, stop, ratio or price")
        if (abs(trig - float(p["trigger"])) > 1e-9 or abs(stop - float(p["stop"])) > 1e-9
                or abs(entry - float(p["avg_entry"])) > 1e-6):
            raise SnapshotError(f"{s.day}: journal and plan disagree on trigger, stop or entry")
        reason = str(closed.get("reason"))
        if reason != str(p.get("exit_reason")):
            raise SnapshotError(f"{s.day}: journal and plan disagree on the exit reason")
        decision = None
        for r in s.rows:
            if r is placed:
                break
            if r.get("event") == "decision" and r.get("runner_acts"):
                decision = r
        sig_t = _ts(decision.get("signal_t")) if decision else None
        t_placed, t_filled, t_closed = _ts(placed.get("ts")), _ts(filled.get("ts")), _ts(closed.get("ts"))
        flat = _ts(s.rows[0].get("flatten")) if s.rows and s.rows[0].get("event") == "armed" else None
        log = [m for m in (p.get("log") or []) if isinstance(m, list) and m]
        inc = Counter(str(m[0]) for m in log if m[0] in INCIDENTS)
        kinds = Counter(exit_failed_kind(m[2] if len(m) > 2 else "") for m in log if m[0] == "exit_failed")
        out.append(Fill(
            day=s.day, ratio=ratio, trigger=trig, limit=float(p["limit"]), stop=stop, target=float(p["target"]),
            entry=entry, exit=_num(closed.get("exit")), reason=reason,
            estimated=bool(closed.get("exit_price_estimated")), R_closed=float(closed.get("R") or 0.0),
            placed_latency_s=(t_placed - (sig_t + dt.timedelta(minutes=1))).total_seconds()
            if t_placed and sig_t else None,
            fill_latency_s=(t_filled - t_placed).total_seconds() if t_filled and t_placed else None,
            flatten_delay_s=(t_closed - flat).total_seconds() if reason == "eod_flatten" and t_closed and flat
            else None,
            incidents={k: inc.get(k, 0) for k in INCIDENTS},
            exit_failed_kinds=dict(kinds)))
    return out


def entry_shortfall_R(f: Fill) -> float:
    """Paper entry against the model's trigger + slip, in R (positive: paper paid more)."""
    return (f.entry - f.trigger - f.slip_ps) / f.r_ps


def exit_shortfall_R(f: Fill) -> float | None:
    """Paper exit against the model's exit price, in R (positive: paper got less). None where the leg is not
    measurable: a flatten (no QQQM bar), an estimated exit price, or an unknown reason."""
    if f.exit is None or f.estimated:
        return None
    if f.reason == "target":
        return (f.target - f.exit) / f.r_ps
    if f.reason == "stop":
        return ((f.stop - f.slip_ps) - f.exit) / f.r_ps
    return None


def bps(f: Fill) -> float:
    return (f.entry - f.trigger) / f.trigger * 1e4


def summary(xs: Sequence[float], seed: int, n_boot: int) -> dict[str, Any]:
    """n, mean, median, sd, a percentile CI95 of the mean (trade bootstrap, one trade per session) and the smallest
    mean shift this n could tell from zero at 80 % power. Nothing for an empty leg; no CI below 3 values."""
    a = np.asarray(list(xs), dtype=float)
    if not len(a):
        return {"n": 0}
    out: dict[str, Any] = {"n": int(len(a)), "mean": float(a.mean()), "median": float(np.median(a))}
    if len(a) >= 2:
        sd = float(a.std(ddof=1))
        out["sd"] = sd
        out["detectable_mean_80pct"] = POWER_Z * sd / math.sqrt(len(a))
    if len(a) >= 3:
        rng = np.random.default_rng(seed)
        boots = rng.choice(a, size=(n_boot, len(a)), replace=True).mean(axis=1)
        out["ci95"] = [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]
    return out


def blockers(sess: Sequence[Session]) -> dict[str, Any]:
    """Blocked marks by registered category, and the sessions each category blocked at least once."""
    marks: Counter[str] = Counter()
    days: dict[str, set[str]] = {}
    for s in sess:
        for r in s.rows:
            if r.get("event") != "blocked":
                continue
            for b in r.get("blockers") or []:
                cat = str(b).split(":", 1)[0]
                cat = cat if cat in BLOCKERS else "other"
                marks[cat] += 1
                days.setdefault(cat, set()).add(s.day)
    cats = (*BLOCKERS, "other")
    return {"blocked_rows": sum(1 for s in sess for r in s.rows if r.get("event") == "blocked"),
            "marks_by_category": {c: marks.get(c, 0) for c in cats},
            "sessions_by_category": {c: len(days.get(c, ())) for c in cats}}


def faults(sess: Sequence[Session]) -> dict[str, Any]:
    """Rows and sessions per registered fault event (any unregistered event name is counted as `other_events`)."""
    known = {"armed", "session_end", "lease", "decision", "decision_summary", "blocked", "entry_placed",
             "entry_filled", "trade_closed", *FAULTS}
    rows: Counter[str] = Counter()
    days: dict[str, set[str]] = {}
    other = 0
    for s in sess:
        for r in s.rows:
            ev = str(r.get("event"))
            if ev in FAULTS:
                rows[ev] += 1
                days.setdefault(ev, set()).add(s.day)
            elif ev not in known:
                other += 1
    return {"rows": {e: rows.get(e, 0) for e in FAULTS}, "sessions": {e: len(days.get(e, ())) for e in FAULTS},
            "other_events": other}


def decision_marks(sess: Sequence[Session]) -> dict[str, int]:
    """Totals over the decision summaries: marks asked, marks where only the spread blocked, would-be signals."""
    tot = Counter[str]()
    n = 0
    for s in sess:
        for r in s.rows:
            if r.get("event") == "decision_summary":
                n += 1
                for k in ("asked", "marks", "spread_only_marks", "would_signals"):
                    v = r.get(k)
                    tot[k] += len(v) if isinstance(v, list) else int(v) if isinstance(v, int) else 0
    return {"summaries": n, **{k: tot.get(k, 0) for k in ("asked", "marks", "spread_only_marks", "would_signals")}}


def aggregate(sess: Sequence[Session], fs: Sequence[Fill], seed: int = 48, n_boot: int = 10_000) -> dict[str, Any]:
    """Everything EXP-0048 reports. Aggregates only: no per-trade field."""
    armed = [s for s in sess if s.rows and s.rows[0].get("event") == "armed"]
    ent = [entry_shortfall_R(f) for f in fs]
    by_kind: dict[str, Any] = {}
    for k in EXIT_KINDS:
        legs = [f for f in fs if f.reason == k]
        vals = [x for x in (exit_shortfall_R(f) for f in legs) if x is not None]
        by_kind[k] = {"trades": len(legs), "measured": len(vals),
                      "estimated_price_excluded": sum(1 for f in legs if f.estimated),
                      "shortfall_R": summary(vals, seed + 1 + EXIT_KINDS.index(k), n_boot) if vals else {"n": 0}}
    other = [f for f in fs if f.reason not in EXIT_KINDS]
    measured_total = [entry_shortfall_R(f) + x for f in fs if (x := exit_shortfall_R(f)) is not None]
    inc_trades = {k: sum(1 for f in fs if f.incidents.get(k)) for k in INCIDENTS}
    inc_rows = {k: sum(f.incidents.get(k, 0) for f in fs) for k in INCIDENTS}
    kinds: Counter[str] = Counter()
    for f in fs:
        kinds.update(f.exit_failed_kinds)
    return {
        "sessions": {"armed": len(armed), "unarmed_rows": len(sess) - len(armed),
                     "entries_off": sum(1 for s in armed if s.rows[0].get("entries_off")),
                     "kill_at_arm": sum(1 for s in armed if s.rows[0].get("kill")),
                     "with_trade": len(fs)},
        "trades": len(fs),
        "entry": {"shortfall_vs_model_R": summary(ent, seed, n_boot),
                  "slip_vs_trigger_bps": summary([bps(f) for f in fs], seed + 10, n_boot),
                  "model_slip_R": summary([f.slip_ps / f.r_ps for f in fs], seed + 11, n_boot),
                  "filled_within_collar": sum(1 for f in fs if f.entry <= f.limit + 1e-9),
                  "gap_term_measurable": False},
        "exit_by_kind": by_kind,
        "exit_other_reason": len(other),
        "measured_round_trip_shortfall_R": summary(measured_total, seed + 20, n_boot),
        "latency_s": {"signal_bar_close_to_entry_placed": summary(
                          [f.placed_latency_s for f in fs if f.placed_latency_s is not None], seed + 30, n_boot),
                      "entry_placed_to_fill_journaled": summary(
                          [f.fill_latency_s for f in fs if f.fill_latency_s is not None], seed + 31, n_boot),
                      "flatten_time_to_close_journaled": summary(
                          [f.flatten_delay_s for f in fs if f.flatten_delay_s is not None], seed + 32, n_boot)},
        "incidents": {"trades_with": inc_trades, "rows": inc_rows,
                      "trades_with_any_exit_incident": sum(
                          1 for f in fs if any(f.incidents.get(k) for k in INCIDENTS if k.startswith("exit"))),
                      "exit_failed_kinds": {k: kinds.get(k, 0) for k in ("sell_exceeds_available", "other")}},
        "blockers": blockers(sess),
        "faults": faults(sess),
        "decision_marks": decision_marks(sess),
    }


def reconcile(fs: Sequence[Fill], sess: Sequence[Session], want: Mapping[str, Any]) -> list[str]:
    """Differences from the registered published aggregate (trades, total R to 2 dp, armed sessions)."""
    got = {"trades": len(fs), "total_R": round(sum(f.R_closed for f in fs), 2),
           "armed_sessions": sum(1 for s in sess if s.rows and s.rows[0].get("event") == "armed")}
    miss = []
    for k, v in want.items():
        if k == "total_R":
            if abs(float(got[k]) - float(v)) > 0.005 + 1e-9:
                miss.append(f"{k}: snapshot {got[k]} vs registered {v}")
        elif got.get(k) != v:
            miss.append(f"{k}: snapshot {got.get(k)} vs registered {v}")
    return miss
