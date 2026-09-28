"""Headline -> catalyst type classifier (config/catalysts.yaml). Pure function."""
from __future__ import annotations

from functools import lru_cache

from wt.core.config import load_yaml


@lru_cache(maxsize=1)
def _cfg() -> dict:
    return load_yaml("catalysts.yaml")


def classify(headline: str) -> tuple[str | None, float]:
    """Return (type, score). Exclusion types return score -1 (hard filter)."""
    h = f" {headline.lower()} "
    cfg = _cfg()
    for typ, kws in cfg["exclude"].items():
        if any(k in h for k in kws):
            return typ, -1.0
    for typ, spec in cfg["types"].items():
        if any(k in h for k in spec["kw"]):
            return typ, float(spec["score"])
    return None, 0.0


def best_catalyst(headlines: list[str], former_runner: bool) -> tuple[str | None, float, list[str]]:
    """Best (highest-score) catalyst among headlines; any exclusion wins (returns score -1)."""
    best: tuple[str | None, float] = (None, 0.0)
    for hl in headlines:
        typ, sc = classify(hl)
        if sc < 0:
            return typ, -1.0, [hl]
        if sc > best[1]:
            best = (typ, sc)
    if best[1] == 0 and former_runner:
        return "former_runner", float(_cfg()["former_runner_score"]), []
    return best[0], best[1], headlines[:3]
