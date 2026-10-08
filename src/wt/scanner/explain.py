"""Why each kept name did or did not reach each tier of the SPEC-0001 funnel: counts and reasons, nothing else.

This module only describes. It calls the frozen `ranking.funnel` and reads its answer, so the tiers and the primary
here are the funnel's own by construction, and nothing in this file can change which names are selected (the
goldens in tests/unit/test_frozen_golden.py pin the funnel itself).

The steps are nested, in the order the code applies them:
    kept -> passed (every hard filter) -> tier1 (top tier1_max by score) -> chart_ok (the chart musts)
         -> tier2 (top tier2_max) -> primary
The hard filters are independent, so one name can fail several. Three tallies describe that step:
    failed_by_reason   every reason a name failed, so the tallies can sum to more than the names dropped
    sole_reason        names that failed exactly one filter: the near misses
    first_failure      the first reason in the code's order, one per name; for display only, the order means nothing
Counts are free to report. A result (R, profit, win rate) split by any of these groups is a new trial and needs its
own experiment record; nothing here computes one.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from wt.scanner.pool import SLICE_BAND
from wt.scanner.ranking import SpecCandidate, funnel

STEPS = ("kept", "passed", "tier1", "chart_ok", "tier2", "primary")
MUSTS = ("trend_ok", "window_ok", "pm_consolidation")          # each must be true; suspect_split must be false
TREND_MIN_BARS = 200                                           # CHT-01 (checklist.Trend.ok)
BAND_STEPS = ("kept", "passed", "tier1", "tier2")


def public(reason: str) -> str:
    """The reason's code without its suffix: a catalyst category comes from a headline and is never published."""
    return reason.split(":")[0]


@dataclass(frozen=True)
class Row:
    symbol: str
    price: float
    reached: str                       # the last step of STEPS this name reached
    reasons: tuple[str, ...]           # why it went no further; empty for the primary. Full codes: stays in var/


@dataclass
class Explanation:
    counts: dict[str, int]
    failed_by_reason: dict[str, int]
    sole_reason: dict[str, int]
    first_failure: dict[str, int]
    chart_fail: dict[str, int]         # among Tier 1 names that failed the chart musts, by must (non-exclusive)
    band: dict[str, int]               # the same nested counts for names priced inside SLICE_BAND
    rows: list[Row] = field(default_factory=list)

    def flat(self) -> dict[str, int]:
        """One level of plain ints, keyed for a stage file's `stats` (and the snapshot's map of numbers)."""
        lo, hi = SLICE_BAND
        out = {f"n_{k}": v for k, v in self.counts.items()}
        out.update({f"drop_{k}": v for k, v in self.failed_by_reason.items()})
        out.update({f"sole_{k}": v for k, v in self.sole_reason.items()})
        out.update({f"chart_{k}": v for k, v in self.chart_fail.items()})
        out.update({f"band{lo:g}_{hi:g}_{k}": v for k, v in self.band.items()})
        return out


def chart_reasons(must: Mapping[str, Any] | None) -> tuple[str, ...]:
    """Which chart musts a Tier 1 name failed. `must` is its pool row (trend_ok, window_ok, pm_consolidation,
    suspect_split, hist_bars); without one the answer is the bare code."""
    if not must:
        return ("chart",)
    why = []
    bars = must.get("hist_bars")
    if not must.get("trend_ok"):
        why.append("chart:history" if isinstance(bars, int | float) and bars < TREND_MIN_BARS else "chart:trend")
    why += [f"chart:{k.removesuffix('_ok')}" for k in MUSTS[1:] if not must.get(k)]
    if must.get("suspect_split"):
        why.append("chart:suspect_split")
    return tuple(why) or ("chart",)


def explain(cands: Iterable[SpecCandidate], spec: dict[str, Any],
            musts: Mapping[str, Mapping[str, Any]] | None = None) -> Explanation:
    """Describe one funnel run. `musts`: symbol -> that name's chart fields from the pool, when the caller has them."""
    cands = list(cands)
    by_sym = {c.symbol: c for c in cands}
    if len(by_sym) != len(cands):
        raise ValueError("explain: a symbol appears twice in the candidates")
    f = funnel(cands, spec)
    dropped = {d["symbol"]: tuple(d["reasons"]) for d in f["dropped"]}
    tier1 = [r["symbol"] for r in f["tier1"]]
    tier2 = [r["symbol"] for r in f["tier2"]]
    primary = f["primary"]
    in1, in2 = set(tier1), set(tier2)
    rows: list[Row] = []
    for c in cands:
        s = c.symbol
        if s in dropped:
            reached, why = "kept", dropped[s]
        elif s not in in1:
            reached, why = "passed", ("below_tier1_max",)
        elif not c.chart_ok:
            reached, why = "tier1", chart_reasons((musts or {}).get(s))
        elif s not in in2:
            reached, why = "chart_ok", ("below_tier2_max",)
        elif s != primary:
            reached, why = "tier2", ("not_primary",)
        else:
            reached, why = "primary", ()
        rows.append(Row(s, float(c.price), reached, why))
    at = Counter(r.reached for r in rows)
    counts = {step: sum(at[x] for x in STEPS[i:]) for i, step in enumerate(STEPS)}      # nested: reached this or beyond
    lo, hi = SLICE_BAND
    inband = Counter(r.reached for r in rows if lo <= r.price <= hi)
    band = {step: sum(inband[x] for x in STEPS[STEPS.index(step):]) for step in BAND_STEPS}
    hard = [r.reasons for r in rows if r.reached == "kept"]
    chart = [r.reasons for r in rows if r.reached == "tier1"]
    return Explanation(
        counts=counts,
        failed_by_reason=dict(sorted(Counter(public(x) for why in hard for x in dict.fromkeys(map(public, why))).items())),
        sole_reason=dict(sorted(Counter(public(why[0]) for why in hard if len(why) == 1).items())),
        first_failure=dict(sorted(Counter(public(why[0]) for why in hard).items())),
        chart_fail=dict(sorted(Counter(x.split(":", 1)[-1] for why in chart for x in why).items())),
        band=band, rows=rows)


def from_pool(pool: Any) -> list[SpecCandidate]:
    """A pool frame as Set F's candidates, field for field as scripts/r3_run.set_names builds them, so a record made
    from these describes the registered run (a test holds the two together)."""
    if not len(pool):
        return []
    return [SpecCandidate(symbol=r.symbol, price=r.price_0925, gap_pct=r.gap_pct, pm_volume=r.pm_volume,
                          rvol_pm=r.rvol_pm, float_shares=None if r.float_shares != r.float_shares or r.float_shares is None
                          else r.float_shares, catalyst_status=r.catalyst_status, catalyst_category=r.catalyst_category,
                          catalyst_score=r.catalyst_score, former_runner=bool(r.former_runner), chart_ok=bool(r.chart_ok),
                          pm_pattern=r.pm_pattern is not None and r.pm_pattern == r.pm_pattern)
            for r in pool.itertuples()]


def pool_musts(pool: Any) -> dict[str, dict[str, Any]]:
    """symbol -> the chart fields of a pool frame (pool.build_day's candidates), for `explain(..., musts=...)`."""
    cols = [c for c in (*MUSTS, "suspect_split", "hist_bars") if c in getattr(pool, "columns", ())]
    if not cols or not len(pool):
        return {}
    return {str(r["symbol"]): {k: (r[k].item() if hasattr(r[k], "item") else r[k]) for k in cols}
            for r in pool[["symbol", *cols]].to_dict(orient="records")}
