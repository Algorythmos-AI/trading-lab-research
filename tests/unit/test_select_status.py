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
    doc = {"schema": "stocksdelta/paper-options", "schema_version": 5, "lab": {"sessions": []},
           "select": {"mode": "shadow", "off": False, "sessions": [{"session": "2026-11-24", "check": None}],
                      "progress": {"clean": 0, "checked": 0, "runs": 1, "needed": 5}}}
    v3 = paper_site.as_version(doc, 3)
    assert v3["schema_version"] == 3 and "select" not in v3 and "lab" in v3
    assert "select" not in paper_site.as_version(doc, 2) and "select" not in paper_site.as_version(doc, 1)
    assert paper_site.as_version(doc, 5) == doc


def test_a_version_4_site_gets_the_block_without_progress_or_checks() -> None:
    doc = {"schema": "stocksdelta/paper-options", "schema_version": 5,
           "select": {"mode": "shadow", "off": False, "sessions": [{"session": "2026-11-24", "check": {"clean": True}}],
                      "progress": {"clean": 1, "checked": 1, "runs": 1, "needed": 5}}}
    v4 = paper_site.as_version(doc, 4)
    assert v4["schema_version"] == 4 and v4["select"] == {"mode": "shadow", "off": False,
                                                         "sessions": [{"session": "2026-11-24"}]}
    assert doc["select"]["sessions"][0]["check"] == {"clean": True}                  # the original is untouched


def check_doc(session: str = "2026-11-23", **over: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "schema": "wt.options/radar-select-check", "version": 1, "session": session,
        "checked_at": "2026-11-23T12:46:00+00:00", "clean": True, "reasons": [], "replay": "reproduces",
        "universe_version": 2, "verdicts": 14, "verdicts_with_facts": 14, "candidates": 21, "picks": 4,
        "published": {"status": "ok", "overlap": 3, "of": 4},
    }
    doc.update(over)
    return doc


def write_check(root: Path, doc: Any) -> None:
    (root / doc["session"] / "check.json").write_text(json.dumps(doc))


def test_the_check_and_the_progress_are_carried_in_codes_and_counts(tmp_path: Path) -> None:
    for day in ("2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24"):
        write(tmp_path, run_doc(day))
    write_check(tmp_path, check_doc("2026-11-19", clean=False, reasons=["radar_not_ok", "late"], replay="differs",
                                    published={"status": "not_read", "overlap": None, "of": None}))
    write_check(tmp_path, check_doc("2026-11-20"))
    write_check(tmp_path, check_doc("2026-11-23"))
    b = ss.block(tmp_path)
    assert b is not None and b["progress"] == {"clean": 2, "checked": 3, "runs": 4, "needed": 5}
    by = {v["session"]: v["check"] for v in b["sessions"]}
    assert by["2026-11-24"] is None
    assert by["2026-11-19"]["reasons"] == ["radar_not_ok", "late"] and by["2026-11-19"]["published"]["overlap"] is None
    assert by["2026-11-23"]["published"] == {"status": "ok", "overlap": 3, "of": 4}
    sub = {**schema()["properties"]["select"], "definitions": schema()["definitions"]}
    jsonschema.validate(b, sub)
    text = json.dumps(b)
    assert "NVDA" not in text and "XYZ" not in text


def test_a_bad_check_never_reads_clean(tmp_path: Path) -> None:
    cases = {
        "2026-11-17": check_doc("2026-11-17", reasons=["late"]),                  # says clean but gives a reason
        "2026-11-18": check_doc("2026-11-18", clean=False, reasons=["NVDA broke"]),  # a reason outside the set
        "2026-11-19": check_doc("2026-11-19", clean="yes"),
        "2026-11-20": check_doc("2026-11-23"),                                    # another session's record
        "2026-11-23": {**check_doc("2026-11-23"), "schema": "other"},
    }
    for day, doc in cases.items():
        write(tmp_path, run_doc(day))
        (tmp_path / day / "check.json").write_text(json.dumps(doc))
    write(tmp_path, run_doc("2026-11-24"))
    (tmp_path / "2026-11-24" / "check.json").write_text("{not json")
    b = ss.block(tmp_path)
    assert b is not None and b["progress"]["clean"] == 0
    by = {v["session"]: v["check"] for v in b["sessions"]}
    assert by["2026-11-17"]["reasons"] == ["late"] and not by["2026-11-17"]["clean"]
    assert by["2026-11-18"]["reasons"] == ["check_invalid"] and "NVDA" not in json.dumps(b)
    assert by["2026-11-19"]["clean"] is False
    assert by["2026-11-20"] is None and by["2026-11-23"] is None and by["2026-11-24"] is None
    jsonschema.validate(b, {**schema()["properties"]["select"], "definitions": schema()["definitions"]})


def test_the_closed_sets_match_the_job() -> None:
    from wt.options import radar_select as rs
    assert ss.NOT_CLEAN == rs.NOT_CLEAN and ss.REPLAY_WORDS == rs.REPLAY_WORDS
    assert ss.PUBLISHED_WORDS == rs.PUBLISHED_WORDS and ss.CLEAN_NEEDED == rs.CLEAN_NEEDED
    assert ss.CHECK_SCHEMA == rs.CHECK_SCHEMA and ss.CHECK_FILE == rs.CHECK_FILE
    enum = schema()["definitions"]["select_session"]["properties"]["check"]["oneOf"][1]["properties"]["reasons"]
    assert enum["items"]["enum"] == [*ss.NOT_CLEAN, ss.CHECK_INVALID]


def test_the_progress_command_prints_counts_and_codes(tmp_path: Path, capsys: Any) -> None:
    write(tmp_path, run_doc("2026-11-23"))
    write(tmp_path, run_doc("2026-11-24"))
    write_check(tmp_path, check_doc("2026-11-24", clean=False, reasons=["facts_missing"]))
    assert ss.main(["progress", "--root", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "0 of 5 clean sessions (1 checked of 2 runs)" in out
    assert "2026-11-24  not clean: facts_missing" in out and "2026-11-23  no check" in out
    assert "3 of 4 published" in out and "NVDA" not in out
    assert ss.main(["progress", "--root", str(tmp_path / "none")]) == 0
    assert "never run" in capsys.readouterr().out
