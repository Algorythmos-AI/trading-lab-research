"""Strategy B's performance, computed once here and only rendered by the dashboard (plan v4.2, Wave 1a).

Honest at small samples, because B trades at most once a day and for weeks will have few trades:
  * win rate, averages and expectancy are always shown with n;
  * the confidence interval, the profit factor and the Sharpe ratio are suppressed (None, sample_ok=False)
    below thresholds.MIN_TRADES_STATS trades (Sharpe also needs MIN_SESSIONS_SHARPE sessions);
  * a profit factor with no losing trade is infinite: reported as None with pf_no_losses=True;
  * trades whose exit price was estimated (no fill found) are excluded from the statistics;
  * the CI is a bootstrap by trading day (with one trade a day, the same as by trade), seeded from the data so it
    doesn't jitter between publishes;
  * a 0 R trade is breakeven: counted in n and the expectancy, but neither a win nor a loss;
  * Sharpe uses G2's clean sessions only (armed, completed, KILL off, no refusal or incident), a clean session
    without a trade counting 0 R, and drops any session whose trade had an estimated exit;
  * the maximum drawdown is measured on every trade, before the published curve is thinned.
Equity is the virtual account's (US$600 start, the account B is sized on), never the broker account's.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from collections import defaultdict
from collections.abc import Collection, Sequence
from typing import Any

from wt.ops import thresholds


def _r(row: dict[str, Any]) -> float | None:
    v = row.get("R")
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) else None


def usable(trades: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """B's own closed trades with a real exit price and an R."""
    return [t for t in trades if t.get("origin", "entry") == "entry" and not t.get("exit_price_estimated")
            and _r(t) is not None]


def bootstrap_ci(rs: Sequence[float], n_boot: int = 2000, alpha: float = 0.05) -> tuple[float, float]:
    seed = int(hashlib.sha256(json.dumps([round(x, 6) for x in rs]).encode()).hexdigest()[:12], 16)
    rng = random.Random(seed)
    means = sorted(sum(rng.choice(rs) for _ in rs) / len(rs) for _ in range(n_boot))
    lo, hi = means[int(n_boot * alpha / 2)], means[int(n_boot * (1 - alpha / 2)) - 1]
    return round(lo, 4), round(hi, 4)


def daily_series(trades: Sequence[dict[str, Any]], session_days: Collection[str]) -> list[float]:
    """R per clean session (0 when it had no trade), leaving out sessions whose trade had an estimated exit."""
    by_day: dict[str, float] = defaultdict(float)
    for t in usable(trades):
        by_day[str(t.get("day") or "")[:10]] += _r(t) or 0.0
    estimated = {str(t.get("day") or "")[:10] for t in trades if t.get("exit_price_estimated")}
    return [by_day.get(d, 0.0) for d in sorted(set(session_days) - estimated)]


def stats(trades: Sequence[dict[str, Any]], sessions: int = 0,
          session_days: Collection[str] | None = None) -> dict[str, Any]:
    """`session_days` (G2's clean sessions) drives the Sharpe series; without it, `sessions` pads the trades with
    0 R days (kept for callers that only have a count)."""
    ts = usable(trades)
    rs = [_r(t) or 0.0 for t in ts]
    n = len(rs)
    wins, losses = [x for x in rs if x > 0], [x for x in rs if x < 0]
    ok = n >= thresholds.MIN_TRADES_STATS
    out: dict[str, Any] = {
        "n": n, "excluded_estimated": sum(1 for t in trades if t.get("exit_price_estimated")),
        "win_rate": round(len(wins) / n, 4) if n else None,
        "avg_win_r": round(sum(wins) / len(wins), 4) if wins else None,
        "avg_loss_r": round(sum(losses) / len(losses), 4) if losses else None,
        "expectancy_r": round(sum(rs) / n, 4) if n else None,
        "total_r": round(sum(rs), 4), "sample_ok": ok,
        "ci_low": None, "ci_high": None, "profit_factor": None, "pf_no_losses": False, "sharpe": None,
    }
    if ok:
        out["ci_low"], out["ci_high"] = bootstrap_ci(rs)
        gross_loss = -sum(x for x in rs if x < 0)
        if gross_loss > 0:
            out["profit_factor"] = round(sum(wins) / gross_loss, 3)
        else:
            out["pf_no_losses"] = True
        daily = daily_series(trades, session_days) if session_days is not None \
            else rs + [0.0] * max(0, sessions - n)              # eligible sessions without a trade count as 0 R
        if len(daily) >= thresholds.MIN_SESSIONS_SHARPE:
            mean = sum(daily) / len(daily)
            sd = math.sqrt(sum((x - mean) ** 2 for x in daily) / (len(daily) - 1)) if len(daily) > 1 else 0.0
            out["sharpe"] = round(mean / sd * math.sqrt(252), 3) if sd > 0 else None
    return out


def curve(trades: Sequence[dict[str, Any]], start_equity: float = 600.0, max_points: int = 400) -> list[dict[str, Any]]:
    """Per closed trade: equity % since start (virtual account), cumulative R, drawdown in % and in R."""
    out: list[dict[str, Any]] = []
    cum_r, peak_r, peak_eq = 0.0, 0.0, start_equity
    for t in usable(trades):
        cum_r += _r(t) or 0.0
        raw = t.get("virtual")
        va: dict[str, Any] = raw if isinstance(raw, dict) else {}
        eq = float(va.get("equity", peak_eq if not out else start_equity * (1 + out[-1]["equity_pct"] / 100)))
        peak_r, peak_eq = max(peak_r, cum_r), max(peak_eq, eq)
        out.append({"date": str(t.get("day") or "")[:10], "equity_pct": round((eq / start_equity - 1) * 100, 3),
                    "cum_r": round(cum_r, 3), "dd_pct": round((eq / peak_eq - 1) * 100, 3),
                    "dd_r": round(cum_r - peak_r, 3)})
    return thin(out, max_points)


def thin(points: list[dict[str, Any]], max_points: int = 400) -> list[dict[str, Any]]:
    """Keep the ends and thin the middle evenly (for display; measure drawdowns before thinning)."""
    if len(points) <= max_points:
        return points
    step = len(points) / max_points
    return [points[int(i * step)] for i in range(max_points - 1)] + [points[-1]]


def histogram(trades: Sequence[dict[str, Any]], edges: Sequence[float] = (-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3)) \
        -> list[dict[str, Any]]:
    rs = [_r(t) or 0.0 for t in usable(trades)]
    bins = [f"< {edges[0]}"] + [f"{a} to {b}" for a, b in zip(edges, edges[1:], strict=False)] + [f">= {edges[-1]}"]
    counts = [0] * len(bins)
    for x in rs:
        i = sum(1 for e in edges if x >= e)
        counts[i] += 1
    return [{"bin": b, "count": c} for b, c in zip(bins, counts, strict=True)]


def max_drawdown(points: Sequence[dict[str, Any]]) -> tuple[float | None, float | None]:
    if not points:
        return None, None
    return min(p["dd_pct"] for p in points), min(p["dd_r"] for p in points)
