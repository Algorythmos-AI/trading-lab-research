"""DEC-0052: the Options desk's board says ENTER on a break and retest only at the close that completes the clone's
retest. The shared vectors (scripts/gen_retest_vectors.py, dashboard/test/fixtures/retest.vectors.json) hold, for each
synthetic session, every bar at whose close `wt.options.setups.retest` signals; dashboard/test/retest-vectors.test.ts
asserts the board's enter zone is exactly the first signal's two slots, and a later signal of the same break reads
missed. Here the clone is re-run bar by bar on every case, as its runner runs it, and must signal exactly there and
nowhere else."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest
import yaml

from wt.options import regime, setups

ROOT = Path(__file__).resolve().parents[2]
CFG: dict[str, Any] = yaml.safe_load((ROOT / "config/options_clone.yaml").read_text())
VECTORS: dict[str, Any] = json.loads((ROOT / "dashboard/test/fixtures/retest.vectors.json").read_text())

_spec = importlib.util.spec_from_file_location("gen_retest_vectors", ROOT / "scripts" / "gen_retest_vectors.py")
assert _spec and _spec.loader
GEN = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(GEN)


def test_the_vectors_use_the_clones_numbers():
    assert VECTORS["retest"] == CFG["setups"]["retest"]
    assert VECTORS["atr_period"] == CFG["bars"]["atr_period"]
    assert VECTORS["bar_minutes"] == CFG["bars"]["minutes"]


def test_the_vectors_cover_both_answers_and_both_sides():
    cases = VECTORS["cases"]
    names = [c["name"] for c in cases]
    assert len(names) >= 10 and len(set(names)) == len(names)
    confirms = [c["expect"]["confirm"] for c in cases]
    assert sum(x is not None for x in confirms) >= 5 and sum(x is None for x in confirms) >= 4
    assert any(len(c["expect"]["signals"]) >= 2 for c in cases)        # a break the clone signals twice
    assert {c["side"] for c in cases if c["expect"]["confirm"] is not None} == {"call", "put"}


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_the_clone_signals_exactly_at_the_vectors_bar(case: dict[str, Any]):
    bars = GEN.bars_of(case)
    mark = setups.Mark("L", float(case["level"]))
    rt = CFG["setups"]["retest"]
    at: list[tuple[int, float]] = []
    for i in range(len(bars)):
        seen = bars[: i + 1]
        a = regime.atr(seen, int(CFG["bars"]["atr_period"]))
        if a is None or a <= 0:
            continue
        sigs = [s for s in setups.retest(seen, [mark], a, rt) if s.side == case["side"]]
        if sigs:
            at.append((i, a))
            assert sigs[0].entry == seen[-1].c          # the signal is the confirming bar's close
    assert at == [(x["bar"], x["atr"]) for x in case["expect"]["signals"]]
    first = at[0] if at else (None, None)
    assert (case["expect"]["confirm"], case["expect"]["atr_at_confirm"]) == first


def test_the_committed_vectors_are_current():
    assert GEN.build() == VECTORS, "run scripts/gen_retest_vectors.py"
