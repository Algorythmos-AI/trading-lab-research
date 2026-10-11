"""The options desk's research records agree with the engine, the rules file and the trial registry (DEC-0028)."""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

from wt.options import rules
from wt.research.trials import family_trial_count

ROOT = Path(__file__).resolve().parents[2]
RULES = json.loads((ROOT / "config" / "options_rules.json").read_text())["rules"]
DECISION = (ROOT / "research" / "decisions" / "DEC-0028-options-desk-scope-and-probation-rules.md").read_text()
HYPOTHESES = [yaml.safe_load(p.read_text()) for p in sorted((ROOT / "research" / "hypotheses").glob("HYP-*-O_*.yaml"))]


def test_each_rule_the_engine_replays_has_one_hypothesis_in_family_o():
    assert [h["rule"] for h in HYPOTHESES] == list(rules.RULES) == [r["id"] for r in RULES]
    assert len({h["id"] for h in HYPOTHESES}) == len({h["trial"] for h in HYPOTHESES}) == len(rules.RULES)
    for h in HYPOTHESES:
        assert h["family"] == "O" and h["status"] == "pre-registered" and h["evidence"] == {"decision": "DEC-0028"}
        assert h["id"] in DECISION or "HYP-0025 to HYP-0028" in DECISION
        assert "after option costs" in h["falsified_if"] and "30" in h["falsified_if"]


def test_what_was_seen_before_registration_is_what_the_page_shows_and_shows_no_edge():
    for h, r in zip(HYPOTHESES, RULES, strict=True):
        seen, shown = h["seen_before_registration"], r["backtest"]
        assert {k: seen[k] for k in ("n", "avg_r", "ci_lo", "ci_hi")} == {k: shown[k] for k in ("n", "avg_r", "ci_lo", "ci_hi")}
        assert seen["ci_lo"] < 0 < seen["ci_hi"]                 # every range straddles zero, as the record says
        assert r["status"] == "probation"                        # nothing is promoted without a decision record


def test_the_registry_counts_family_o_as_the_decision_states():
    assert family_trial_count("O") == 12
    assert re.search(r"trial count for family O is 12", DECISION)
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-11\.\*\*", DECISION)
