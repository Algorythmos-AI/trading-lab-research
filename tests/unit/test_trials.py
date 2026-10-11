"""The global trial registry (config/trial_registry.yaml) agrees with the decision records and the spec."""
import re
from pathlib import Path

import pytest
import yaml

from wt.research.trials import REGISTRY, global_trial_count, trial_history
from wt.specs.loader import load_spec

ROOT = Path(__file__).resolve().parents[2]


def record(decision: str) -> str:
    hits = sorted((ROOT / "research/decisions").glob(f"{decision}-*.md"))
    assert len(hits) == 1, f"no single decision record for {decision}"
    return hits[0].read_text()


def status_of(text: str) -> str:
    """'proposed' while the record's Status line says PROPOSED; records without a Status line were accepted."""
    m = re.search(r"\*\*Status:\s*([^*]+)\*\*", text)
    return "proposed" if m and "PROPOSED" in m.group(1).upper() else "accepted"


def test_every_row_matches_its_decision_record():
    for row in trial_history():
        text = record(row["decision"])
        assert re.search(rf"(?<!\d){row['total']}(?!\d)", text), f"{row['decision']} never states {row['total']}"
        assert status_of(text) == row["status"], f"{row['decision']}: registry says {row['status']}"


def test_spec_round_three_count_matches_the_registry():
    dec10 = next(r for r in trial_history() if r["decision"] == "DEC-0010")
    assert load_spec("SPEC-0001")["evaluation"]["global_trials_after"] == dec10["total"]


def test_count_in_force_is_the_newest_accepted_row():
    rows = trial_history()
    assert global_trial_count() == [r for r in rows if r["status"] == "accepted"][-1]["total"]
    assert REGISTRY.name == "trial_registry.yaml"


def write(tmp_path, rows):
    p = tmp_path / "reg.yaml"
    p.write_text(yaml.safe_dump({"history": rows}))
    return p


def test_proposed_rows_do_not_count_until_accepted(tmp_path):
    rows = [{"decision": "DEC-A", "total": 85, "status": "accepted"}, {"decision": "DEC-B", "total": 87, "status": "proposed"}]
    assert global_trial_count(write(tmp_path, rows)) == 85
    rows[1]["status"] = "accepted"
    assert global_trial_count(write(tmp_path, rows)) == 87


@pytest.mark.parametrize("rows, msg", [
    ([{"decision": "A", "total": 85, "status": "accepted"}, {"decision": "B", "total": 80, "status": "accepted"}], "decreases"),
    ([{"decision": "A", "total": 85, "status": "maybe"}], "bad trial registry row"),
    ([{"decision": "A", "total": "85", "status": "accepted"}], "bad trial registry row"),
    ([{"decision": "A", "total": 85, "status": "proposed"}], "no accepted row"),
])
def test_malformed_registry_is_refused(tmp_path, rows, msg):
    with pytest.raises(ValueError, match=msg):
        global_trial_count(write(tmp_path, rows))


def test_the_research_index_lists_every_experiment_with_a_hash_of_its_result():
    import importlib.util
    spec = importlib.util.spec_from_file_location("research_index", ROOT / "scripts" / "research_index.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    rows = {r["folder"]: r for r in mod.index()}
    folders = {p.name for p in (ROOT / "research" / "experiments").glob("EXP-*") if p.is_dir()}
    assert set(rows) == folders and len(folders) > 10
    assert all(len(r["result"]) == 12 for r in rows.values() if r["result"] != "-")


def test_a_moved_id_is_taken_and_no_record_here_carries_it(capsys):
    """The crypto desk's records left for crypto-lab with their ids (research/MOVED.md). An id that no file here
    carries must not look free: the index still lists the moved experiments, and no record here may reuse one."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("research_index", ROOT / "scripts" / "research_index.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    moved = mod.moved()
    assert len(moved) == 29 and moved["EXP-0016"] == "research/experiments/EXP-0016-crypto-c1/"
    assert {i for i in moved if i.startswith("EXP-")} == {f"EXP-00{n}" for n in range(16, 23)}
    assert {"HYP-0020", "HYP-0024", "DEC-0012", "DEC-0027", "LL-0003", "LL-0006"} <= set(moved)
    assert not {"DEC-0028", "DEC-0029", "HYP-0025", "HYP-0028", "EXP-0023"} & set(moved)      # the options desk's
    here = [p for p in (ROOT / "research").rglob("*") if p.name.split("-")[0] in ("HYP", "EXP", "DEC", "LL")]
    taken = {"-".join(p.name.split("-")[:2]).split(".")[0] for p in here}
    assert not taken & set(moved), "a record here reuses the id of a record that moved"
    assert not any((ROOT / was).exists() for was in moved.values())
    assert not (ROOT / "research" / "CRYPTO_SUMMARY.md").exists()
    assert mod.main() == 0
    out = capsys.readouterr().out
    assert all(f"| {name} |" in out for name in ("EXP-0016-crypto-c1", "EXP-0022-crypto-trend-ranked", "EXP-0015a-catalyst-accuracy"))
    assert out.count("moved to crypto-lab; the id stays taken") == 7
