"""The options clone's review and verdict (DEC-0030, section 6). Pure: rows in, figures out; no I/O.

A row is a `trade_closed` event of the clone's journal. Only rows with `counts` true (closed trades, not trades a
hand sale made `unresolved`) enter the figures; the others are counted apart. The unit is return on premium from
fills, after fees. The verdict's range resamples whole sessions: trades on one day share that day's market.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

from wt.backtest.stats import bootstrap_ci

MIN_TRADES, MIN_SESSIONS = 30, 20
SETUPS = ("retest", "rejection")


def session_of(row: Mapping[str, Any]) -> str:
    return str(row.get("trade_id", ""))[:10]


def _f(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def figures(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Every reported figure for one set of trades (one setup, or all)."""
    use = [r for r in rows if r.get("counts") and _f(r.get("rop")) is not None and _f(r.get("pnl")) is not None]
    out: dict[str, Any] = {"trades": len(use), "unresolved": sum(1 for r in rows if r.get("state") == "unresolved"),
                           "sessions": len({session_of(r) for r in use})}
    if not use:
        return out
    rop = np.array([_f(r["rop"]) for r in use], dtype=float)
    pnl = np.array([_f(r["pnl"]) for r in use], dtype=float)
    days = [session_of(r) for r in use]
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    eq = np.cumsum(pnl)
    peak = np.maximum.accumulate(np.r_[0.0, eq])[1:]
    streak = best = 0
    for x in pnl:
        streak = streak + 1 if x <= 0 else 0
        best = max(best, streak)
    captured = []
    for r in use:
        fill, ex, top = _f(r.get("fill")), _f(r.get("exit_fill")), _f(r.get("best_bid"))
        if fill is not None and ex is not None and top is not None and top > fill:
            captured.append((ex - fill) / (top - fill))
    half = len(rop) // 2
    out.update({
        "win_rate": round(float((pnl > 0).mean()), 4),
        "mean_rop": round(float(rop.mean()), 4),
        "ci_session": [round(x, 4) for x in bootstrap_ci(rop, block="day", days=days)] if len(set(days)) > 1 else None,
        "ci_trade": [round(x, 4) for x in bootstrap_ci(rop)] if len(rop) > 1 else None,
        "first_half_mean": round(float(rop[:half].mean()), 4) if half else None,
        "second_half_mean": round(float(rop[half:].mean()), 4) if half else None,
        "profit_factor": round(float(wins.sum() / -losses.sum()), 3) if losses.sum() < 0 else None,
        "expectancy_usd": round(float(pnl.mean()), 2),
        "total_usd": round(float(pnl.sum()), 2),
        "max_drawdown_usd": round(float((eq - peak).min()), 2),
        "longest_losing_streak": best,
        "mfe_captured": round(float(np.mean(captured)), 3) if captured else None,
        "exits": {k: sum(1 for r in use if r.get("exit_reason") == k) for k in sorted({str(r.get("exit_reason")) for r in use})},
    })
    return out


def verdict(fig: Mapping[str, Any]) -> tuple[str, list[str]]:
    """`none` (too few trades or sessions), `falsified` or `passes`, with the reasons (DEC-0030, section 6)."""
    if fig.get("trades", 0) < MIN_TRADES or fig.get("sessions", 0) < MIN_SESSIONS:
        return "none", [f"{fig.get('trades', 0)} of {MIN_TRADES} trades, {fig.get('sessions', 0)} of {MIN_SESSIONS} sessions"]
    why = []
    ci = fig.get("ci_session") or [0.0, 0.0]
    if ci[0] <= 0:
        why.append("range-by-session-not-above-zero")
    if (fig.get("first_half_mean") or 0.0) <= 0:
        why.append("first-half-not-above-zero")
    if (fig.get("second_half_mean") or 0.0) <= 0:
        why.append("second-half-not-above-zero")
    return ("falsified", why) if why else ("passes", ["range by session above zero", "both halves above zero"])


def review(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Figures and the verdict for each setup and for all trades together."""
    out: dict[str, Any] = {}
    for name in (*SETUPS, "all"):
        part = [r for r in rows if name == "all" or r.get("setup") == name]
        fig = figures(part)
        v, why = verdict(fig)
        out[name] = {**fig, "verdict": v, "why": why}
    return out


def day_line(decisions: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per name for one session: bars looked at, setups formed, refusals by gate, entries."""
    out: dict[str, dict[str, Any]] = {}
    for d in decisions:
        root = str(d.get("root"))
        n = out.setdefault(root, {"bars": 0, "setups": 0, "entered": 0, "refused_by": {}})
        n["bars"] += 1
        for s in d.get("signals") or []:
            if s.get("already"):
                continue
            n["setups"] += 1
            for g, v in (s.get("gates") or {}).items():
                if isinstance(v, Mapping) and not v.get("ok"):
                    n["refused_by"][g] = n["refused_by"].get(g, 0) + 1
        n["entered"] += d.get("action") == "entered"
    return out
