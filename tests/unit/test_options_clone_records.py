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
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-22\.\*\*", rec) and family_trial_count("O") == 47
    assert CONFIG["names"]["expiry"] == "nearest" and CONFIG["names"]["nearest_within_days"] == 7
    assert "same_day_expiry_only" not in CONFIG["names"]


def test_the_record_and_the_registry_agree():
    assert family_trial_count("O") == 47                                     # DEC-0041 added 14 since, DEC-0051 one, DEC-0052 one, DEC-0053 one, DEC-0054 three, DEC-0056 three, DEC-0058 three
    assert re.search(r"from 12 to \*\*14\*\*", DECISION)
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-18\.\*\*", DECISION)


def test_the_frozen_numbers_are_the_ones_the_record_states():
    ex, day, c = CONFIG["exits"], CONFIG["day"], CONFIG["contract"]
    assert (ex["premium_stop_pct"], ex["target_pct"], ex["time_stop_min"]) == (25, 50, 5)
    assert c["max_ask"] * 100 == RISK["max_premium"] == 1500                 # DEC-0039: $15.00 a share
    assert RISK["max_limit_price"] == c["max_ask"] == 15.00
    planned = RISK["max_premium"] * ex["premium_stop_pct"] / 100
    assert planned == 375                                                     # the planned loss of rule 4
    assert RISK["day_loss_latch"] == 2 * planned and RISK["day_loss_latch"] >= planned   # one full stop still fits
    assert (RISK["day_loss_latch"], RISK["week_loss_latch"], RISK["drawdown_latch"]) == (750, 2250, 3750)
    assert (RISK["max_entries_per_day"], RISK["max_contracts"]) == (5, 1)
    assert day["flatten"] < day["verify_flat"] < day["critical"] < "15:30"   # before the broker's expiry process
    assert day["first_entry"] == "10:00" and day["last_entry"] == "14:30"


def test_paper_is_the_only_trading_value_and_size_is_one():
    assert CONFIG["orders"] in ("paper", "off")
    assert "live" not in yaml.safe_dump(CONFIG).lower()
    assert CONFIG["order"]["contracts"] == RISK["max_contracts"] == RISK["max_open_positions"] == 1


def test_the_dry_run_is_registered_before_it_runs_and_adds_no_trial():
    rec = (ROOT / "research" / "decisions" / "DEC-0031-options-clone-dry-run.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-20\.\*\*", rec) and "no result of it has" in rec
    assert "family O stays at 14" in rec and family_trial_count("O") == 47    # DEC-0034 added one since; DEC-0041 14; DEC-0051 one, DEC-0052 one, DEC-0053 one, DEC-0054 three, DEC-0056 three, DEC-0058 three
    exp = ROOT / "research" / "experiments" / "EXP-0025-options-clone-dry-run"
    assert (exp / "README.md").exists()


def test_the_tradeable_names_rule_is_recorded_and_configured():
    rec = (ROOT / "research" / "decisions" / "DEC-0032-options-clone-tradeable-names.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-20\.\*\*", rec) and "No trial is added" in rec
    assert CONFIG["names"]["top_up"] == ["SPY", "QQQ"] and CONFIG["names"]["min_names"] == 2
    assert family_trial_count("O") == 47    # DEC-0034 added HYP-0031 since; DEC-0041 14; DEC-0051 one, DEC-0052 one, DEC-0053 one, DEC-0054 three, DEC-0056 three, DEC-0058 three


def test_the_one_level_source_rule_is_recorded():
    rec = (ROOT / "research" / "decisions" / "DEC-0033-options-clone-one-level-source.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-20\.\*\*", rec) and "No trial is added" in rec
    assert family_trial_count("O") == 47    # DEC-0034 added HYP-0031 since; DEC-0041 14; DEC-0051 one, DEC-0052 one, DEC-0053 one, DEC-0054 three, DEC-0056 three, DEC-0058 three


def test_the_cap_change_is_recorded_as_three_new_trials_before_its_first_trade():
    rec = (ROOT / "research" / "decisions" / "DEC-0039-options-clone-cap-15.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-10-29\.\*\*", rec) and "from 15 to **18**" in rec
    assert "Written before any trade under the new cap exists" in rec and "2026-10-30" in rec
    exp = (ROOT / "research" / "experiments" / "EXP-0028-options-clone-cap-15" / "README.md").read_text()
    assert "DEC-0039" in exp and "2026-10-30" in exp and "30 trades and 20 sessions" in exp
    assert family_trial_count("O") == 47


def test_the_spread_cap_change_is_recorded_as_three_new_trials_before_its_first_trade():
    rec = (ROOT / "research" / "decisions" / "DEC-0040-options-clone-spread-cap-5.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-11-04\.\*\*", rec) and "from 18 to **21**" in rec
    assert "Written before any trade under the new cap exists" in rec and "2026-11-05" in rec
    exp = (ROOT / "research" / "experiments" / "EXP-0029-options-clone-spread-5" / "README.md").read_text()
    assert "DEC-0040" in exp and "2026-11-05" in exp and "30 trades and 20 sessions" in exp
    clone = yaml.safe_load((ROOT / "config" / "options_clone.yaml").read_text())["contract"]
    assert clone["max_spread"] == 5.0 and clone["max_spread_pct_of_mid"] == 8


ARMS = [h for h in HYPOTHESES if h["evidence"].get("decision") == "DEC-0041"]


def test_the_research_arms_are_fourteen_new_trials_recorded_before_any_result():
    rec = (ROOT / "research" / "decisions" / "DEC-0041-options-clone-research-arms.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-11-05\.\*\*", rec) and "from 21 to **35**" in rec
    assert "Written before any affected P&L is viewed" in rec and family_trial_count("O") == 47
    assert [h["id"] for h in ARMS] == [f"HYP-{n:04d}" for n in range(34, 48)]
    assert len({h["trial"] for h in ARMS}) == 14
    exp = ROOT / "research" / "experiments" / "EXP-0030-options-clone-research-arms" / "README.md"
    assert "DEC-0041" in exp.read_text() and "Design only" in exp.read_text()
    for h in ARMS:
        assert h["evidence"]["experiments"] == ["EXP-0030-options-clone-research-arms"]
        assert h["arm"] in ("tag", "shadow") and h["close_without_verdict"] == "2027-11-05"
        assert "never backfilled" in h["since"] and isinstance(h["frozen"], dict)
        assert h["id"] in rec
    tags = [h for h in ARMS if h["arm"] == "tag"]
    assert len(tags) == 10 and [h["rule"] for h in tags] == ["retest", "rejection"] * 5
    shadow = [h for h in ARMS if h["arm"] == "shadow"]
    assert [h["rule"] for h in shadow] == ["retest", "rejection", "trap", "reclaim_fast"]
    assert all("never an order" in h["statement"] for h in shadow)


def test_the_research_arms_freeze_the_numbers_the_record_states():
    by = {h["trial"]: h["frozen"] for h in ARMS}
    assert (by["OC-IVGATE-RETEST"]["cap_index"], by["OC-IVGATE-RETEST"]["cap_single"]) == (0.35, 0.70)
    assert by["OC-EARLY-REJECT"]["early_before"] == "11:00" and by["OC-EARLY-REJECT"]["late_to"] == "14:30"
    run = by["OC-RUNNER-RETEST"]
    assert run["trail"] == "Tape.ema_fast" and run["trail_ema"] == CONFIG["bars"]["ema_fast"] == 9
    assert run["breakeven_after_pct"] == CONFIG["exits"]["breakeven_after_pct"] == 25
    assert run["flat"] == CONFIG["day"]["flatten"] == "15:10"
    assert by["OC-RECLAIM-FAST"]["sweep_min_atr"] == 0.25 and by["OC-TRAP"]["fail_within_bars"] == 3


def test_the_research_arms_block_is_off_and_still_carries_the_frozen_numbers():
    by = {h["trial"]: h["frozen"] for h in ARMS}
    ra = CONFIG["research_arms"]
    assert ra["enabled"] is False                           # on 2026-11-06 to DEC-0059; every arm ended at 2026-11-17
    rec = (ROOT / "research" / "decisions" / "DEC-0059-research-arms-stop-booking.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-11-18 \(New York\)\.\*\*", rec) and "family O stays at 47" in rec
    t = ra["tags"]
    iv = by["OC-IVGATE-REJECT"]
    assert (t["iv_cap_index"], t["iv_cap_single"]) == (iv["cap_index"], iv["cap_single"]) == (0.35, 0.70)
    assert iv["index_names"] == CONFIG["contract"]["index_names"] == ["SPY", "QQQ"]
    e = by["OC-EARLY-RETEST"]
    assert (t["early_from"], t["early_before"], t["late_to"]) == (e["early_from"], e["early_before"], e["late_to"])
    lead = by["OC-LEADER-REJECT"]
    assert t["leaders"] == {name: lead["leader"] for name in lead["names"]} == {"QQQ": "SMH"}
    sh = ra["shadow"]
    assert sh["arms"] == ["runner", "trap", "reclaim_fast"] and sh["max_entries_per_day"] == 5
    run = by["OC-RUNNER-REJECT"]
    assert sh["runner"]["premium_stop_pct"] == run["premium_stop_pct"] == CONFIG["exits"]["premium_stop_pct"]
    assert sh["runner"]["breakeven_after_pct"] == run["breakeven_after_pct"] and sh["runner"]["trail"] == "ema_fast"
    assert sh["trap"]["fail_within_bars"] == by["OC-TRAP"]["fail_within_bars"]
    assert sh["reclaim_fast"]["sweep_min_atr"] == by["OC-RECLAIM-FAST"]["sweep_min_atr"]
    # the arms never reach the frozen marks
    assert not {"ONH", "ONL", "SWH", "SWL", "EVH", "EVL", "GAPH", "GAPL", "ATH"} & \
        set(CONFIG["levels"]["names"] + CONFIG["levels"]["strong"])


def test_the_standing_name_is_recorded_as_three_new_trials_before_its_first_trade():
    """DEC-0058: QQQ traded every session, written before any session under it; EXP-0039 closes at one session."""
    rec = (ROOT / "research" / "decisions" / "DEC-0058-clone-qqq-standing-name.md").read_text()
    assert re.search(r"\*\*Status: ACCEPTED on 2026-11-17 \(New York\)\.\*\*", rec) and "from 44 to **47**" in rec
    assert "Written before any session under the new rule exists" in rec and "2026-11-19" in rec
    exp = (ROOT / "research" / "experiments" / "EXP-0040-options-clone-qqq-standing" / "README.md").read_text()
    assert "DEC-0058" in exp and "2026-11-19" in exp and "30 trades and 20 sessions" in exp
    old = (ROOT / "research" / "experiments" / "EXP-0039-options-clone-no-oi-floor" / "README.md").read_text()
    assert "Closed by DEC-0058" in old and "2026-11-18" in old
    assert CONFIG["names"]["standing"] == ["QQQ"] and "QQQ" in CONFIG["contract"]["index_names"]
    assert family_trial_count("O") == 47
