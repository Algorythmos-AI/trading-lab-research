"""The replication driver (scripts/options_replication.py) on synthetic frames; and EXP-0023's record."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pandas as pd
from test_options_levels import sessions

from wt.options import intraday, rules

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("options_replication", ROOT / "scripts" / "options_replication.py")
assert _spec and _spec.loader
rep = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rep)


def frames():
    daily = [{"symbol": "AAA", "t": pd.Timestamp(f"{d}T04:00:00Z"), "o": 100.0, "h": 100.5, "l": 99.5, "c": 100.0} for d in sessions("2026-10-09", 40)]
    halves = []
    for hhmm, o, h, low, c in (("09:30", 100, 100.4, 99.9, 100.3), ("10:00", 100.3, 100.6, 100.2, 100.5), ("10:30", 100.5, 101.0, 100.4, 100.9),
                               ("11:00", 100.9, 101.2, 100.8, 101.1), ("11:30", 101.1, 102.3, 101.0, 102.2), ("12:00", 102.2, 102.3, 102.0, 102.1),
                               ("13:00", 102.1, 102.2, 102.0, 102.1), ("14:00", 102.1, 102.2, 102.0, 102.1), ("15:00", 102.1, 102.2, 102.0, 102.1)):
        at = pd.Timestamp(f"2026-10-12T{hhmm}", tz=intraday.NEW_YORK).tz_convert("UTC")
        halves.append({"symbol": "AAA", "t": at, "o": o, "h": h, "l": low, "c": c})
    return pd.DataFrame(daily), pd.DataFrame(halves)


def test_one_session_is_replayed_with_the_registered_rules_and_what_is_left_out_is_counted():
    daily, halves = frames()
    trades, skipped = rep.replicate(["AAA"], daily, halves, "2026-10-12", "2026-10-13")
    assert [(t["session"], t["name"], t["rule"], t["exit"], t["r"]) for t in trades] == [("2026-10-12", "AAA", "brk_PDH_close", "target", 2.0)]
    # The 13th has no bars at all: no levels can follow from the 12th's missing daily bar, and it is counted.
    assert skipped == {"names_with_bar_problems": [], "sessions_without_levels": 1, "sessions_with_few_hourly_bars": 0}
    assert rep.summary([], []) == {"n": 0}
    s = rep.summary([2.0, -1.0, 0.5, -1.0], ["a", "a", "b", "c"])
    assert (s["n"], s["avg_r"], s["win_rate"], s["stops"], s["targets"]) == (4, 0.125, 0.5, 2, 1)
    assert s["ci95"][0] <= s["avg_r"] <= s["ci95"][1]


def test_a_record_is_never_written_over(tmp_path, capsys):
    (tmp_path / "result.json").write_text("{}")
    assert rep.main(["--out", str(tmp_path)]) == 2                # before any key is read or bar pulled
    assert (tmp_path / "result.json").read_text() == "{}" and "new EXP id" in capsys.readouterr().err


RECORD = ROOT / "research/experiments/EXP-0023-options-rules-replication"


def test_the_record_quotes_the_registered_figures_and_the_report_quotes_the_record():
    result = json.loads((RECORD / "result.json").read_text())
    report = (RECORD / "report.md").read_text()
    assert result["decision"] == "DEC-0028" and "not evidence" in result["what"] and list(result["rules"]) == list(rules.RULES)
    registered = {r["id"]: r["backtest"] for r in json.loads((ROOT / "config/options_rules.json").read_text())["rules"]}
    rows = {line.split("|")[1].strip().strip("`"): [c.strip() for c in line.split("|")[2:-1]] for line in report.splitlines() if line.startswith("| `")}
    assert list(rows) == list(rules.RULES)
    for rule, v in result["rules"].items():
        here, seen = v["replication"], v["seen_before_registration"]
        assert seen == {k: registered[rule][k] for k in ("n", "avg_r", "ci_lo", "ci_hi")}      # what was seen is not retyped
        assert rows[rule] == [str(seen["n"]), str(here["n"]), f"{seen['avg_r']:+.3f}", f"{here['avg_r']:+.4f}",
                              f"[{seen['ci_lo']:+.3f}, {seen['ci_hi']:+.3f}]", f"[{here['ci95'][0]:+.4f}, {here['ci95'][1]:+.4f}]",
                              f"[{here['ci95_by_session'][0]:+.4f}, {here['ci95_by_session'][1]:+.4f}]"]
    pooled, exits = result["pooled"], result["by_exit"]
    assert sum(v["replication"]["n"] for v in result["rules"].values()) == pooled["n"] == sum(exits.values())
    assert f"Pooled: {pooled['n']} cases, mean R {pooled['avg_r']:+.4f}" in report
    assert f"{exits['stop']} stops, {exits['target']} targets" in report and result["data_hash"] in report
    assert "not a test" in report and "before any option cost" in report and "still open" in report
