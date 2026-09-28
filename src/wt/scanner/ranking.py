"""Pre-market ranking engine (knowledge/ranking_engine_spec.md). Pure: features in -> ranked list out."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from wt.core.config import load_yaml


@dataclass
class Candidate:
    symbol: str
    price: float
    gap_pct: float                 # percent, e.g. 12.5
    rvol_tod: float                # pre-market volume / median pre-market volume (prior N sessions)
    pm_dollar_vol: float
    spread_pct: float | None       # percent of mid; None if unknown
    spread_abs: float | None
    float_shares: float | None     # point-in-time shares outstanding proxy
    pm_volume: float
    catalyst_type: str | None
    catalyst_score: float          # -1 = excluded type
    halted: bool = False
    headlines: list[str] = field(default_factory=list)


def _tier(value: float | None, tiers: list[list[float]]) -> float:
    if value is None:
        return 0.0
    for limit, score in tiers:
        if value <= limit:
            return score
    return 0.0


def hard_filter(c: Candidate, cfg: dict) -> list[str]:
    f = cfg["hard_filters"]
    why = []
    if not (f["price_min"] <= c.price <= f["price_max"]):
        why.append("price")
    if c.gap_pct < f["gap_min_pct"]:
        why.append("gap")
    if c.rvol_tod < f["rvol_tod_min"]:
        why.append("rvol")
    if c.pm_dollar_vol < f["pm_dollar_vol_min"]:
        why.append("liquidity")
    if c.spread_pct is not None and c.spread_pct > f["spread_max_pct"]:
        why.append("spread")
    if c.price < 5 and c.spread_abs is not None and c.spread_abs > f["spread_max_abs_below_5"]:
        why.append("spread_abs")
    if c.float_shares is not None and c.float_shares > f["float_max"]:
        why.append("float")
    if c.catalyst_score < 0 or (c.catalyst_type in f["exclude_catalysts"]):
        why.append(f"catalyst:{c.catalyst_type}")
    if c.halted:
        why.append("halted")
    return why


def subscores(c: Candidate, cfg: dict) -> dict[str, float]:
    price = next((s for lo, hi, s in cfg["price_tiers"] if lo <= c.price <= hi), 0.0)
    return {
        "catalyst": max(0.0, c.catalyst_score),
        "rvol": min(1.0, math.log(max(c.rvol_tod, 1.0)) / math.log(10)),
        "float": _tier(c.float_shares, cfg["float_tiers"]),
        "gap": min(1.0, math.log1p(max(c.gap_pct, 0) / 100) / math.log1p(0.5)),
        "price": price,
        "liquidity": min(1.0, max(0.0, math.log10(max(c.pm_dollar_vol, 1) / 1e6) / math.log10(20))),
        "spread": 0.5 if c.spread_pct is None else max(0.0, 1 - c.spread_pct / cfg["hard_filters"]["spread_max_pct"]),
        "float_rotation": 0.0 if not c.float_shares else min(1.0, (c.pm_volume / c.float_shares) / 0.10),
    }


def rank(cands: list[Candidate], cfg: dict | None = None) -> tuple[list[dict], list[dict]]:
    """Returns (ranked passing candidates with scores, dropped candidates with reasons). Deterministic."""
    cfg = cfg or load_yaml("ranking.yaml")
    passed, dropped = [], []
    for c in cands:
        why = hard_filter(c, cfg)
        if why:
            dropped.append({"symbol": c.symbol, "reasons": why})
            continue
        subs = subscores(c, cfg)
        score = sum(cfg["weights"][k] * v for k, v in subs.items())
        passed.append({"symbol": c.symbol, "score": round(score, 3), "subscores": {k: round(v, 3) for k, v in subs.items()},
                       "features": {k: getattr(c, k) for k in ("price", "gap_pct", "rvol_tod", "pm_dollar_vol", "spread_pct",
                                                               "float_shares", "catalyst_type")},
                       "headlines": c.headlines})
    passed.sort(key=lambda d: (-d["score"], -d["features"]["rvol_tod"], -d["features"]["gap_pct"], d["symbol"]))
    for i, d in enumerate(passed, 1):
        d["rank"] = i
    return passed[: cfg["top_n"]], dropped + [{"symbol": d["symbol"], "reasons": ["below_top_n"]} for d in passed[cfg["top_n"]:]]


# ---- SPEC-0001 funnel (Set F). The G1 `rank()` above stays frozen for the baseline (Set P) ----------------------

@dataclass
class SpecCandidate:
    symbol: str
    price: float                   # last print <= 09:25 (causal snapshot)
    gap_pct: float                 # vs split-adjusted prior close
    pm_volume: float               # shares 04:00-09:24
    rvol_pm: float                 # pre-market volume / median same-window volume, prior 20 sessions
    float_shares: float | None     # point-in-time SEC shares outstanding (>= float)
    catalyst_status: str           # qualifying | excluded | non_qualifying (catalyst.best_catalyst_spec)
    catalyst_category: str
    catalyst_score: float
    former_runner: bool = False
    chart_ok: bool = False         # Tier-2 musts: EMAs, window, trigger, PM consolidation, no suspect split
    pm_pattern: bool = False       # an active pre-market flag / flat top (Tier-3 preference)
    tags: dict = field(default_factory=dict)


def hard_filter_spec(c: SpecCandidate, scanner: dict) -> list[str]:
    """SCN-GAP-01, 03, 05, 07, 08, 09, 10, 11 -> list of failed rules (empty = passes Tier-1 filters)."""
    why = []
    lo, hi = scanner["price_usd"]
    if not (lo <= c.price <= hi):
        why.append("price")
    if not c.gap_pct > scanner["gap_min_pct_exclusive"]:
        why.append("gap")
    if c.float_shares is None and scanner.get("float_must_be_known", True):
        why.append("float_unknown")
    elif c.float_shares is not None and not c.float_shares < scanner["float_max_shares_exclusive"]:
        why.append("float")
    if c.pm_volume < scanner["pm_volume_min_shares"]:
        why.append("pm_volume")
    if c.rvol_pm < scanner["rvol_min"]:
        why.append("rvol")
    if c.catalyst_status == "excluded":
        why.append(f"catalyst_excluded:{c.catalyst_category}")
    elif c.catalyst_status != "qualifying":
        why.append(f"catalyst_missing:{c.catalyst_category}")
    return why


def spec_subscores(c: SpecCandidate, funnel: dict) -> dict[str, float]:
    sc = funnel["subscores"]
    return {
        "gap": min(1.0, math.log1p(max(c.gap_pct, 0) / 100) / math.log1p(sc["gap"]["saturates_at_pct"] / 100)),
        "rvol": min(1.0, math.log(max(c.rvol_pm, 1.0)) / math.log(sc["rvol"]["cap_at"])),
        "low_float": _tier(c.float_shares, sc["low_float"]["tiers"]),
        "catalyst": float(sc["catalyst"].get(c.catalyst_category, 0.0)),
        "former_runner": 1.0 if c.former_runner else 0.0,
    }


def spec_score(c: SpecCandidate, funnel: dict) -> float:
    subs = spec_subscores(c, funnel)
    return sum(funnel["weights"][k] * v for k, v in subs.items())


def funnel(cands: list[SpecCandidate], spec: dict) -> dict:
    """FUN-01..06: Tier 1 = hard filters, top `tier1_max` by score. Tier 2 = Tier-1 names passing the chart
    musts, ordered preferred price band first, then score / RVOL / gap / symbol (D18); top `tier2_max`.
    Tier 3 = the first Tier-2 name with an active pre-market pattern, else rank 1."""
    scanner, fcfg = spec["scanners"]["pre_market_gap"], spec["funnel"]
    plo, phi = scanner["preferred_price_usd"]
    passed, dropped = [], []
    for c in cands:
        why = hard_filter_spec(c, scanner)
        (dropped if why else passed).append((c, why))
    scored = sorted(((spec_score(c, fcfg), c) for c, _ in passed),
                    key=lambda x: (-x[0], -x[1].rvol_pm, -x[1].gap_pct, x[1].symbol))
    tier1 = scored[: fcfg["tier1_max"]]
    t2_pool = [(s, c) for s, c in tier1 if c.chart_ok]
    t2_pool.sort(key=lambda x: (0 if plo <= x[1].price <= phi else 1, -x[0], -x[1].rvol_pm, -x[1].gap_pct, x[1].symbol))
    tier2 = t2_pool[: fcfg["tier2_max"]]
    primary = next((c.symbol for _, c in tier2 if c.pm_pattern), tier2[0][1].symbol if tier2 else None)
    return {"tier1": [{"symbol": c.symbol, "score": round(s, 4)} for s, c in tier1],
            "tier2": [{"symbol": c.symbol, "score": round(s, 4), "rank": i + 1, "primary": c.symbol == primary}
                      for i, (s, c) in enumerate(tier2)],
            "primary": primary,
            "dropped": [{"symbol": c.symbol, "reasons": why} for c, why in dropped]}
