"""Gap Hunter's morning selection (DEC-0068, HYP-0071): the 09:25 pool narrowed to four names and one primary.

A second rule beside the frozen funnel (`wt.scanner.ranking.funnel`), which is not touched. The frozen funnel makes
the daily-chart checks and a qualifying catalyst hard conditions; this rule keeps price, gap, float, volume, the
buyout rejection and the split check hard, and turns the chart checks and the catalyst into score terms. Every number
here is DEC-0068's "The rule (frozen)"; changing one is a new record.

It reads the pool's columns as `scripts/build_pool.py` writes them, all known at 09:25, and nothing later. It selects;
it places nothing. A reason code never carries a headline or a catalyst category.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from wt.scanner.ranking import SpecCandidate, spec_score

PRICE_USD = (1.0, 20.0)
GAP_MIN_PCT = 4.0
FLOAT_MAX_SHARES = 50_000_000
PM_VOLUME_MIN = 50_000
RVOL_MIN = 2.0
NO_HEADLINE_RVOL_MIN = 2.5
NO_HEADLINE_PM_VOLUME_MIN = 100_000
BONUS_HEADLINE_NOT_QUALIFYING = 0.05
BONUS_CHART = {"trend_ok": 0.10, "window_ok": 0.10, "pm_consolidation": 0.10}
TIER1_MAX, TIER2_MAX = 20, 4
BUYOUT = "buyout_offer"
REASONS = ("price", "gap", "float_unknown", "float", "pm_volume", "rvol", "buyout", "suspect_split",
           "no_headline_volume")
# the pool columns this rule reads: all written at 09:25 (a test holds the set)
USED_COLUMNS = ("symbol", "price_0925", "gap_pct", "pm_volume", "rvol_pm", "float_shares", "catalyst_status",
                "catalyst_category", "catalyst_score", "former_runner", "headlines_n", "trend_ok", "window_ok",
                "pm_consolidation", "suspect_split")


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _flag(v: Any) -> bool:
    return bool(v) if v is not None and v == v else False


@dataclass(frozen=True)
class Name:
    """One pool row as this rule reads it."""
    symbol: str
    price: float | None
    gap_pct: float | None
    pm_volume: float | None
    rvol_pm: float | None
    float_shares: float | None
    catalyst_status: str
    catalyst_category: str
    catalyst_score: float
    former_runner: bool
    headlines_n: int
    trend_ok: bool
    window_ok: bool
    pm_consolidation: bool
    suspect_split: bool

    @property
    def headline(self) -> str:
        """qualifying, other (a headline that does not qualify), or none."""
        if self.catalyst_status == "qualifying":
            return "qualifying"
        return "other" if self.headlines_n > 0 else "none"


def names(pool: Any) -> list[Name]:
    """The pool frame as names. A missing column reads as unknown, which fails the check that needs it."""
    out = []
    for r in pool.to_dict(orient="records") if len(pool) else []:
        out.append(Name(symbol=str(r["symbol"]), price=_num(r.get("price_0925")), gap_pct=_num(r.get("gap_pct")),
                        pm_volume=_num(r.get("pm_volume")), rvol_pm=_num(r.get("rvol_pm")),
                        float_shares=_num(r.get("float_shares")), catalyst_status=str(r.get("catalyst_status") or ""),
                        catalyst_category=str(r.get("catalyst_category") or ""),
                        catalyst_score=_num(r.get("catalyst_score")) or 0.0, former_runner=_flag(r.get("former_runner")),
                        headlines_n=int(_num(r.get("headlines_n")) or 0), trend_ok=_flag(r.get("trend_ok")),
                        window_ok=_flag(r.get("window_ok")), pm_consolidation=_flag(r.get("pm_consolidation")),
                        suspect_split=_flag(r.get("suspect_split"))))
    return out


def hard_fails(n: Name) -> list[str]:
    """Every hard filter the name fails, in REASONS' order (empty: it passes)."""
    why = []
    if n.price is None or not PRICE_USD[0] <= n.price <= PRICE_USD[1]:
        why.append("price")
    if n.gap_pct is None or n.gap_pct < GAP_MIN_PCT:
        why.append("gap")
    if n.float_shares is None:
        why.append("float_unknown")
    elif n.float_shares > FLOAT_MAX_SHARES:
        why.append("float")
    if n.pm_volume is None or n.pm_volume < PM_VOLUME_MIN:
        why.append("pm_volume")
    if n.rvol_pm is None or n.rvol_pm < RVOL_MIN:
        why.append("rvol")
    if n.catalyst_status == "excluded" and n.catalyst_category == BUYOUT:
        why.append("buyout")
    if n.suspect_split:
        why.append("suspect_split")
    if n.headline == "none" and not ((n.rvol_pm or 0.0) >= NO_HEADLINE_RVOL_MIN
                                     and (n.pm_volume or 0.0) >= NO_HEADLINE_PM_VOLUME_MIN):
        why.append("no_headline_volume")
    return why


def score_terms(n: Name, funnel_cfg: dict[str, Any]) -> dict[str, float]:
    """The score's terms: the frozen base score, then the bonuses. Call only for a name that passed the hard
    filters (its numbers are then known)."""
    base = SpecCandidate(symbol=n.symbol, price=float(n.price or 0.0), gap_pct=float(n.gap_pct or 0.0),
                         pm_volume=float(n.pm_volume or 0.0), rvol_pm=float(n.rvol_pm or 0.0),
                         float_shares=n.float_shares, catalyst_status=n.catalyst_status,
                         catalyst_category=n.catalyst_category if n.headline == "qualifying" else "",
                         catalyst_score=n.catalyst_score, former_runner=n.former_runner)
    terms = {"base": float(spec_score(base, funnel_cfg)),
             "headline_not_qualifying": BONUS_HEADLINE_NOT_QUALIFYING if n.headline == "other" else 0.0}
    for k, bonus in BONUS_CHART.items():
        terms[k] = bonus if getattr(n, k) else 0.0
    return terms


def select(pool: Any, spec: dict[str, Any]) -> dict[str, Any]:
    """Tier 1 (top 20 by score), Tier 2 (top 4) and the primary (rank 1), with what the hard filters rejected.
    Ties: higher relative volume, then larger gap, then symbol."""
    fcfg = spec["funnel"]
    rows, dropped = [], {k: 0 for k in REASONS}
    all_names = names(pool)
    if len({n.symbol for n in all_names}) != len(all_names):
        raise ValueError("gap_hunter.select: a symbol appears twice in the pool")
    for n in all_names:
        why = hard_fails(n)
        for k in why:
            dropped[k] += 1
        if not why:
            terms = score_terms(n, fcfg)
            rows.append((round(sum(terms.values()), 6), n, terms))
    rows.sort(key=lambda x: (-x[0], -(x[1].rvol_pm or 0.0), -(x[1].gap_pct or 0.0), x[1].symbol))
    tier1 = rows[:TIER1_MAX]
    tier2 = tier1[:TIER2_MAX]

    def out(i: int, s: float, n: Name, t: dict[str, float]) -> dict[str, Any]:
        return {"symbol": n.symbol, "rank": i + 1, "score": round(s, 4), "terms": {k: round(v, 4) for k, v in t.items()},
                "headline": n.headline}

    return {"kept": len(all_names), "passed": len(rows), "dropped": dropped,
            "tier1": [out(i, *r) for i, r in enumerate(tier1)], "tier2": [out(i, *r) for i, r in enumerate(tier2)],
            "primary": tier2[0][1].symbol if tier2 else None}
