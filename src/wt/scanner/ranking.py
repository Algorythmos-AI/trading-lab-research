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
