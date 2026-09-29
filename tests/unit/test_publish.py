"""Dashboard publisher (PR 6): nothing restricted or private leaves the machine, and the contract holds."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest
import requests

from wt.core.clock import ET
from wt.ops import publish
from wt.ops.publish import ALLOW, LeakIndex, Sanitizer, build, from_docs, to_schema, validate
from wt.ops.safeio import Redactor
from wt.ops.window import sessions_from_calendar

DASH = Path(__file__).resolve().parents[2] / "dashboard"
NOW = dt.datetime(2026, 9, 29, 21, 45, tzinfo=dt.UTC)


def docs_with_restricted_fields() -> dict:
    return {
        "meta": {"collector": {"sha": "abc1234", "branch": "main", "dirty": False}, "exit_code": 0,
                 "sources": {"research": {"ok": True, "stale": False, "as_of": "x", "error": None, "ms": 5}}},
        "overview": {"headline": "No proven edge yet.", "subline": "", "kpis": [], "gates": [],
                     "needs_you": [{"id": "webull-key", "title": "Reset the key", "why": "exposed", "severity": "high"},
                                   {"id": "swap", "title": "Close apps", "why": "swap high", "severity": "high",
                                    "rank": 1, "manual": False, "link": "https://claude.ai/private"}],
                     "secret_field": "never listed"},
        "research": {"decisions": [{"id": "DEC-0001", "title": "Course-derived decision title", "date": "2026-09-27",
                                    "status": "recorded"}],
                     "hypotheses": [{"id": "HYP-0010", "name": "Setup name from the course", "statement": "rule text",
                                     "status": "pre-registered", "stale": False}],
                     "round3": [{"id": "HYP-0010", "name": "Gap and Go 1", "set": "F", "hyp_status": "x", "run": True}],
                     "cat01": {"accuracy_pct": 84.0, "review_url": "https://claude.ai/artifact/abc", "decisive_items": [1]},
                     "lessons": ["LL-0001 text", "LL-0002 text"], "scoreboard": [], "trials": {"used": 75}},
        "spec": {"spec_id": "SPEC-0001", "title": "Course methodology", "open": [{"req_id": "R1", "statement": "x"}],
                 "checklist": [{"item": "Course checklist item", "total": 4, "implemented": 2, "state": "partial",
                                "reqs": ["R1"], "missing": ["R2"]}], "total": 112},
        "ops": {"deployed": {"head": "abc1234", "subject": "commit subject", "missing": [{"sha": "1", "subject": "s"}],
                             "behind": 1},
                "routine": {"stages": [{"stage": "tier1", "tier1": [{"symbol": "ABCD", "score": 0.9,
                                                                      "headlines": ["Third-party news text"]}]}],
                            "log": {"file": "routine.log", "exists": True, "last": ["/Users/x/trading line"],
                                    "errors": ["Traceback one", "ValueError: last one"]}},
                "paper": {"virtual": {"equity": 600.0, "latched": False}, "log": None},
                "forward": {"strategies": [{"strategy": "r3:MP-1", "n": 2, "mean_r": 0.5, "total_r": 1.0}]}},
        "platform": {}, "history": {"legacy": {"total": 31, "recent": [{"summary": "old decision log text"}]}},
    }


def sanitizer(leak: LeakIndex | None = None, strict: bool = False) -> Sanitizer:
    return Sanitizer(Redactor(set(), home="/Users/x"), leak, strict)


def snapshot(**kw) -> dict:
    return build(docs_with_restricted_fields(), {}, sanitizer(**kw), "run-1", NOW)


def paths(v, prefix=""):
    if isinstance(v, dict):
        for k, x in v.items():
            yield f"{prefix}.{k}"
            yield from paths(x, f"{prefix}.{k}")
    elif isinstance(v, list):
        for x in v:
            yield from paths(x, f"{prefix}[]")


def test_restricted_and_private_fields_never_reach_the_snapshot():
    s = snapshot()
    keys = set(paths(s))
    for forbidden in (".research.decisions[].title", ".research.hypotheses[].name", ".research.hypotheses[].statement",
                      ".research.round3[].name", ".research.cat01.review_url", ".research.cat01.decisive_items",
                      ".spec.title", ".spec.open", ".spec.checklist[].item", ".spec.checklist[].missing",
                      ".ops.deployed.subject", ".ops.deployed.missing", ".ops.routine.stages[].tier1[].headlines",
                      ".ops.routine.log.last", ".overview.secret_field", ".overview.needs_you[].link",
                      ".research.lessons", ".history.legacy.recent"):
        assert forbidden not in keys, forbidden
    assert [a["id"] for a in s["overview"]["needs_you"]] == ["swap"]          # webull-key is private
    assert s["research"]["decisions"] == [{"id": "DEC-0001", "date": "2026-09-27", "status": "recorded"}]
    assert s["research"]["lessons_count"] == 2
    assert s["ops"]["routine"]["log"] == {"file": "routine.log", "exists": True, "bytes": None, "modified": None,
                                          "errors_count": 2, "last_error": "ValueError: last one"}
    assert validate(s) == []


def test_type_coercion_is_strict():
    san = sanitizer()
    assert san.apply(publish.N, float("nan")) is None and san.apply(publish.N, True) is None
    assert san.apply(publish.I, 3.0) == 3 and san.apply(publish.I, 3.5) is None and san.apply(publish.I, False) is None
    assert san.apply(publish.B, 1) is None and san.apply(publish.S, {"x": 1}) is None
    assert len(san.apply(publish.T, "y" * 1000)) == publish.TEXT_MAX


def test_text_is_redacted(tmp_path):
    san = Sanitizer(Redactor({"supersecretvalue123"}, home="/Users/x"), None, False)
    assert san.apply(publish.T, "key supersecretvalue123 in /Users/x/trading/logs") == "key [redacted] in ~/trading/logs"


def test_leak_check_withholds_text_copied_from_the_corpus(tmp_path):
    corpus = tmp_path / "course.txt"
    corpus.write_text("Only buy the stock when it breaks the high of the first pullback candle on volume.")
    leak = LeakIndex([corpus], cache=tmp_path / "cache")
    san = sanitizer(leak=leak)
    assert san.apply(publish.T, "Rule: only buy the stock when it breaks the high of the day") is None
    assert san.apply(publish.T, "Round 3 re-tests gap-and-go under SPEC-0001") is not None
    assert san.withheld == 1
    again = LeakIndex([corpus], cache=tmp_path / "cache")                      # served from the cache
    assert again.leaks("buy the stock when it breaks the high of")


def test_strict_mode_drops_free_text_but_keeps_ids_and_numbers():
    s = snapshot(strict=True)
    assert s["redaction"] == "strict" and s["overview"].get("headline") is None
    assert s["research"]["decisions"][0]["id"] == "DEC-0001" and s["spec"]["total"] == 112
    assert validate(s) == []


def test_committed_schema_matches_the_allowlist():
    committed = json.loads((DASH / "src/lib/snapshot.schema.json").read_text())
    assert committed == to_schema(ALLOW), "run `make schema` and commit the result"


def test_fixture_is_valid_and_hmac_vectors_match():
    assert validate(json.loads((DASH / "test/fixtures/snapshot.json").read_text())) == []
    for v in json.loads((DASH / "test/fixtures/hmac_vectors.json").read_text()):
        assert publish.sign(v["body"].encode(), v["secret"], v["ts"]) == v["signature"]


def test_private_action_ids_come_from_config(tmp_path):
    cfg = tmp_path / "d.yaml"
    cfg.write_text("manual_actions:\n  - {id: a, private: true}\n  - {id: b}\n")
    assert publish.private_action_ids(cfg) == {"a"}
    assert publish.private_action_ids(tmp_path / "missing.yaml") == {"webull-key"}      # fail closed


def test_expected_windows_run_from_0730_et_to_close_plus_two_hours():
    sessions = sessions_from_calendar([{"date": "2026-09-30", "open": "09:30", "close": "16:00"},
                                       {"date": "2026-10-09", "open": "09:30", "close": "16:00"}])
    w = publish.expected_windows(dt.datetime(2026, 9, 29, 22, 0, tzinfo=dt.UTC), sessions)
    assert w == [{"session": "2026-09-30",
                  "start": dt.datetime(2026, 9, 30, 7, 30, tzinfo=ET).astimezone(dt.UTC).isoformat(),
                  "end": dt.datetime(2026, 9, 30, 18, 0, tzinfo=ET).astimezone(dt.UTC).isoformat()}]


def test_forward_series_is_cumulative_per_strategy(tmp_path):
    led = tmp_path / "l.jsonl"
    led.write_text("\n".join(json.dumps(r) for r in [
        {"session": "2026-09-28", "strategy": "A", "R": 1.0}, {"session": "2026-09-28", "strategy": "A", "R": -0.5},
        {"session": "2026-09-29", "strategy": "A", "R": 2.0}, {"session": "2026-09-29", "strategy": "B", "R": -1.0},
        {"session": "2026-09-29", "session_marker": True, "n_trades": 2}]))
    assert publish.forward_series(led) == [
        {"strategy": "A", "session": "2026-09-28", "n": 2, "cum_r": 0.5},
        {"strategy": "A", "session": "2026-09-29", "n": 1, "cum_r": 2.5},
        {"strategy": "B", "session": "2026-09-29", "n": 1, "cum_r": -1.0}]


class _Resp:
    def __init__(self, code: int, text: str = "") -> None:
        self.status_code, self.text = code, text


@pytest.mark.parametrize("codes, ok, calls", [([200], True, 1), ([409], True, 1), ([401], False, 1),
                                              ([500, 502, 200], True, 3), ([500, 500, 500], False, 3)])
def test_send_retries_transient_errors_only(monkeypatch, codes, ok, calls):
    seen = []

    def post(url, data, headers, timeout):
        seen.append(headers)
        return _Resp(codes[len(seen) - 1])
    monkeypatch.setattr(publish.requests, "post", post)
    monkeypatch.setattr(publish.time, "sleep", lambda s: None)
    got, _ = publish.send(b"{}", "https://x/api/ingest", "secret", "bypass")
    assert got is ok and len(seen) == calls
    assert seen[0]["x-vercel-protection-bypass"] == "bypass" and seen[0]["x-wt-signature"].startswith("sha256=")


def test_send_survives_network_errors(monkeypatch):
    def post(*a, **k):
        raise requests.ConnectionError("down")
    monkeypatch.setattr(publish.requests, "post", post)
    monkeypatch.setattr(publish.time, "sleep", lambda s: None)
    assert publish.send(b"{}", "https://x", "s", None) == (False, "ConnectionError")


def test_from_docs_drops_nothing_it_does_not_know_about_silently():
    raw = from_docs(docs_with_restricted_fields(), private_ids={"webull-key"})
    assert raw["overview"]["needs_you"][0]["id"] == "swap"
    assert raw["research"]["lessons_count"] == 2
