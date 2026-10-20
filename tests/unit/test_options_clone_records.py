"""The options clone's records agree with its frozen configuration and the trial registry (DEC-0030)."""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from wt.research.trials import family_trial_count

ROOT = Path(__file__).resolve().parents[2]
DECISION = (ROOT / "research" / "decisions" / "DEC-0030-options-clone.md").read_text()
CONFIG = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())
RISK = yaml.safe_load((ROOT / "config" / "risk.yaml").read_text())["O"]
HYPOTHESES = [yaml.safe_load(p.read_text()) for p in sorted((ROOT / "research" / "hypotheses").glob("HYP-*-OC_*.yaml"))]


def test_two_setups_two_hypotheses_in_family_o():
    assert [h["id"] for h in HYPOTHESES] == ["HYP-0029", "HYP-0030"]
    assert [h["rule"] for h in HYPOTHESES] == ["retest", "rejection"] == list(CONFIG["setups"])
    for h in HYPOTHESES:
        assert h["family"] == "O" and h["status"] == "pre-registered" and h["evidence"] == {"decision": "DEC-0030"}
        assert h["id"] in DECISION and "by session" in h["falsified_if"] and "30 trades" in h["falsified_if"]
        assert h["config"] == "config/options_clone.yaml"


def test_the_record_and_the_registry_agree():
    assert family_trial_count("O") == 14
    assert re.search(r"from 12 to \*\*14\*\*", DECISION)
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-18\.\*\*", DECISION)


def test_the_frozen_numbers_are_the_ones_the_record_states():
    ex, day, c = CONFIG["exits"], CONFIG["day"], CONFIG["contract"]
    assert (ex["premium_stop_pct"], ex["target_pct"], ex["time_stop_min"]) == (25, 50, 5)
    assert c["max_ask"] * 100 == RISK["max_premium"] == 200
    assert RISK["max_premium"] * ex["premium_stop_pct"] / 100 == 50          # the planned loss of rule 4
    assert (RISK["day_loss_latch"], RISK["max_entries_per_day"], RISK["max_contracts"]) == (100, 5, 1)
    assert day["flatten"] < day["verify_flat"] < day["critical"] < "15:30"   # before the broker's expiry process
    assert day["first_entry"] == "10:00" and day["last_entry"] == "14:30"


def test_paper_is_the_only_trading_value_and_size_is_one():
    assert CONFIG["orders"] in ("paper", "off")
    assert "live" not in yaml.safe_dump(CONFIG).lower()
    assert CONFIG["order"]["contracts"] == RISK["max_contracts"] == RISK["max_open_positions"] == 1
