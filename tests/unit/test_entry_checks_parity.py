"""The Options desk's live cautions (dashboard/src/lib/entry-checks.ts) use the clone's own numbers: each constant there
equals its key in config/options_clone.yaml, so a change to the research arms cannot leave the site behind. And they
behave as the clone does: the shared vectors (scripts/gen_entry_check_vectors.py) hold `setups.tag_decision`'s answers,
which dashboard/test/entry-checks-vectors.test.ts asserts for `entryChecks`."""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

from wt.options import levels

ROOT = Path(__file__).resolve().parents[2]
TS = (ROOT / "dashboard/src/lib/entry-checks.ts").read_text()
CFG: dict[str, Any] = yaml.safe_load((ROOT / "config/options_clone.yaml").read_text())
ARMS = CFG["research_arms"]


def const(name: str) -> str:
    """The right-hand side of `export const NAME ... = <value>;` in the TS file."""
    m = re.search(rf"export const {name}\b[^=]*=\s*(.+?);\s*$", TS, re.M)
    assert m, f"{name} is not exported from entry-checks.ts"
    return m.group(1).strip()


def num(name: str) -> float:
    return float(const(name))


def text(name: str) -> str:
    v = const(name)
    assert re.fullmatch(r'"[^"]*"', v), f"{name} is not a string literal: {v}"
    return str(json.loads(v))


def names(name: str) -> list[str]:
    return re.findall(r'"([A-Z0-9.]+)"', const(name))


def test_iv_caps_and_times_match_the_tags():
    tags = ARMS["tags"]
    assert num("IV_CAP_INDEX") == float(tags["iv_cap_index"])
    assert num("IV_CAP_SINGLE") == float(tags["iv_cap_single"])
    assert text("EARLY_FROM") == str(tags["early_from"])
    assert text("EARLY_BEFORE") == str(tags["early_before"])
    assert text("LATE_TO") == str(tags["late_to"])


def test_bar_and_retest_window_match_the_clone():
    assert num("BAR_MINUTES") == float(CFG["bars"]["minutes"])
    assert num("MAX_BARS_TO_RETEST") == float(CFG["setups"]["retest"]["max_bars_to_retest"])


def test_shadow_arm_numbers_match():
    shadow = ARMS["shadow"]
    assert num("FAIL_WITHIN_BARS") == float(shadow["trap"]["fail_within_bars"])
    assert num("SWEEP_MIN_ATR") == float(shadow["reclaim_fast"]["sweep_min_atr"])


def test_leaders_and_index_names_match():
    pairs = dict(re.findall(r'(\w+):\s*"([A-Z0-9.]+)"', const("LEADERS")))
    assert pairs == {str(k): str(v) for k, v in ARMS["tags"]["leaders"].items()}
    assert names("INDEX_NAMES") == [str(x) for x in CFG["contract"]["index_names"]]


def test_marks_are_the_clones_marked_levels():
    want = [str(x) for x in CFG["levels"]["names"]]
    if CFG["levels"].get("premarket"):
        want += ["PMKH", "PMKL"]
    assert names("MARK_NAMES") == want


def test_five_session_range_length_matches_the_clone():
    assert num("SWING_SESSIONS") == levels.SWING_SESSIONS


# ---------------------------------------------------------------- behaviour: the shared vectors
_spec = importlib.util.spec_from_file_location("gen_entry_check_vectors", ROOT / "scripts" / "gen_entry_check_vectors.py")
assert _spec and _spec.loader
GEN = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(GEN)
VECTORS: dict[str, Any] = json.loads((ROOT / "dashboard/test/fixtures/entry-checks.vectors.json").read_text())


def test_the_vectors_cover_the_edges():
    names = [c["name"] for c in VECTORS["cases"]]
    assert len(names) >= 25 and len(set(names)) == len(names)
    for flag in GEN.FLAGS:
        seen = {json.dumps(c["expect"][flag]) for c in VECTORS["cases"]}
        assert {"true", "false"} <= seen, flag      # each flag is exercised both ways


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_tag_decision_gives_the_vectors_answers(case: dict[str, Any]):
    assert GEN.run(case, GEN.cfg()) == case["expect"]


def test_the_committed_vectors_are_current():
    assert GEN.build() == VECTORS, "run scripts/gen_entry_check_vectors.py"
