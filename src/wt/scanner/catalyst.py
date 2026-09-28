"""Headline -> catalyst type classifier (config/catalysts.yaml). Pure function."""
from __future__ import annotations

import re
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


# ---- SPEC-0001 classifier (config/catalysts_spec.yaml); v1 above stays frozen for the G1 baseline ----------

QUALIFYING = ("fda_approval", "clinical_study_results", "earnings_release", "price_target_upgrade", "breaking_news")
EXCLUDED = ("buyout_offer", "unconfirmed_rumor")


@lru_cache(maxsize=1)
def _spec_cfg() -> dict:
    return load_yaml("catalysts_spec.yaml")


@lru_cache(maxsize=4096)
def _rx(pattern: str) -> re.Pattern:
    return re.compile(pattern)


def _hit(h: str, kws: list[str]) -> bool:
    """Substring match, or regex when the entry starts with 're:'."""
    return any((_rx(k[3:]).search(h) is not None) if k.startswith("re:") else (k in h) for k in kws)


def classify_spec(headline: str) -> str:
    """Headline -> one SPEC-0001 category. First matching rule wins, in the order documented in the config."""
    h = f" {headline.lower()} "
    c = _spec_cfg()

    def hit(kws) -> bool:
        return _hit(h, kws)

    if hit(c["generic_list"]) or hit(c.get("commentary", [])):
        return "none"
    for cat in ("buyout_offer", "unconfirmed_rumor", "offering_dilution", "reverse_split"):
        if hit(c[cat]):
            return cat
    if hit(c["scheduling"]) or hit(c.get("analyst_negative", [])):
        return "none"
    for cat in QUALIFYING:
        if hit(c["qualifying"][cat]["kw"]):
            return cat
    if hit(c["generic_pr"]):
        return "none"
    if hit(c["hype_only"]):
        return "hype_only"
    return "none"


def spec_score(category: str) -> float:
    q = _spec_cfg()["qualifying"]
    return float(q[category]["score"]) if category in q else 0.0


def best_catalyst_spec(headlines: list[str]) -> tuple[str, str, float, list[str]]:
    """Stock-level catalyst from its headlines -> (status, category, score, evidence headlines).

    status: 'excluded' if any headline is a buyout offer (price pinned, spec §1), or if the only
    catalyst is an unconfirmed rumour (C1); 'qualifying' if the best category is a required type;
    otherwise 'non_qualifying'.
    """
    cats = [(classify_spec(h), h) for h in headlines]
    buyouts = [h for c, h in cats if c == "buyout_offer"]
    if buyouts:
        return "excluded", "buyout_offer", -1.0, buyouts[:1]
    qual = sorted(((spec_score(c), QUALIFYING.index(c), c, h) for c, h in cats if c in QUALIFYING),
                  key=lambda x: (-x[0], x[1]))
    if qual:
        s, _, c, h = qual[0]
        return "qualifying", c, s, [h]
    rumors = [h for c, h in cats if c == "unconfirmed_rumor"]
    if rumors:
        return "excluded", "unconfirmed_rumor", -1.0, rumors[:1]
    other = next((c for c, _ in cats if c != "none"), "none")
    return "non_qualifying", other, 0.0, headlines[:1]
