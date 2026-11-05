"""The external-trader post records under research/external/: valid, consistent, and in step with their docs."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from wt.research import external_posts as ep

ROOT = Path(__file__).resolve().parents[2]
RECORDS = sorted(p.parent for p in (ROOT / "research/external").glob("*/posts"))
CITING_DOCS = ("README.md", "rules.md", "method.md", "timeline.md", "comparison.md", "options-playbook.md")
POST_ID = re.compile(r"\b(\d{18,20})\b")


def test_there_is_a_record():
    assert RECORDS, "research/external/<source>/posts/ is missing"


@pytest.fixture(params=RECORDS, ids=lambda p: p.name)
def record(request: pytest.FixtureRequest) -> Path:
    return request.param  # type: ignore[no-any-return]


def test_every_row_matches_the_schema(record: Path):
    validator = Draft202012Validator(json.loads((record / "schema.json").read_text()))
    bad = [(r["id"], e.message) for r in ep.load(record / "posts") for e in validator.iter_errors(r)]
    assert bad == [], bad[:5]


def test_files_are_months_sorted_unique_and_small(record: Path):
    seen: set[str] = set()
    for f in sorted((record / "posts").glob("*.jsonl")):
        assert f.stat().st_size < 500_000, f"{f.name} is over the 500 KB pre-commit limit; split it"
        rows = [json.loads(line) for line in f.read_text(encoding="utf-8").splitlines()]
        assert rows, f"{f.name} is empty"
        assert all(r["month"] == f.stem for r in rows), f"{f.name} holds a post from another month"
        keys = [(r["ts_utc"], r["id"]) for r in rows]
        assert keys == sorted(keys), f"{f.name} is not sorted by time"
        ids = {r["id"] for r in rows}
        assert len(ids) == len(rows) and not ids & seen, f"{f.name} repeats a post id"
        seen |= ids


def test_mechanical_fields_are_what_the_module_computes(record: Path):
    """Nobody hand-edits ts_et, session, text_clean or symbols: a rule change goes through the module."""
    for r in ep.load(record / "posts"):
        raw = {k: r[k] for k in ep.RAW_FIELDS}
        assert {k: r[k] for k in ep.mechanical(raw)} == ep.mechanical(raw), r["id"]


def test_every_post_is_coded(record: Path):
    uncoded = [r["id"] for r in ep.load(record / "posts") if r["kind"] == "uncoded"]
    assert uncoded == [], f"{len(uncoded)} posts not coded yet, e.g. {uncoded[:3]}"


def test_post_ids_cited_in_the_docs_exist(record: Path):
    ids = {r["id"] for r in ep.load(record / "posts")}
    for name in CITING_DOCS:
        doc = record / name
        if doc.exists():
            missing = sorted(set(POST_ID.findall(doc.read_text(encoding="utf-8"))) - ids)
            assert missing == [], f"{name} cites posts not in the record: {missing[:5]}"


def test_stats_are_generated_from_the_posts(record: Path):
    want = ep.stats_markdown(ep.load(record / "posts"))
    assert (record / "stats.md").read_text(encoding="utf-8") == want, \
        "run `python scripts/external_posts.py stats <record>` and commit stats.md"


# ---- the mechanical rules --------------------------------------------------------------------------------------

def test_session_follows_new_york_time_across_dst():
    assert ep.session_of(ep.ts_et("2026-01-05T14:45:00Z")) == "rth_open"      # 09:45 EST
    assert ep.session_of(ep.ts_et("2026-07-06T13:45:00Z")) == "rth_open"      # 09:45 EDT
    assert ep.session_of(ep.ts_et("2026-07-06T12:00:00Z")) == "pre"
    assert ep.session_of(ep.ts_et("2026-07-06T19:30:00Z")) == "rth_close"
    assert ep.session_of(ep.ts_et("2026-07-04T15:00:00Z")) == "overnight"     # Saturday


def test_symbols_fold_futures_spellings_and_skip_jargon():
    got = ep.symbols_of("Long /MNQ and $NQ, NQZ5 too; $SPX not $SPY? $PDH $AAPL /ES")
    assert [s["symbol"] for s in got] == ["NQ", "SPX", "SPY", "AAPL", "ES"]
    assert {s["symbol"]: s["asset"] for s in got} == {"NQ": "future", "SPX": "index", "SPY": "etf",
                                                      "AAPL": "equity", "ES": "future"}


def test_clean_text_drops_links_and_stubs():
    assert ep.clean_text("Prep is LIVE youtu.be/qB37UMKIwsE\n now https://t.co/x x.com/Desi_Trade/sta…") == \
        "Prep is LIVE now"


def test_apply_codes_keeps_signal_in_step_with_kind(tmp_path: Path):
    raw = {"id": "1", "url": "https://x.com/Desi_Trade/status/1", "ts_utc": "2026-01-05T15:00:00.000Z",
           "text": "B&R of PDH on $META", "quoted_id": None, "quoted_text": None, "image_ids": [], "has_video": False}
    ep.build(tmp_path, [[raw]])
    ep.apply_codes(tmp_path, [{"id": "1", "kind": "trade", "setups": ["BR"], "lesson": "Buy the retest that holds."}])
    (row,) = ep.load(tmp_path)
    assert row["signal"] is True and row["setups"] == ["BR"]
    ep.build(tmp_path, [[raw]])                                               # a rebuild keeps the codes
    assert ep.load(tmp_path)[0]["setups"] == ["BR"]
    with pytest.raises(ValueError):
        ep.apply_codes(tmp_path, [{"id": "1", "text": "edited"}])
