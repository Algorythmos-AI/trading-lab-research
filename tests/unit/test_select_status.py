"""The Radar → Options shadow's status block for the Radar page (DEC-0070): read from the runs' `run.json`, codes,
counts, times and flags only, sent in the paper options document from version 4 and left out for an older site."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema

from wt.options import paper_site
from wt.options import select_status as ss

ROOT = Path(__file__).resolve().parents[2]
DESK = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "PLTR", "AVGO", "AMD"]


def run_doc(session: str = "2026-11-23", **over: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "schema": "wt.options/radar-select-run", "version": 1, "session": session, "finished_session": "2026-11-20",
        "mode": "shadow", "run_at": "2026-11-23T11:45:00+00:00", "finished_at": "2026-11-23T11:46:02+00:00",
        "publish_by": "2026-11-23T13:40:00+00:00", "late": False, "radar_status": "ok",
        "radar_detail": "the edition could not be read (secret words)", "gate_unset": True, "radar_bars_fetch": "ok",
        "desk": DESK,
        "counts": {
            "candidates": {"in_scope_symbols": 21, "out_of_scope_symbols": 9, "unknown_lists": 1,
                           "rejected": {"malformed_symbol": 2}, "candidates": 21, "core": 7, "discovered": 14},
            "universe": {"core": 12, "candidates_gated": 14, "admitted": 0, "rejected": {"gate_unset": 14}},
            "stage1": {"names": 12, "data_valid": 12, "ranked": 12, "eligible": 11, "picked": 4},
        },
        "picks": [{"symbol": "NVDA", "origin": "core"}, {"symbol": "XYZ", "origin": "radar"},
                  {"symbol": "AAPL", "origin": "both"}, {"symbol": "TSLA", "origin": "core"}],
        "selection_note": None, "hashes": {"params_sha": "0861"},
    }
    doc.update(over)
    return doc


def write(root: Path, doc: Any, name: str | None = None) -> None:
    folder = root / (name or doc["session"])
    folder.mkdir(parents=True)
    (folder / "run.json").write_text(doc if isinstance(doc, str) else json.dumps(doc))


def schema() -> dict[str, Any]:
    out: dict[str, Any] = json.loads(paper_site.SCHEMA_PATH.read_text())
    return out


def test_no_folder_is_no_block(tmp_path: Path) -> None:
    assert ss.block(tmp_path / "options-select") is None


def test_a_run_becomes_counts_and_codes_without_a_symbol_or_free_text(tmp_path: Path) -> None:
    write(tmp_path, run_doc())
    b = ss.block(tmp_path)
    assert b is not None and b["mode"] == "shadow" and b["off"] is False
    (s,) = b["sessions"]
    assert s["radar_status"] == "ok" and s["gate_unset"] is True and s["late"] is False and s["radar_bars_ok"]
    assert s["universe"] == {"core": 12, "candidates_gated": 14, "admitted": 0, "rejected": {"gate_unset": 14}}
    assert s["candidates"]["discovered"] == 14 and s["candidates"]["rejected"] == {"malformed_symbol": 2}
    assert s["stage1"]["picked"] == 4 and s["picks_from_radar"] == 2
    text = json.dumps(b)
    for word in [*DESK, "XYZ", "secret", "radar_detail", "publish_by", "hashes"]:
        assert word not in text, word


def test_broken_partial_and_foreign_folders_are_left_out(tmp_path: Path) -> None:
    write(tmp_path, run_doc("2026-11-20"))
    write(tmp_path, "{not json", "2026-11-21")
    write(tmp_path, run_doc("2026-11-19", schema="something/else"))
    write(tmp_path, run_doc("2026-11-18"), "2026-11-17")                 # a folder that names another session
    (tmp_path / ".2026-11-23.tmp-123").mkdir()                            # a run still being written
    (tmp_path / "2026-11-24").mkdir()                                     # no run.json yet
    b = ss.block(tmp_path)
    assert b is not None and [s["session"] for s in b["sessions"]] == ["2026-11-20"]


def test_a_field_that_is_not_what_it_should_be_is_null(tmp_path: Path) -> None:
    bad = run_doc(radar_status="something new", late="yes", run_at="Monday",
                  counts={"candidates": {"discovered": -1, "rejected": {"Not A Code": 3, "ok_code": True}},
                          "universe": "broken", "stage1": {"picked": 2.5}})
    write(tmp_path, bad)
    (s,) = ss.block(tmp_path)["sessions"]  # type: ignore[index]
    assert s["radar_status"] is None and s["late"] is None and s["run_at"] is None
    assert s["candidates"]["discovered"] is None and s["candidates"]["rejected"] == {}
    assert s["universe"]["admitted"] is None and s["stage1"]["picked"] is None
    doc = {"schema": "stocksdelta/paper-options", "schema_version": 4, "run_id": "r", "paper": True,
           "as_of": "2026-11-23T12:00:00+00:00", "clone": {"trades": [], "truncated": 0}, "select": ss.block(tmp_path)}
    jsonschema.validate(doc["select"], {**schema()["properties"]["select"], "definitions": schema()["definitions"]})


def test_the_newest_ten_are_kept_and_the_off_switch_is_said(tmp_path: Path) -> None:
    days = [f"2026-10-{d:02d}" for d in range(1, 15)]
    for d in days:
        write(tmp_path, run_doc(d))
    (tmp_path / ss.OFF).touch()
    b = ss.block(tmp_path)
    assert b is not None and b["off"] is True
    assert [s["session"] for s in b["sessions"]] == days[-ss.MAX_SESSIONS:]


def test_the_block_validates_against_the_sites_schema(tmp_path: Path) -> None:
    write(tmp_path, run_doc())
    sub = {**schema()["properties"]["select"], "definitions": schema()["definitions"]}
    jsonschema.validate(ss.block(tmp_path), sub)
    jsonschema.validate(None, sub)


def test_a_site_that_takes_version_3_gets_no_select_block() -> None:
    doc = {"schema": "stocksdelta/paper-options", "schema_version": 4, "lab": {"sessions": []}, "select": {"x": 1}}
    v3 = paper_site.as_version(doc, 3)
    assert v3["schema_version"] == 3 and "select" not in v3 and "lab" in v3
    assert "select" not in paper_site.as_version(doc, 2) and "select" not in paper_site.as_version(doc, 1)
    assert paper_site.as_version(doc, 4) == doc
