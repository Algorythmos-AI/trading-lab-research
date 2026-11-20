"""Why names left the SPEC-0001 funnel, added up over many sessions: counts and nothing else.

`wt.scanner.explain` describes one session's funnel run. This module reads that description for each session's pool
and sums it, with three splits made explicit that a single total hides:

  float      `float_unknown` (no share count on record) apart from `float` (a known count that is too large);
  catalyst   a name with no qualifying catalyst is `catalyst_no_headline` when the pool recorded no headline for it
             at all (`headlines_n == 0`) and `catalyst_none_qualifying` when it had headlines and none qualified;
             `catalyst_excluded` stays as it is. A category or a headline never comes out of here: three buckets,
             plus `catalyst_headlines_unknown` for a pool with no headline count (none exists today);
  chart      `history` (fewer than 200 daily bars) apart from `trend`, beside `window`, `pm_consolidation` and
             `suspect_split` (wt.scanner.explain.chart_reasons).

A session in which every kept name has `headlines_n == 0` is flagged as a data gap, not as a finding: the news
endpoint returns nothing before NEWS_START, so a pool built for an older date has empty catalyst fields and every
one of its names fails the catalyst filter for that reason alone. The totals are given twice, over every session
and over the sessions that are not a data gap.

Only the columns in USED_COLUMNS are read. Each is known at the 09:25 decision: the snapshot price and gap, the
pre-market volume, the float as of that day, the news up to 09:25 and the daily history before the session. No
minute bar after 09:25, no later price and no result is read, and none is written: a count is free to report, but a
result (R, profit, win rate) split by any of these groups is a new trial and needs its own experiment record.
"""
from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping
from typing import Any

from wt.scanner.explain import STEPS, explain, from_pool, pool_musts, public

NEWS_START = "2026-04-28"          # the first date the news endpoint answers for; older pools have no headlines
FUNNEL_COLUMNS = ("symbol", "price_0925", "gap_pct", "pm_volume", "rvol_pm", "float_shares", "catalyst_status",
                  "catalyst_category", "catalyst_score", "former_runner", "chart_ok", "pm_pattern")   # explain.from_pool
CHART_COLUMNS = ("trend_ok", "window_ok", "pm_consolidation", "suspect_split", "hist_bars")           # explain.pool_musts
USED_COLUMNS = (*FUNNEL_COLUMNS, *CHART_COLUMNS, "headlines_n")
REASONS = ("price", "gap", "float", "float_unknown", "pm_volume", "rvol", "catalyst_excluded",
           "catalyst_no_headline", "catalyst_none_qualifying", "catalyst_headlines_unknown")
CHART = ("history", "trend", "window", "pm_consolidation", "suspect_split", "unknown")
SUMMED = ("counts", "failed_by_reason", "sole_reason", "chart_fail")


def _headlines(pool: Any) -> dict[str, int | None]:
    """symbol -> the number of headlines the pool recorded for it; None where the count is not a number."""
    out: dict[str, int | None] = {}
    for sym, n in zip(pool["symbol"].tolist(), pool["headlines_n"].tolist(), strict=True):
        ok = isinstance(n, int | float) and not isinstance(n, bool) and math.isfinite(n)
        out[str(sym)] = int(n) if ok else None
    return out


def _code(reason: str, headlines: int | None, known: bool) -> str:
    """A funnel reason as one of REASONS: the category suffix is dropped and `catalyst_missing` is split by whether
    the name had any headline."""
    code = public(reason)
    if code != "catalyst_missing":
        return code
    if not known or headlines is None:
        return "catalyst_headlines_unknown"
    return "catalyst_no_headline" if headlines == 0 else "catalyst_none_qualifying"


def _filled(keys: tuple[str, ...], seen: Mapping[str, int]) -> dict[str, int]:
    """Every expected key, in order, then any code the funnel added since (so a new reason is counted, not lost)."""
    return {**{k: int(seen.get(k, 0)) for k in keys}, **{k: int(v) for k, v in sorted(seen.items()) if k not in keys}}


def session(pool: Any, spec: dict[str, Any]) -> dict[str, Any]:
    """One session's tally from its pool frame (pool.build_day's candidates). Ints and four flags; no name."""
    cols = [c for c in USED_COLUMNS if c in getattr(pool, "columns", ())]
    p = pool[cols]                                             # nothing outside USED_COLUMNS is read below this line
    heads_known, history_known = "headlines_n" in cols, "hist_bars" in cols
    out: dict[str, Any] = {
        "counts": dict.fromkeys(STEPS, 0), "failed_by_reason": _filled(REASONS, {}), "sole_reason": _filled(REASONS, {}),
        "chart_fail": _filled(CHART, {}), "kept_no_headline": 0, "has_tier2": False, "data_gap": False,
        "headlines_known": heads_known, "history_known": history_known}
    if not len(p):
        return out
    lacking = [c for c in FUNNEL_COLUMNS if c not in cols]
    if lacking:
        raise ValueError(f"funnel_reasons: the pool lacks {', '.join(lacking)}")
    e = explain(from_pool(p), spec, pool_musts(p))
    heads = _headlines(p) if heads_known else {}
    failed: Counter[str] = Counter()
    sole: Counter[str] = Counter()
    for r in e.rows:
        if r.reached != "kept":
            continue
        codes = list(dict.fromkeys(_code(x, heads.get(r.symbol), heads_known) for x in r.reasons))
        failed.update(codes)
        if len(r.reasons) == 1:
            sole[codes[0]] += 1
    chart = Counter({("unknown" if k == "chart" else k): v for k, v in e.chart_fail.items()})
    none = sum(1 for r in e.rows if heads.get(r.symbol) == 0)
    out.update(counts={k: int(e.counts[k]) for k in STEPS}, failed_by_reason=_filled(REASONS, failed),
               sole_reason=_filled(REASONS, sole), chart_fail=_filled(CHART, chart), kept_no_headline=none,
               has_tier2=e.counts["tier2"] > 0, data_gap=heads_known and none == len(e.rows))
    return out


def _sum(days: list[Mapping[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {"sessions": len(days)}
    for key, keys in zip(SUMMED, (STEPS, REASONS, REASONS, CHART), strict=True):
        acc: Counter[str] = Counter()
        order: dict[str, None] = dict.fromkeys(keys)
        for d in days:
            for k, v in d[key].items():
                acc[k] += int(v)
                order.setdefault(k)
        out[key] = {k: acc[k] for k in order}
    out["kept_no_headline"] = sum(int(d["kept_no_headline"]) for d in days)
    return out


def total(days: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Many sessions added up. `days`: ISO date -> that session's tally. A data-gap session is counted, flagged and
    left out of `excluding_data_gap`; an empty session (no kept name) is neither a gap nor a finding."""
    dates = sorted(days)
    gap = [d for d in dates if days[d]["data_gap"]]
    return {
        "sessions": len(dates), "first": dates[0] if dates else None, "last": dates[-1] if dates else None,
        "sessions_empty": sum(1 for d in dates if not days[d]["counts"]["kept"]),
        "sessions_with_tier2": sum(1 for d in dates if days[d]["has_tier2"]),
        "sessions_data_gap": len(gap),
        "data_gap_before_news_start": sum(1 for d in gap if d < NEWS_START),
        "data_gap_on_or_after_news_start": sum(1 for d in gap if d >= NEWS_START),
        "sessions_headlines_unknown": sum(1 for d in dates if days[d]["counts"]["kept"] and not days[d]["headlines_known"]),
        "sessions_history_unknown": sum(1 for d in dates if days[d]["counts"]["kept"] and not days[d]["history_known"]),
        "news_start": NEWS_START,
        "all": _sum([days[d] for d in dates]),
        "excluding_data_gap": _sum([days[d] for d in dates if not days[d]["data_gap"]]),
    }
