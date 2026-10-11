"""Building the Options edition from the after-close pulls (wt.options.edition, scripts/options_edition.py).

All pulls are synthetic and seeded. Agreement with the scripts the routine ran before this moved here was checked
outside the repo on four runs of ten names (levels files, both logs and the edition: no difference)."""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import random
from pathlib import Path

import jsonschema
import pytest
import yaml

from test_options_levels import synth          # conftest puts tests/unit on the path
from wt.ops import publish
from wt.options import edition
from wt.options import levels as lv

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = json.loads((ROOT / "dashboard" / "src" / "lib" / "options.schema.json").read_text())
RULES = json.loads((ROOT / "config" / "options_rules.json").read_text())
DESK = yaml.safe_load((ROOT / "config" / "options_desk.yaml").read_text())
NAMES = ["AAA", "BBB", "CCC", "DDD"]
NOW = dt.datetime(2026, 10, 9, 22, 0)                    # Friday, after the close is final
_spec = importlib.util.spec_from_file_location("options_edition", ROOT / "scripts" / "options_edition.py")
assert _spec and _spec.loader
script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(script)


def pulls(names=NAMES, finished="2026-10-09", hours=7):
    daily, hourly, snaps = {}, {}, {}
    for i, name in enumerate(names):
        d = synth(i, start=50.0 + 40 * i)
        daily[name] = {**d, "chart_step": 86400}
        rng = random.Random(i)
        px = d["close"][-1]
        h: dict[str, list] = {"chart_step": 3600, "time": [], "open": [], "high": [], "low": [], "close": []}
        for day in (lv.prev_session(finished), finished):
            for k in range(hours):
                c = px * (1 + (rng.random() - 0.5) * 0.02)
                for key, v in zip(("time", "open", "high", "low", "close"),
                                  (f"{day}T{9 + k}:30:00", px, max(px, c) * 1.002, min(px, c) * 0.998, c), strict=True):
                    h[key].append(v)
                px = c
        hourly[name] = h
        snaps[name] = {"last": {"price": px, "ts": "t"},
                       "implied-vol-underlying": {"is_valid": True, "daily_iv": 0.012, "annual_iv": 0.2 + i / 50},
                       "implied-volatility-percentile": {"high_13w": 0.4, "high_26w": 0.3, "high_52w": 0.1 * i},
                       "historical-vol": {"annual_pct": 18.0},
                       "underlying-today-option-volume": {"callVolume": 10, "putVolume": 12},
                       "underlying-avg-option-volume": {"avgCallVolume": 9, "avgPutVolume": 8}}
    return daily, hourly, snaps


def built(run, when=dt.datetime(2026, 10, 9, 22, 5, 7, 99, tzinfo=dt.UTC)):
    assert run.levels_doc is not None
    return edition.build_edition(run.levels_doc, [{k: "" if v is None else str(v) for k, v in r.items()} for r in run.iv_rows],
                                 [{k: str(v) for k, v in r.items()} for r in run.scorecard_rows], RULES, when)


def test_the_session_just_finished_is_the_last_whose_close_is_final():
    assert edition.finished_session(dt.datetime(2026, 10, 9, 22, 0)) == "2026-10-09"
    assert edition.finished_session(dt.datetime(2026, 10, 9, 20, 14)) == "2026-10-08"      # a minute early
    assert edition.finished_session(dt.datetime(2026, 10, 10, 15, 0)) == "2026-10-09"      # Saturday
    assert edition.finished_session(dt.datetime(2026, 11, 27, 18, 15)) == "2026-11-27"     # half day, final at 13:15 ET
    assert edition.finished_session(dt.datetime(2026, 11, 26, 22, 0)) == "2026-11-25"      # Thanksgiving
    # A weekend with Monday's levels already there is nothing new; before they exist it is still a run to make.
    sat = dt.datetime(2026, 10, 10, 15, 0)
    assert edition.nothing_new(sat, lambda s: s == "2026-10-12") and not edition.nothing_new(sat, lambda s: False)
    assert not edition.nothing_new(NOW, lambda s: True)                                    # a session day always runs


def test_a_run_builds_next_sessions_levels_the_volatility_rows_and_the_scorecard():
    daily, hourly, snaps = pulls()
    run = edition.run(NAMES, daily, hourly, snaps, NOW)
    assert (run.finished, run.session, run.stamp) == ("2026-10-09", "2026-10-12", "2026-10-09T22:00Z")
    assert list(run.tickers) == NAMES and run.problems == {} and run.failed == []
    doc = run.levels_doc
    assert doc is not None and doc["schema"] == "stocksdelta/options-levels" and doc["built_from"] == "2026-10-09"
    t = doc["tickers"]["AAA"]
    assert t["from_bar"] == "2026-10-09" and len(t["recent"]) == 40 and t["recent"][-1][0] == "2026-10-09"
    assert t["expected_move"]["day"] == round(lv.expected_move(t["last"]["close"], 0.2, 1), 2)
    assert json.loads(json.dumps(doc)) == doc                                             # plain data, ready to store
    assert [r["ticker"] for r in run.iv_rows] == NAMES and set(run.iv_rows[0]) == set(edition.IV_FIELDS)
    assert run.scorecard_rows and all(set(r) == set(edition.SC_FIELDS) and r["session"] == "2026-10-09" for r in run.scorecard_rows)
    assert edition.run(NAMES, daily, hourly, snaps, NOW) == run                           # the same pulls, the same run


def test_what_is_missing_is_reported_for_its_name_and_only_missing_bars_fail_the_run():
    daily, hourly, snaps = pulls()
    del daily["BBB"]                                         # no bars at all: nothing can be built
    snaps["CCC"]["implied-vol-underlying"]["is_valid"] = False
    del hourly["DDD"]
    run = edition.run(NAMES, daily, hourly, snaps, NOW)
    assert list(run.tickers) == ["AAA", "CCC", "DDD"] and run.failed == ["BBB"]
    assert run.problems == {"BBB": ["no daily bars in transcript"],
                            "CCC": ["no valid implied-vol snapshot (levels still written)"],
                            "DDD": ["no hourly bars; scorecard skipped"]}
    assert run.tickers["CCC"]["expected_move"] is None and "CCC" not in {r["ticker"] for r in run.iv_rows}
    stale = edition.run(NAMES, *pulls(), dt.datetime(2026, 10, 12, 22, 0))               # Monday's run on Friday's bars
    assert stale.tickers == {} and stale.levels_doc is None and len(stale.failed) == 4
    assert "expected 2026-10-12" in stale.problems["AAA"][0]
    thin = edition.run(NAMES, *pulls(hours=4), NOW)
    assert "only 4 hourly bars" in thin.problems["AAA"][0] and thin.scorecard_rows == []


def test_the_edition_is_one_the_dashboard_accepts_and_carries_what_the_run_found():
    run = edition.run(NAMES, *pulls(), NOW)
    doc = built(run)
    jsonschema.Draft7Validator(SCHEMA).validate(doc)
    assert doc["schema"] == "stocksdelta/options" and doc["schema_version"] == 1
    assert (doc["session"], doc["built_from"], doc["run_id"]) == ("2026-10-12", "2026-10-09", "options-2026-10-12-20261009T220507")
    assert doc["as_of"] == "2026-10-09T22:05:07+00:00"
    assert [t["symbol"] for t in doc["tickers"]] == NAMES
    t = doc["tickers"][1]
    assert len(t["bars"]) == 40 and set(t["bars"][0]) == {"d", "o", "h", "l", "c"}
    assert t["expected_move"]["iv_pct_52w"] == 0.1 and t["expected_move"]["annual_iv"] == 0.22
    assert all(set(z) <= set(edition.ZONE_KEYS) for z in t["zones"]) and all("tf" in x for x in t["levels"])
    assert [r["id"] for r in doc["rules"]] == [r["id"] for r in RULES["rules"]]
    n = sum(r["live"]["n"] for r in doc["rules"])
    assert n == len(run.scorecard_rows) == len(doc["paper"]) and all(r["live"]["wins"] <= r["live"]["n"] for r in doc["rules"])
    assert doc["paper"] == sorted(doc["paper"], key=lambda x: x["session"], reverse=True)
    assert built(run) == doc                                 # built twice, the same document


def test_the_rules_file_and_the_desk_file_say_what_the_engine_expects():
    from wt.options import rules as engine_rules
    assert [r["id"] for r in RULES["rules"]] == list(engine_rules.RULES)
    assert all(r["status"] == "probation" and r["side"] in ("call", "put") for r in RULES["rules"])
    assert set(DESK["contracts"]) == set(DESK["names"]) and all(isinstance(v, int) for v in DESK["contracts"].values())


def test_the_two_logs_take_each_row_once(tmp_path):
    run = edition.run(NAMES, *pulls(), NOW)
    iv, sc = tmp_path / "data" / "iv_history.csv", tmp_path / "data" / "scorecard.csv"
    assert edition.append_unique(iv, edition.IV_FIELDS, run.iv_rows, edition.IV_KEY) == 4
    assert edition.append_unique(iv, edition.IV_FIELDS, run.iv_rows, edition.IV_KEY) == 0
    assert edition.append_unique(sc, edition.SC_FIELDS, run.scorecard_rows, edition.SC_KEY) == len(run.scorecard_rows)
    assert edition.append_unique(sc, edition.SC_FIELDS, run.scorecard_rows, edition.SC_KEY) == 0
    assert [r["ticker"] for r in edition.read_csv(iv)] == NAMES and edition.read_csv(tmp_path / "none.csv") == []
    again = built(run)
    stored = edition.build_edition(run.levels_doc, edition.read_csv(iv), edition.read_csv(sc), RULES,
                                   dt.datetime(2026, 10, 9, 22, 5, 7, tzinfo=dt.UTC))
    assert stored == again                                   # through the files or straight from the run: the same


def test_pulls_are_read_out_of_a_transcript_by_contract_id_latest_first_and_after_a_time():
    daily, hourly, snaps = pulls(["AAA"])

    def call(uid, tool, cid, result, ts="2026-10-09T21:55:00Z", saved=None):
        text = f"Result saved to {saved}" if saved else json.dumps(result)
        return [json.dumps({"timestamp": ts, "message": {"content": [{"type": "tool_use", "id": uid, "name": f"mcp__x__{tool}",
                                                                     "input": {"contract_id": cid}}]}}),
                json.dumps({"timestamp": ts, "message": {"content": [{"type": "tool_result", "tool_use_id": uid,
                                                                     "content": [{"type": "text", "text": text}]}]}})]
    old = {**daily["AAA"], "close": [1.0] * len(daily["AAA"]["close"])}
    lines = [*call("a", "get_price_history", 11, old, ts="2026-10-08T21:00:00Z"),
             *call("b", "get_price_history", 11, daily["AAA"]), *call("c", "get_price_history", 11, None, saved="/big/h.txt"),
             *call("d", "get_price_snapshot", 11, snaps["AAA"]), *call("e", "get_price_snapshot", 11, {"last": {}}),
             *call("f", "get_price_history", 99, daily["AAA"]), "not json", json.dumps({"message": "text"}), json.dumps([1])]
    files = {"/big/h.txt": json.dumps(hourly["AAA"])}
    got = edition.extract_transcript(lines, {"11": "AAA"}, read=files.get)
    assert got == ({"AAA": daily["AAA"]}, {"AAA": hourly["AAA"]}, {"AAA": snaps["AAA"]})
    assert edition.extract_transcript(lines, {"11": "AAA"}, since_ts="2026-10-10", read=files.get) == ({}, {}, {})
    early = edition.extract_transcript(lines[:2], {"11": "AAA"}, read=files.get)
    assert early[0]["AAA"]["close"][0] == 1.0


def write_pulls(folder: Path, names=None):
    names = names or DESK["names"]
    folder.mkdir(parents=True, exist_ok=True)
    daily, hourly, snaps = pulls(names)
    for kind, got in (("daily", daily), ("hourly", hourly), ("snapshot", snaps)):
        for name, d in got.items():
            (folder / f"{name}.{kind}.json").write_text(json.dumps(d))


def test_the_script_builds_from_a_folder_of_pulls_twice_the_same_and_sends_only_when_told(tmp_path, monkeypatch, capsys):
    write_pulls(tmp_path / "pulls")
    (tmp_path / "pulls" / "SPY.snapshot.json").write_text("{torn")           # one unreadable pull is one name's problem
    args = ["--pulls", str(tmp_path / "pulls"), "--data", str(tmp_path / "data"), "--now", "2026-10-09T22:00:00"]
    monkeypatch.setattr(publish, "send", lambda *a, **k: pytest.fail("sent on a dry run"))
    out = tmp_path / "edition.json"
    assert script.main([*args, "--dry-run", "--out", str(out)]) == 0
    first = json.loads(out.read_text())
    jsonschema.Draft7Validator(SCHEMA).validate(first)
    assert [t["symbol"] for t in first["tickers"]] == DESK["names"] and first["tickers"][0]["expected_move"] is None
    rows = (tmp_path / "data" / "scorecard.csv").read_text()
    assert script.main([*args, "--dry-run", "--out", str(out)]) == 0
    second = json.loads(out.read_text())
    assert (tmp_path / "data" / "scorecard.csv").read_text() == rows          # a second run adds nothing
    assert {k: v for k, v in first.items() if k not in ("run_id", "as_of")} == {k: v for k, v in second.items() if k not in ("run_id", "as_of")}
    assert "iv_rows+=0 scorecard+=0" in capsys.readouterr().out

    for name in ("RADAR_INGEST_SECRET", "VERCEL_AUTOMATION_BYPASS_SECRET", "DASHBOARD_INGEST_URL"):
        monkeypatch.delenv(name, raising=False)
    assert script.main([*args, "--send"]) == 3                                # no secrets: built, not sent, and it says so
    assert "RADAR_INGEST_SECRET" in capsys.readouterr().err
    sent = []
    monkeypatch.setenv("RADAR_INGEST_SECRET", "s" * 24)
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "b" * 24)
    monkeypatch.setattr(publish, "send", lambda body, url, secret, bypass, **k: sent.append((url, k)) or (True, "HTTP 200"))
    assert script.main([*args, "--send"]) == 0
    assert sent == [("https://lab.algorythmos.com/api/ingest", {"key_id": "radar"})]
    text = capsys.readouterr()
    assert "s" * 24 not in text.out + text.err and "b" * 24 not in text.out + text.err
    assert "dashboard: stored (http_200)" in text.out
    for ok, detail, code in ((False, 'HTTP 422: {"errors": ["/tickers/0: response text"]}', "http_422"),
                             (True, 'HTTP 409: {"status":"older","run_id":"response text"}', "http_409"),
                             (False, "ConnectTimeout", "network_ConnectTimeout")):
        monkeypatch.setattr(publish, "send", lambda *a, _r=(ok, detail), **k: _r)
        assert script.main([*args, "--send"]) == 1                           # a newer edition already there is not "stored"
        out = capsys.readouterr().out
        assert f"NOT stored ({code})" in out and "response text" not in out  # the code, never the response's text


def test_the_script_fails_on_a_name_it_could_not_build_and_stops_quietly_when_there_is_nothing_new(tmp_path, capsys):
    write_pulls(tmp_path / "pulls", DESK["names"][:-1])                       # the last name has no pulls
    args = ["--pulls", str(tmp_path / "pulls"), "--data", str(tmp_path / "data")]
    assert script.main([*args, "--now", "2026-10-09T22:00:00", "--dry-run"]) == 1
    assert f"{DESK['names'][-1]}: no daily bars" in capsys.readouterr().out
    assert script.main([*args, "--now", "2026-10-10T15:00:00", "--dry-run"]) == 2      # Saturday: Monday is built
    assert "No new session" in capsys.readouterr().out
    empty = tmp_path / "empty"
    empty.mkdir()
    assert script.main(["--pulls", str(empty), "--data", str(tmp_path / "d2"), "--now", "2026-10-09T22:00:00", "--dry-run"]) == 1


def test_the_sender_signs_with_the_key_id_it_is_given(monkeypatch):
    seen = {}

    class Reply:
        status_code, text = 200, ""
    monkeypatch.setenv("DASHBOARD_KEY_ID", "gcp-use1")
    monkeypatch.setattr(publish.requests, "post", lambda url, data, headers, timeout: seen.update(headers) or Reply())
    assert publish.send(b"{}", "https://x.invalid/api/ingest", "secret", None, key_id="radar") == (True, "HTTP 200")
    assert seen["x-wt-key-id"] == "radar"
    publish.send(b"{}", "https://x.invalid/api/ingest", "secret", None)
    assert seen["x-wt-key-id"] == "gcp-use1"                                  # unchanged for every existing caller


def test_the_paper_record_is_newest_first_capped_and_each_rules_figures_add_up():
    run = edition.run(NAMES, *pulls(), NOW)
    assert run.levels_doc is not None
    row = lambda session, bar, rule, r, ticker="AAA": {"session": session, "ticker": ticker, "rule": rule, "side": "call",    # noqa: E731
                                                       "trigger_bar": bar, "entry": "100", "stop": "99", "target": "102",
                                                       "exit": "close", "r": r}
    rows = [row("2026-10-07", "2026-10-07T10:30", "brk_PDH_close", "2.0"), row("2026-10-08", "2026-10-08T13:30", "brk_PDH_close", "-1.0"),
            row("2026-10-08", "2026-10-08T10:30", "brk_PDH_close", "0.5", "BBB"), row("2026-10-08", "2026-10-08T11:30", "brk_PDL_close", "")]
    doc = edition.build_edition(run.levels_doc, [], rows, RULES, dt.datetime(2026, 10, 9, 22, 5, tzinfo=dt.UTC))
    assert [(p["session"], p["symbol"], p["r"]) for p in doc["paper"]] == [
        ("2026-10-08", "AAA", -1.0), ("2026-10-08", "AAA", None), ("2026-10-08", "BBB", 0.5), ("2026-10-07", "AAA", 2.0)]
    live = {r["id"]: r["live"] for r in doc["rules"]}
    assert live["brk_PDH_close"] == {"n": 3, "avg_r": 0.5, "wins": 2}
    assert live["brk_PDL_close"] == {"n": 0, "avg_r": None, "wins": 0}       # a row with no result yet is not a case
    many = [row("2026-10-08", f"2026-10-08T10:{i:02d}", "brk_PDH_close", "1.0", f"N{i}") for i in range(60)]
    capped = edition.build_edition(run.levels_doc, [], many, RULES, dt.datetime(2026, 10, 9, 22, 5, tzinfo=dt.UTC))
    assert len(capped["paper"]) == edition.PAPER_MAX and capped["paper"][0]["symbol"] == "N59"
    assert capped["rules"][0]["live"]["n"] == 60                              # the count is of every case, not of those shown
    jsonschema.Draft7Validator(SCHEMA).validate(capped)
