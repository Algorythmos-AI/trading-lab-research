"""Methodology presets: LEGACY reproduces the recorded defaults; DEC0011 is the corrected preset."""
import inspect

import pytest

from wt.backtest.engine import simulate
from wt.backtest.stats import summarize
from wt.research import method as mt
from wt.research.trials import global_trial_count


def test_legacy_is_every_default():
    sig = inspect.signature(simulate).parameters
    assert mt.LEGACY.sim_kwargs() == {"target_fill": sig["target_fill"].default, "tick": sig["tick"].default}
    assert mt.LEGACY.bootstrap_block == inspect.signature(summarize).parameters["block"].default
    assert mt.LEGACY.pnl == "nominal" and not mt.LEGACY.fill_stress and mt.LEGACY.stop_slip_stress == ()
    assert mt.get_method(None) is mt.LEGACY and mt.LEGACY.legacy


def test_dec0011_preset():
    m = mt.get_method(mt.METHOD)
    assert m is mt.DEC0011 and not m.legacy
    assert m.sim_kwargs() == {"target_fill": "through", "tick": 0.01}
    assert (m.bootstrap_block, m.dsr_trials, m.pnl, m.fill_stress) == ("day", "global", "realised", True)
    assert m.stop_slip_stress and all(k > 1 for k in m.stop_slip_stress)


def test_dsr_trial_source():
    assert mt.LEGACY.dsr_trial_count(recorded=12) == 12            # g1_eval's recorded default: the experiment's own
    assert mt.DEC0011.dsr_trial_count(recorded=12) == global_trial_count()


@pytest.mark.parametrize("argv, name, rest", [
    (["EXP-1", "-", "2"], "legacy", ["EXP-1", "-", "2"]),
    (["EXP-1", "--method", "dec0011", "-"], "dec0011", ["EXP-1", "-"]),
    (["--method=dec0011", "EXP-1"], "dec0011", ["EXP-1"]),
])
def test_pop_method(argv, name, rest):
    m, left = mt.pop_method(argv)
    assert (m.name, left) == (name, rest)


def test_unknown_method_is_refused():
    with pytest.raises(ValueError, match="unknown method"):
        mt.get_method("dec9999")
    with pytest.raises(ValueError, match="needs a name"):
        mt.pop_method(["EXP-1", "--method"])
