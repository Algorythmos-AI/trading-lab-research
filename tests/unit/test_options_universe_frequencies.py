"""The threshold report for DEC-0070 section 3: counts only, from saved shadow facts, and the gate's own order."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from test_radar_select import CFG, CFG_RAW, DESK, do_run

from wt.options import radar_candidates as rc

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("freq", ROOT / "scripts" / "options_universe_frequencies.py")
assert spec and spec.loader
freq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(freq)

TH = {"price_min": CFG_RAW["gate"]["price_min"], "median_dollar_volume_min": CFG_RAW["gate"]["median_dollar_volume_min"],
      "chain_ntm_strikes_min": CFG_RAW["gate"]["chain_ntm_strikes_min"], "chain_volume_min": CFG_RAW["gate"]["chain_volume_min"],
      "chain_spread_max_pct": CFG_RAW["gate"]["chain_spread_max_pct"]}


def saved(tmp: Path) -> Path:
    rec = do_run(cfg=rc.load_config())                       # the shadow as it runs today: thresholds unset
    (tmp / rec["universe.json"]["session"]).mkdir(parents=True)
    (tmp / rec["universe.json"]["session"] / "universe.json").write_text(json.dumps(rec["universe.json"]))
    return tmp


def test_the_report_counts_what_the_set_gate_would_admit_from_the_unset_shadows_facts(tmp_path: Path) -> None:
    records = freq.load(saved(tmp_path))
    set_gate = do_run(cfg=CFG)["universe.json"]
    would = sum(1 for v in set_gate["verdicts"] if v["reject"] in (None, "over_cap"))
    got = sum(1 for _, f in freq.facts(records) if freq.admitted(f, TH))
    assert got == would and got >= 1                           # the report and the gate agree, from facts alone


def test_the_report_prints_counts_and_never_a_symbol(tmp_path: Path) -> None:
    lines = freq.report(freq.load(saved(tmp_path)), TH)
    text = "\n".join(lines)
    assert "sessions 1" in text and "admitted before the cap per session" in text
    for sym in [*DESK, "XYZ", "ABC", "NEWCO", "TINY"]:
        assert sym not in text


def test_no_records_and_a_partial_threshold_set(tmp_path: Path, capsys) -> None:
    assert freq.report(freq.load(tmp_path / "none"), None)[-1].startswith("no candidate facts")
    assert freq.main(["--root", str(tmp_path), "--price-min", "10"]) == 2
    (tmp_path / "2026-11-20").mkdir()
    (tmp_path / "2026-11-20" / "universe.json").write_text(json.dumps({"version": 1, "verdicts": []}))
    assert freq.load(tmp_path) == []                           # a version 1 record has no facts
