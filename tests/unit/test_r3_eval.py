"""r3_eval on synthetic results: OOS span filter, cost stress, gates, capital table, holdout eligibility."""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import r3_eval  # noqa: E402


def synth(n=240, mu=0.4, seed=1):
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2019-06-03", "2025-09-25")
    pick = sorted(rng.choice(len(days), n, replace=False))
    rows = []
    for k, i in enumerate(pick):
        rows.append({"date": str(days[i].date()), "symbol": "X", "setup": "GG-2", "attempt": 1, "priority": 1,
                     "entry_time": "", "entry": 5.10, "stop0": 5.00, "qty": 60, "R": float(rng.normal(mu, 1.0)),
                     "exit_reason": "partial_t1", "exit_time": "", "tags": {"slip": 0.01, "breakout_volume_ok": bool(k % 2)}})
    return rows


def test_eval_gates_and_stress(tmp_path, monkeypatch):
    monkeypatch.setattr(r3_eval, "ROOT", tmp_path)
    exp = tmp_path / "research" / "experiments" / "EXP-T"
    exp.mkdir(parents=True)
    rows = synth()
    body = {"trades": {"F:GG-2": {"600.0": rows, "1000.0": rows, "2000.0": rows}},
            "control_means": {"F:GG-2": list(np.random.default_rng(3).normal(0.0, 0.05, 200))}, "skips": {"F:GG-2": {"spread": 4}}}
    (exp / "results_F.json").write_text(json.dumps(body))
    out = r3_eval.main("EXP-T", holdout=False)["F:GG-2"]
    s = out["stats"]
    assert s["n"] == sum(r["date"] >= "2020-01-01" for r in rows)            # 2019 warm-up excluded
    assert abs(s["stress_1.5x"]["expectancy_R"] - (s["expectancy_R"] - 0.5 * 2 * 0.01 / 0.10)) < 1e-9
    assert s["random_control_p"] < 0.05 and out["gates"]["control_p_lt_0.05"]
    assert set(out["capital"]) == {"600.0", "1000.0", "2000.0"} and out["skips"] == {"spread": 4}
    assert "breakout_volume_ok" in s["tag_descriptives"]
    assert (exp / "r3_eval.md").exists()


def test_weak_edge_fails_gates(tmp_path, monkeypatch):
    monkeypatch.setattr(r3_eval, "ROOT", tmp_path)
    exp = tmp_path / "research" / "experiments" / "EXP-W"
    exp.mkdir(parents=True)
    rows = synth(mu=0.0, seed=5)
    (exp / "results_P.json").write_text(json.dumps({"trades": {"P:GG-1": {"600.0": rows}}, "control_means": {}}))
    out = r3_eval.main("EXP-W", holdout=False)["P:GG-1"]
    assert out["pass"] is False and out["gates"]["control_p_lt_0.05"] is False
