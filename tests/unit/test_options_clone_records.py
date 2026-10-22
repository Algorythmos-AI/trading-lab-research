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
    setups_ = [h for h in HYPOTHESES if h["evidence"] == {"decision": "DEC-0030"}]
    assert [h["id"] for h in setups_] == ["HYP-0029", "HYP-0030"]
    assert [h["rule"] for h in setups_] == ["retest", "rejection"] == list(CONFIG["setups"])
    for h in HYPOTHESES:
        assert h["family"] == "O" and h["status"] == "pre-registered"
        assert "by session" in h["falsified_if"] and "30 trades" in h["falsified_if"]
        assert h["config"] == "config/options_clone.yaml"
    for h in setups_:
        assert h["id"] in DECISION


def test_the_nearest_expiry_rule_is_recorded_as_one_new_trial_before_its_first_trade():
    rec = (ROOT / "research" / "decisions" / "DEC-0034-options-clone-nearest-expiry.md").read_text()
    (h,) = [h for h in HYPOTHESES if h["id"] == "HYP-0031"]
    assert h["evidence"] == {"decision": "DEC-0034"} and h["rule"] == "nearest" and h["trial"] == "OC-NEAREST"
    assert "release containing DEC-0034" in h["since"] and "15:10" in h["statement"]
    assert "Written before any paper result of the new trial exists" in rec and "from 14 to **15**" in rec
    assert (ROOT / "research" / "experiments" / "EXP-0026-options-clone-nearest-expiry" / "README.md").exists()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-22\.\*\*", rec) and family_trial_count("O") == 15
    assert CONFIG["names"]["expiry"] == "nearest" and CONFIG["names"]["nearest_within_days"] == 7
    assert "same_day_expiry_only" not in CONFIG["names"]


def test_the_record_and_the_registry_agree():
    assert family_trial_count("O") == 15                                     # 14 + HYP-0031 (DEC-0034)
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


def test_the_dry_run_is_registered_before_it_runs_and_adds_no_trial():
    rec = (ROOT / "research" / "decisions" / "DEC-0031-options-clone-dry-run.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-20\.\*\*", rec) and "no result of it has" in rec
    assert "family O stays at 14" in rec and family_trial_count("O") == 15    # DEC-0034 added one since
    exp = ROOT / "research" / "experiments" / "EXP-0025-options-clone-dry-run"
    assert (exp / "README.md").exists()


def test_the_tradeable_names_rule_is_recorded_and_configured():
    rec = (ROOT / "research" / "decisions" / "DEC-0032-options-clone-tradeable-names.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-20\.\*\*", rec) and "No trial is added" in rec
    assert CONFIG["names"]["top_up"] == ["SPY", "QQQ"] and CONFIG["names"]["min_names"] == 2
    assert family_trial_count("O") == 15    # DEC-0034 added HYP-0031 since


def test_the_one_level_source_rule_is_recorded():
    rec = (ROOT / "research" / "decisions" / "DEC-0033-options-clone-one-level-source.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-20\.\*\*", rec) and "No trial is added" in rec
    assert family_trial_count("O") == 15    # DEC-0034 added HYP-0031 since
