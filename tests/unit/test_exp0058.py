"""EXP-0058 (DEC-0082): the frame, the draw, the scoring rules, and both scripts on synthetic data."""
from __future__ import annotations

import csv
import datetime as dt
import importlib.util
import json
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
import yaml

from wt.core.config import ROOT
from wt.data import news_archive as na
from wt.research import exp0058 as x
from wt.research.exp0057 import Share

SPEC = ROOT / "config" / "catalysts_spec.yaml"


def items(rows: list[tuple[int, str, list[str], str]]) -> pd.DataFrame:
    return pd.DataFrame([{"id": i, "created_at": c, "updated_at": c, "symbols": s, "headline": h, "source": "fiscal.ai",
                          "url": ""} for i, c, s, h in rows], columns=na.COLUMNS)


# ---- the frame ---------------------------------------------------------------------------------------------------

D, P = dt.date(2026, 10, 6), dt.date(2026, 10, 5)


def test_the_window_runs_from_16_00_the_previous_session_to_the_09_25_cut_inclusive() -> None:
    df = items([(1, "2026-10-05T19:59:59Z", ["AAA"], "too early"),        # 15:59:59 ET
                (2, "2026-10-05T20:00:00Z", ["AAA"], "at the open of the window"),
                (3, "2026-10-06T13:25:00Z", ["AAA"], "at the cut"),
                (4, "2026-10-06T13:25:01Z", ["AAA"], "after the cut")])
    got = x.frame({D: ["AAA"]}, {D: P}, df)
    assert [r["id"] for r in got] == [2, 3]


def test_the_window_follows_new_york_time_across_the_dst_change() -> None:
    d, p = dt.date(2026, 11, 2), dt.date(2026, 10, 30)             # clocks go back on 2026-11-01
    df = items([(1, "2026-10-30T20:00:00Z", ["AAA"], "16:00 EDT"),
                (2, "2026-11-02T14:25:00Z", ["AAA"], "09:25 EST"),
                (3, "2026-11-02T14:25:01Z", ["AAA"], "late")])
    assert [r["id"] for r in x.frame({d: ["AAA"]}, {d: p}, df)] == [1, 2]


def test_only_pool_names_count_and_the_first_pool_symbol_in_the_item_is_used() -> None:
    df = items([(1, "2026-10-06T12:00:00Z", ["ZZZ"], "not a pool name"),
                (2, "2026-10-06T12:00:00Z", ["ZZZ", "BBB", "AAA"], "two pool names")])
    got = x.frame({D: ["AAA", "BBB"]}, {D: P}, df)
    assert [(r["id"], r["symbol"]) for r in got] == [(2, "BBB")]


def test_repeats_count_once_per_session_and_the_lowest_id_is_kept() -> None:
    df = items([(9, "2026-10-06T12:00:00Z", ["AAA"], "Acme  Wins   Contract"),
                (5, "2026-10-06T12:30:00Z", ["BBB"], "acme wins contract"),
                (7, "2026-10-06T12:40:00Z", ["AAA"], "something else")])
    got = x.frame({D: ["AAA", "BBB"]}, {D: P}, df)
    assert sorted(r["id"] for r in got) == [5, 7]


def test_an_item_edited_after_the_cut_is_left_out_and_counted() -> None:
    df = items([(1, "2026-10-06T12:00:00Z", ["AAA"], "Acme wins contract"),      # edited at 11:00 ET: left out
                (2, "2026-10-06T12:30:00Z", ["AAA"], "acme wins contract"),      # its repeat represents it
                (3, "2026-10-06T12:00:00Z", ["AAA"], "edited at the cut")])
    df.loc[0, "updated_at"] = "2026-10-06T15:00:00Z"
    df.loc[2, "updated_at"] = "2026-10-06T13:25:00Z"                             # 09:25 ET: still kept
    stats: dict[str, int] = {}
    got = x.frame({D: ["AAA"]}, {D: P}, df, stats)
    assert sorted(r["id"] for r in got) == [2, 3] and stats == {"edited_after_cut": 1}


def test_the_code_constants_match_the_frozen_config() -> None:
    cfg = yaml.safe_load((ROOT / "research" / "experiments" / "EXP-0058-v3-on-fiscal" / "config.yaml").read_text())
    assert cfg["classifier"]["sha256"] == x.CLASSIFIER_SHA256 and cfg["classifier"]["version"] == 3
    assert [dt.date.fromisoformat(d) for d in cfg["frame"]["sessions"]] == list(x.FRAME)
    assert (cfg["sample"]["n"], cfg["sample"]["seed"]) == (x.N, x.SEED)
    assert cfg["labeller_check"]["min"] == x.LABELLER_MIN == 0.85
    assert "30 items" in cfg["labels"]["owner_blind"] and x.OWNER_BLIND == 30
    assert "up to 9 per category" in cfg["sample"]["strata"] and x.PER_CATEGORY == 9
    assert ">= 0.85 on at least 80 items" in cfg["verdict"]["pass"] and (x.TARGET, x.MIN_LABELLED) == (0.85, 80)


def test_a_label_digest_ignores_line_endings_and_order() -> None:
    assert x.label_digest({"F001": "none", "F002": "hype_only"}) == x.label_digest({"F002": "hype_only", "F001": "none"})
    assert x.label_digest({"F001": "none"}) != x.label_digest({"F001": "hype_only"})


def test_a_session_without_a_previous_one_is_an_error() -> None:
    with pytest.raises(ValueError):
        x.frame({D: ["AAA"]}, {}, items([]))


# ---- the draw ----------------------------------------------------------------------------------------------------

def _rows(n: int, cats: dict[str, int] | None = None) -> list[dict[str, Any]]:
    out, k = [], 0
    for c, m in (cats or {"none": n}).items():
        for _ in range(m):
            k += 1
            out.append({"id": k, "session": D, "symbol": "AAA", "headline": f"h{k}", "v3": c})
    return out


def test_the_draw_is_stratified_deterministic_and_numbered() -> None:
    rows = _rows(0, {"buyout_offer": 4, "earnings_release": 40, "none": 300})
    s1, b1 = x.draw(rows)
    s2, b2 = x.draw(list(reversed(rows)))                         # input order does not matter
    assert [r["id"] for r in s1] == [r["id"] for r in s2] and b1 == b2
    assert len(s1) == 100 and len({r["id"] for r in s1}) == 100
    assert sum(r["v3"] == "buyout_offer" for r in s1) == 4         # every buyout, fewer than 9
    assert sum(r["v3"] == "earnings_release" for r in s1) >= 9
    assert sorted(r["item_id"] for r in s1) == [f"F{i:03d}" for i in range(1, 101)]
    assert len(b1) == 30 and set(b1) <= {r["item_id"] for r in s1}


def test_the_draw_refuses_a_frame_smaller_than_the_sample() -> None:
    with pytest.raises(x.Refused):
        x.draw(_rows(99))


def test_the_classifier_is_read_by_its_sha256(tmp_path: Path) -> None:
    x.check_classifier(SPEC)
    other = tmp_path / "catalysts_spec.yaml"
    other.write_text(SPEC.read_text() + "\n# edited\n")
    with pytest.raises(x.Refused):
        x.check_classifier(other)


# ---- scoring -----------------------------------------------------------------------------------------------------

IDS = [f"F{i:03d}" for i in range(1, 101)]
BLIND = IDS[:30]


def test_reference_precedence_is_review_then_owner_blind_then_agent() -> None:
    ref = x.reference(["F001", "F002", "F003"], {"F001": "none", "F002": "none", "F003": "none"},
                      {"F001": "earnings_release", "F002": "hype_only"}, {"F001": "buyout_offer"})
    assert ref == {"F001": ("buyout_offer", "owner_review"), "F002": ("hype_only", "owner_blind"),
                   "F003": ("none", "agent_blind")}


def test_the_review_queue_holds_decision_level_disagreements_with_the_best_label() -> None:
    v3 = {"F001": "earnings_release", "F002": "hype_only", "F003": "earnings_release"}
    agent = {"F001": "none", "F002": "none", "F003": "fda_approval"}     # F002 and F003 agree at decision level
    assert x.review_queue(v3, agent, {}, {}) == ["F001"]
    assert x.review_queue(v3, agent, {"F001": "earnings_release"}, {}) == []   # the owner's blind label wins
    assert x.review_queue(v3, agent, {}, {"F001": "none"}) == []               # already ruled


def _score(agent_wrong: int = 0, owner_differs: int = 0, rulings: dict[str, str] | None = None,
           v3_wrong: int = 0) -> dict[str, Any]:
    v3 = {i: ("none" if k < v3_wrong else "earnings_release") for k, i in enumerate(IDS)}
    truth = dict.fromkeys(IDS, "earnings_release")
    agent = {i: ("none" if k >= len(IDS) - agent_wrong else truth[i]) for k, i in enumerate(IDS)}  # outside BLIND
    owner = {i: ("none" if k < owner_differs else truth[i]) for k, i in enumerate(BLIND)}
    review = rulings if rulings is not None else {i: truth[i] for i in x.review_queue(v3, agent, owner, {})}
    return x.score(v3, {"earnings_release": 500, "none": 500}, agent, BLIND, owner, review)


def test_all_agreeing_passes() -> None:
    rep = _score()
    assert rep["complete"] and rep["verdict"] == "pass" and rep["decision_level"]["share"] == 1.0


def test_v3_below_the_target_fails() -> None:
    rep = _score(v3_wrong=40)        # the owner rules each disagreement against v3
    assert rep["verdict"] == "fail" and rep["decision_level"]["hits"] == 60


def test_a_weak_labeller_check_is_not_decidable() -> None:
    rep = _score(owner_differs=5)    # agent matches the owner on 25 of 30 (0.83)
    assert rep["labeller_check"]["hits"] == 25 and rep["verdict"] == "not_decidable"


def test_a_missing_ruling_leaves_the_report_pending() -> None:
    rep = _score(agent_wrong=1, rulings={})
    assert not rep["complete"] and rep["missing"]["owner_rulings"] == 1 and rep["verdict"] == "pending"


def test_too_few_labelled_items_is_not_decidable() -> None:
    assert x.verdict(Share(79, 79), Share(30, 30)) == "not_decidable"
    assert x.verdict(Share(68, 80), Share(30, 30)) == "pass"
    assert x.verdict(Share(67, 80), Share(30, 30)) == "fail"


def test_labels_outside_the_spec_are_refused() -> None:
    with pytest.raises(ValueError):
        x.score({"F001": "none"}, {"none": 1}, {"F001": "good news"}, [], {}, {})


def test_public_outputs_refuse_text_fields() -> None:
    x.check_public({"items": [{"item_id": "F001", "archive_id": 3}], "counts": {"none": 1}})
    for bad in ({"headline": "x"}, {"items": [{"url": "x"}]}, {"catalyst_headline": "x"}):
        with pytest.raises(ValueError):
            x.check_public(bad)


# ---- the two scripts on a synthetic frame -------------------------------------------------------------------------

def _script(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _weekdays(a: dt.date, b: dt.date) -> list[dt.date]:
    return [a + dt.timedelta(days=i) for i in range((b - a).days + 1) if (a + dt.timedelta(days=i)).weekday() < 5]


def _world(tmp: Path, status: str = "ACCEPTED") -> dict[str, Path]:
    data, archive, priv, pub = tmp / "data", tmp / "archive", tmp / "private", tmp / "public"
    cal = _weekdays(dt.date(2026, 9, 21), dt.date(2026, 11, 25))
    (data / "edgar").mkdir(parents=True)
    (data / "edgar" / "sessions.json").write_text(json.dumps([str(d) for d in cal]))
    (data / "candidates").mkdir()
    rows, k = [], 0
    for d in cal:
        if d < x.FRAME[0]:
            continue
        pd.DataFrame({"symbol": ["AAA", "BBB", "CCC"]}).to_parquet(data / "candidates" / f"{d}.parquet")
        for s in ("AAA", "BBB", "CCC"):
            k += 1
            rows.append({"id": k, "created_at": f"{d}T12:00:00Z", "updated_at": f"{d}T12:00:00Z", "symbols": [s],
                         "headline": f"{s} reports third quarter results {k}" if k % 4 == 0 else f"{s} update {k}",
                         "source": "fiscal.ai", "url": ""})
    na.store(archive, rows)
    for day in na.days(dt.date(2026, 9, 25), dt.date(2026, 11, 25)):
        na._write_marker(archive, day, {"day": str(day)})
    dec = tmp / "DEC-0082.md"
    dec.write_text(f"# DEC-0082\n\n- **Status: {status} on 2026-11-27.** x\n")
    return {"data": data, "archive": archive, "private": priv, "public": pub, "decision": dec}


def _slots(w: dict[str, Path], who: str = "owner") -> None:
    (w["private"] / "owner_slots.json").write_text(json.dumps({"filled_by": who}))


def _args(w: dict[str, Path], *keys: str) -> list[str]:
    return [a for k in keys for a in (f"--{k}", str(w[k]))]


SAMPLE_KEYS = ("data", "archive", "private", "public", "decision")


def _rewrite(path: Path, col: str, fill: Any) -> None:
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r[col] = fill(r)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def test_the_sampler_refuses_before_acceptance(tmp_path: Path) -> None:
    w = _world(tmp_path, status="PROPOSED")
    assert _script("exp0058_sample").main(_args(w, *SAMPLE_KEYS)) == 2
    assert not w["private"].exists() and not w["public"].exists()


def test_the_sampler_refuses_an_incomplete_archive(tmp_path: Path) -> None:
    w = _world(tmp_path)
    na.marker_path(w["archive"], dt.date(2026, 10, 14)).unlink()
    assert _script("exp0058_sample").main(_args(w, *SAMPLE_KEYS)) == 2
    assert not w["private"].exists()


def test_sample_then_score_end_to_end(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    w = _world(tmp_path)
    sampler, scorer = _script("exp0058_sample"), _script("exp0058_score")
    assert sampler.main(_args(w, *SAMPLE_KEYS)) == 0
    assert sampler.main(_args(w, *SAMPLE_KEYS)) == 2                      # drawn once
    _slots(w)
    manifest = json.loads((w["public"] / "sample_manifest.json").read_text())
    text = (w["public"] / "sample_manifest.json").read_text()
    assert manifest["sample_n"] == 100 and len(manifest["owner_blind_ids"]) == 30
    assert "update" not in text and "quarter" not in text                 # no headline text in public
    out = capsys.readouterr().out
    assert "update" not in out and not any(c in out for c in x.CATS)      # no text, no category tally
    score_args = _args(w, "private", "public")

    assert scorer.main(score_args) == 2                                   # no labels yet
    key = {r["item_id"]: r["v3_category"] for r in csv.DictReader(open(w["private"] / "sample_key.csv"))}
    first = next(i for i in sorted(key) if i not in manifest["owner_blind_ids"])
    _rewrite(w["private"] / "agent_labels.csv", "agent_label",
             lambda r: ("buyout_offer" if r["item_id"] == first else key[r["item_id"]]))
    _rewrite(w["private"] / "owner_blind.csv", "owner_label", lambda r: key[r["item_id"]])
    assert scorer.main(score_args) == 0                                   # locks the labels, writes the queue
    assert (w["private"] / "labels_lock.json").exists()
    queue = list(csv.DictReader(open(w["private"] / "owner_review.csv")))
    assert [r["item_id"] for r in queue] == [first]
    assert scorer.main([*score_args, "--final"]) == 2                     # a ruling is missing
    _rewrite(w["private"] / "owner_review.csv", "owner_verdict", lambda r: key[r["item_id"]])

    agent_bytes = (w["private"] / "agent_labels.csv").read_bytes()
    (w["private"] / "agent_labels.csv").write_bytes(agent_bytes.replace(b"buyout_offer", b"none"))
    assert scorer.main(score_args) == 2                                   # labels changed after the lock
    (w["private"] / "agent_labels.csv").write_bytes(agent_bytes)

    assert scorer.main([*score_args, "--final"]) == 0
    rep = json.loads((w["public"] / "report.json").read_text())
    assert rep["verdict"] == "pass" and rep["labelled_n"] == 100
    assert "update" not in (w["public"] / "report.md").read_text()
    assert scorer.main([*score_args, "--final"]) == 2                     # written once


def test_the_scorer_refuses_a_changed_sample(tmp_path: Path) -> None:
    w = _world(tmp_path)
    assert _script("exp0058_sample").main(_args(w, *SAMPLE_KEYS)) == 0
    p = w["private"] / "sample_key.csv"
    p.write_text(p.read_text().replace("none", "hype_only", 1))
    assert _script("exp0058_score").main(_args(w, "private", "public")) == 2


def test_publish_commits_only_the_named_folder(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def git(args: list[str], cwd: Path) -> str:
        calls.append(args)
        if args[:2] == ["remote", "get-url"]:
            return "https://github.com/Algorythmos-AI/trading-news-archive.git\n"
        return " M experiments/EXP-0058/x\n" if args[0] == "status" else ""

    (tmp_path / ".git").mkdir()
    assert na.publish(tmp_path, "m", git, folder="experiments/EXP-0058") is True
    assert ["add", "--", "experiments/EXP-0058"] in calls
    assert next(c for c in calls if "commit" in c)[-2:] == ["--", "experiments/EXP-0058"]
    with pytest.raises(na.ArchiveError):
        na.publish(tmp_path, "m", git, folder="../elsewhere")


def test_a_bad_label_is_refused_before_anything_is_locked(tmp_path: Path) -> None:
    w = _world(tmp_path)
    assert _script("exp0058_sample").main(_args(w, *SAMPLE_KEYS)) == 0
    _slots(w)
    _rewrite(w["private"] / "agent_labels.csv", "agent_label", lambda r: "none")
    _rewrite(w["private"] / "owner_blind.csv", "owner_label", lambda r: "earnings")   # not a spec category
    assert _script("exp0058_score").main(_args(w, "private", "public")) == 2
    assert not (w["private"] / "labels_lock.json").exists() and not (w["private"] / "owner_review.csv").exists()


def test_a_resaved_label_file_with_crlf_is_not_a_change(tmp_path: Path) -> None:
    w = _world(tmp_path)
    assert _script("exp0058_sample").main(_args(w, *SAMPLE_KEYS)) == 0
    _slots(w)
    _rewrite(w["private"] / "agent_labels.csv", "agent_label", lambda r: "none")
    _rewrite(w["private"] / "owner_blind.csv", "owner_label", lambda r: "none")
    scorer = _script("exp0058_score")
    assert scorer.main(_args(w, "private", "public")) == 0
    p = w["private"] / "owner_blind.csv"
    p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    assert scorer.main(_args(w, "private", "public")) == 0


def test_the_report_names_who_filled_the_owner_slots_and_lists_checksums_safely(tmp_path: Path) -> None:
    w = _world(tmp_path)
    assert _script("exp0058_sample").main(_args(w, *SAMPLE_KEYS)) == 0
    key = {r["item_id"]: r["v3_category"] for r in csv.DictReader(open(w["private"] / "sample_key.csv"))}
    _rewrite(w["private"] / "agent_labels.csv", "agent_label", lambda r: key[r["item_id"]])
    _rewrite(w["private"] / "owner_blind.csv", "owner_label", lambda r: key[r["item_id"]])
    _slots(w, "an independent expert agent")
    assert _script("exp0058_score").main([*_args(w, "private", "public"), "--final"]) == 0
    rep = json.loads((w["public"] / "report.json").read_text())
    assert rep["owner_slots_filled_by"] == "an independent expert agent"
    assert "owner_only" not in rep and "v3_vs_owner_slot" in rep
    assert set(rep["reference_sources"]) <= {"owner_slot_review", "owner_slot_blind", "agent_blind"}
    assert rep["labeller_check_compares"] == "agent_blind vs owner slot (an independent expert agent)"
    assert "an independent expert agent" in (w["public"] / "report.md").read_text()
    assert {f["file"] for f in rep["private_files"]} >= {"sample_key.csv", "owner_blind.csv"}
    assert '_key.csv": "' not in (w["public"] / "report.json").read_text()


def test_the_scorer_refuses_without_saying_who_filled_the_owner_slots(tmp_path: Path) -> None:
    w = _world(tmp_path)
    assert _script("exp0058_sample").main(_args(w, *SAMPLE_KEYS)) == 0
    _rewrite(w["private"] / "agent_labels.csv", "agent_label", lambda r: "none")
    _rewrite(w["private"] / "owner_blind.csv", "owner_label", lambda r: "none")
    assert _script("exp0058_score").main(_args(w, "private", "public")) == 2
    assert not (w["private"] / "labels_lock.json").exists()
    _slots(w, " ")
    assert _script("exp0058_score").main(_args(w, "private", "public")) == 2
