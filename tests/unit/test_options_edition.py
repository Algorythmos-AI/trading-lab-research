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
REAL_EARNINGS_ROWS = script.earnings_rows


@pytest.fixture(autouse=True)
def _no_real_earnings(monkeypatch):
    """The hand-kept earnings file changes with the calendar; a test that runs the script must not depend on it."""
    monkeypatch.setattr(script, "earnings_rows", lambda: [])


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


# ---- edition format 2

CALENDAR = [{"date": dt.date(2026, 10, 9), "time_et": "08:30", "type": "nfp", "severity": "high", "policy": "reduce", "source": "x"},
            {"date": dt.date(2026, 10, 14), "time_et": "8:30", "type": "cpi", "severity": "high", "policy": "skip", "source": "y"},
            {"date": dt.date(2026, 10, 12), "time_et": "", "type": "fomc_minutes", "severity": "odd", "policy": "reduce"},
            {"date": "2026-10-18", "time_et": "14:00", "type": "fomc_decision", "severity": "high"},
            {"date": dt.date(2026, 10, 19), "time_et": "14:00", "type": "fomc_decision", "severity": "high"},
            {"date": dt.date(2026, 10, 13), "time_et": "09:00", "type": "a headline, not a code", "severity": "low"}]


def test_format_two_adds_to_format_one_and_the_dashboard_accepts_it():
    run = edition.run(NAMES, *pulls(), NOW)
    when = dt.datetime(2026, 10, 9, 22, 5, 7, tzinfo=dt.UTC)
    iv = [{k: "" if v is None else str(v) for k, v in r.items()} for r in run.iv_rows]
    iv += [{**iv[0], "session": "2026-10-08", "annual_iv": "0.19"}]                    # yesterday's row for one name
    sc = [{k: str(v) for k, v in r.items()} for r in run.scorecard_rows]
    one = edition.build_edition(run.levels_doc, iv, sc, RULES, when)
    two = edition.build_edition(run.levels_doc, iv, sc, RULES, when, version=2, calendar=CALENDAR)
    jsonschema.Draft7Validator(SCHEMA).validate(two)
    assert two["schema_version"] == 2 and one["schema_version"] == 1
    stripped = {**two, "schema_version": 1, "tickers": [{k: v for k, v in t.items() if k != "vol"} for t in two["tickers"]]}
    del stripped["market"], stripped["events"]
    assert stripped == one                                                             # nothing format 1 holds has moved
    assert two["market"] == {"vix": None, "session": {"half_day": False}, "calendar": "partial"}
    # The session and the six days after it, soonest first; codes only, and never the desk's policy or its source.
    assert two["events"] == [
        {"date": "2026-10-12", "time_et": None, "kind": "macro", "type": "fomc_minutes", "severity": None},
        {"date": "2026-10-14", "time_et": "8:30", "kind": "macro", "type": "cpi", "severity": "high"},
        {"date": "2026-10-18", "time_et": "14:00", "kind": "macro", "type": "fomc_decision", "severity": "high"}]
    vol = two["tickers"][0]["vol"]
    # Realised volatility arrives as a percentage (18.0) and is sent as a fraction, like the implied figure.
    assert vol == {"iv30": 0.2, "iv_change_1d": 0.01, "iv_pct_13w": 0.4, "iv_pct_26w": 0.3, "hv30": 0.18,
                   "opt_volume": 22.0, "opt_volume_avg20": 17.0}
    assert two["tickers"][1]["vol"]["iv_change_1d"] is None                            # no row for the day before
    bare = edition.build_edition(run.levels_doc, iv, sc, RULES, when, version=2)
    assert bare["events"] is None and bare["market"]["calendar"] is None
    jsonschema.Draft7Validator(SCHEMA).validate(bare)
    with pytest.raises(ValueError, match="not one this builder writes"):
        edition.build_edition(run.levels_doc, iv, sc, RULES, when, version=3)
    half = edition.build_edition({**run.levels_doc, "session": "2026-11-27"}, iv, sc, RULES, when, version=2)
    assert half["market"]["session"] == {"half_day": True}


@pytest.mark.parametrize("row,want", [
    ({"annual_iv": "0.25", "hv_annual": "22.4"}, {"iv30": 0.25, "hv30": 0.224}),      # the feed's percentage, as a fraction
    ({"annual_iv": "0.04", "hv_annual": "4.8"}, {"iv30": 0.04, "hv30": 0.048}),       # a quiet name: 4.8 is still a percentage
    ({"annual_iv": "0.25", "hv_annual": "52"}, {"iv30": 0.25, "hv30": 0.52}),         # realised twice implied is believable
    ({"annual_iv": "", "hv_annual": "4.8"}, {"iv30": None, "hv30": 0.048}),           # no implied figure: the same rule
    ({"annual_iv": "0.25", "hv_annual": "0.224"}, {"iv30": 0.25, "hv30": None}),      # a fraction where a percentage belongs: blank
    ({"annual_iv": "0.25", "hv_annual": "600"}, {"iv30": 0.25, "hv30": None}),        # 600%: above what is sent
    ({"annual_iv": "0.01", "hv_annual": "90"}, {"iv30": 0.01, "hv30": None}),         # ninety times implied: one of them is wrong
    ({"annual_iv": "nan", "hv_annual": "-3"}, None),
    ({"annual_iv": "0.25", "ivp_13w": "40", "ivp_26w": "-0.1"}, {"iv30": 0.25, "iv_pct_13w": None, "iv_pct_26w": None}),
    ({"annual_iv": "0.25", "call_vol": "10", "put_vol": ""}, {"iv30": 0.25, "opt_volume": None}),
    ({"annual_iv": "0.25", "call_vol": "1e308", "put_vol": "1e308"}, {"iv30": 0.25, "opt_volume": None}),
    ({"annual_iv": "900"}, None),                                                       # no volatility is 900%: not sent
])
def test_a_volatility_block_never_sends_a_figure_it_cannot_read(row, want):
    got = edition.vol_block(row, None)
    if want is None:
        assert got is None
    else:
        assert got is not None and {k: got[k] for k in want} == want
        jsonschema.Draft7Validator(SCHEMA["properties"]["tickers"]["items"]["properties"]["vol"]).validate(got)
        json.dumps(got, allow_nan=False)
    assert edition.vol_block(None, None) is None and edition.vol_block({}, None) is None


def test_calendar_rows_that_cannot_be_read_are_passed_over_and_the_list_is_capped():
    odd = [{"date": None, "type": "cpi"}, {"date": "2026-13-01", "type": "cpi"}, {"type": "cpi"}, {"date": 5, "type": "cpi"},
           {"date": dt.datetime(2026, 10, 13, 8, 30), "time_et": "0\u0668:30", "type": "nfp", "severity": "high"}]
    assert edition.macro_events(odd, "2026-10-12") == [
        {"date": "2026-10-13", "time_et": None, "kind": "macro", "type": "nfp", "severity": "high"}]
    many = [{"date": dt.date(2026, 10, 12), "time_et": "08:30", "type": f"code_{i}", "severity": "low"} for i in range(450)]
    assert len(edition.macro_events(many, "2026-10-12")) == edition.EVENTS_MAX


def test_the_script_sends_format_two_only_to_a_dashboard_that_accepts_it(tmp_path, monkeypatch, capsys):
    write_pulls(tmp_path / "pulls")
    args = ["--pulls", str(tmp_path / "pulls"), "--data", str(tmp_path / "data"), "--now", "2026-10-09T22:00:00"]
    out = tmp_path / "edition.json"
    assert DESK["edition_format"] == 1                                                 # the owner's switch is off
    assert script.main([*args, "--dry-run", "--out", str(out)]) == 0 and json.loads(out.read_text())["schema_version"] == 1
    monkeypatch.setattr(publish, "read_health", lambda *a: pytest.fail("asked the dashboard on a dry run"))
    assert script.main([*args, "--dry-run", "--format", "2", "--out", str(out)]) == 0
    two = json.loads(out.read_text())
    jsonschema.Draft7Validator(SCHEMA).validate(two)
    assert two["schema_version"] == 2 and two["market"]["calendar"] == "partial" and isinstance(two["events"], list)
    assert two["events"] and all(set(e) == {"date", "time_et", "kind", "type", "severity"} for e in two["events"])

    monkeypatch.setenv("RADAR_INGEST_SECRET", "s" * 24)
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "b" * 24)
    sent = []
    monkeypatch.setattr(publish, "send", lambda body, *a, **k: sent.append(json.loads(body)["schema_version"]) or (True, "HTTP 200"))
    for health, want in (({"editions": {"options": {"accepts": 2}}}, 2), ({"editions": {"options": {"accepts": 1}}}, 1),
                         ({"editions": {}}, 1), (None, 1), ({"editions": {"options": {"accepts": True}}}, 1)):
        monkeypatch.setattr(publish, "read_health", lambda *a, _h=health: (_h, "" if _h else "health unreadable"))
        assert script.main([*args, "--send", "--format", "2"]) == 0
        assert sent[-1] == want
    assert "building format 1" in capsys.readouterr().out
    monkeypatch.setattr(publish, "read_health", lambda *a: pytest.fail("format 1 needs no question"))
    assert script.main([*args, "--send"]) == 0 and sent[-1] == 1
    # A send that cannot ask the dashboard (no secrets) writes format 1 too, and says it was not sent.
    monkeypatch.delenv("RADAR_INGEST_SECRET")
    assert script.main([*args, "--send", "--format", "2", "--out", str(out)]) == 3
    assert json.loads(out.read_text())["schema_version"] == 1
    # A switch set to something this script does not write is format 1, said aloud, never a crash.
    for bad in (3, "two", True, -1):
        monkeypatch.setattr(script, "load_yaml", lambda name, _b=bad: {**DESK, "edition_format": _b})
        assert script.main([*args, "--dry-run", "--out", str(out)]) == 0 and json.loads(out.read_text())["schema_version"] == 1
    assert "not a format this script writes" in capsys.readouterr().err


def test_two_builds_of_the_same_pulls_are_compared_by_where_they_differ_never_by_value(tmp_path, capsys):
    write_pulls(tmp_path / "pulls")
    args = ["--pulls", str(tmp_path / "pulls"), "--now", "2026-10-09T22:00:00", "--dry-run"]
    first = tmp_path / "first.json"
    assert script.main([*args, "--data", str(tmp_path / "a"), "--out", str(first)]) == 0
    assert script.main([*args, "--data", str(tmp_path / "b"), "--compare", str(first)]) == 0
    assert "compare: 0 difference(s)" in capsys.readouterr().out          # built apart, minutes apart: the same edition
    doc = json.loads(first.read_text())
    secret_price = 123456.78
    doc["tickers"][3]["zones"][0]["hi"] = secret_price
    doc["tickers"][0]["atr14"] = float(doc["tickers"][0]["atr14"]) + 0.01
    del doc["tickers"][1]["bars"][-1]
    doc["rules"][0]["extra"] = True
    doc["session"] = "2026-10-13"
    first.write_text(json.dumps(doc))
    assert script.main([*args, "--data", str(tmp_path / "c"), "--compare", str(first)]) == 1
    out = capsys.readouterr().out
    assert "compare: 5 difference(s)" in out
    for where in ("tickers[3].zones[0].hi", "tickers[0].atr14", "tickers[1].bars (length 39 against 40)",
                  "rules[0].extra (only in the other build)", "session"):
        assert where in out, where
    assert str(secret_price) not in out and "2026-10-13" not in out
    assert script.differences({"a": 1}, {"a": 1.0}) == ["a"] and script.differences({"a": [1, {"b": None}]}, {"a": [1, {"b": None}]}) == []
    assert script.main([*args, "--data", str(tmp_path / "d"), "--compare", str(tmp_path / "missing.json")]) == 1


def test_a_dry_run_loads_none_of_the_sender(tmp_path):
    """The shadow night runs this where the lab's other dependencies may not be installed."""
    import subprocess
    import sys
    write_pulls(tmp_path / "pulls")
    code = ("import sys, runpy\n"
            "class Block:\n"
            "    def find_spec(self, name, path=None, target=None):\n"
            "        if name.split('.')[0] in ('requests', 'numpy', 'pandas', 'dotenv', 'jsonschema') or name.startswith('wt.ops') or name.startswith('wt.core'):\n"
            "            raise ImportError('blocked: ' + name)\n"
            "sys.meta_path.insert(0, Block())\n"
            f"sys.argv = ['options_edition.py', '--pulls', {str(tmp_path / 'pulls')!r}, '--data', {str(tmp_path / 'data')!r}, '--now', '2026-10-09T22:00:00', '--dry-run', '--format', '2']\n"
            f"runpy.run_path({str(ROOT / 'scripts' / 'options_edition.py')!r}, run_name='__main__')\n")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=tmp_path, timeout=120)
    assert r.returncode == 0, r.stderr[-600:]
    assert "edition: format 2" in r.stdout


def test_the_volatility_index_block_is_its_close_change_and_place_in_the_year_or_nothing():
    raw = synth(7, start=18.0)
    closes = raw["close"]
    got, why = edition.vix_block(raw, "2026-10-09", NOW)
    earlier = closes[-253:-1]
    assert why == "" and got == {"close": round(closes[-1], 2), "change": round(closes[-1] - closes[-2], 2),
                                 "pct_52w": round(sum(1 for c in earlier if c < closes[-1]) / 252, 4)}
    top = {**raw, "high": [*raw["high"][:-1], 99.0], "close": [*raw["close"][:-1], max(closes) + 1]}
    assert edition.vix_block(top, "2026-10-09", NOW)[0]["pct_52w"] == 1.0     # a year's high is above every earlier close
    assert edition.vix_block(None, "2026-10-09", NOW) == (None, "no pull") and edition.vix_block({}, "2026-10-09", NOW)[0] is None
    assert "expected 2026-10-12" in edition.vix_block(raw, "2026-10-12", NOW)[1]            # an old level is not today's
    assert edition.vix_block(raw, "2026-10-09", dt.datetime(2026, 10, 9, 19, 0))[0] is None  # the close is not final yet
    assert edition.vix_block(synth(7, n=120, start=18.0), "2026-10-09", NOW)[0]["pct_52w"] is None   # not a year of closes
    gap = {k: v[:-30] + v[-29:] for k, v in raw.items()}
    assert "missing session" in edition.vix_block(gap, "2026-10-09", NOW)[1]
    old_gap = {k: v[:10] + v[11:] for k, v in raw.items()}                    # a fault older than the year is not today's
    assert edition.vix_block(old_gap, "2026-10-09", NOW)[0] == got
    # A doubling overnight, or a close the index has never printed, is a wrong pull: nothing is shown.
    jump = {**raw, "open": [*raw["open"][:-1], closes[-2] * 2.02], "high": [*raw["high"][:-1], closes[-2] * 2.1],
            "close": [*closes[:-1], closes[-2] * 2.05]}
    assert edition.vix_block(jump, "2026-10-09", NOW)[0] is None
    far = {k: ([x * 10 for x in v] if k != "time" and k != "volume" else v) for k, v in raw.items()}
    assert edition.vix_block(far, "2026-10-09", NOW) == (None, "a close outside the index's range")


def test_earnings_rows_are_the_desks_names_inside_the_week_one_row_a_name():
    rows = [{"symbol": "aaa", "date": "2026-10-14", "when": "AMC", "source": "x", "quality": "confirmed"},
            {"symbol": "AAA", "date": "2026-10-15", "when": "amc", "quality": "expected"},   # the confirmed date stands
            {"symbol": "BBB", "date": "2026-10-13", "when": "sometime"},
            {"symbol": "BBB", "date": "2026-10-12", "when": "bmo"},               # the later row for a name wins
            {"symbol": "ZZZ", "date": "2026-10-13", "when": "bmo"},               # not a name the desk carries
            {"symbol": "DDD", "date": "2026-10-19", "when": "bmo"},               # past the week
            {"symbol": "DDD", "date": "2026-10-11", "when": "bmo"},               # before the session
            {"symbol": "CCC", "date": "soon", "when": "bmo"}, {}]
    row = lambda d, s, w: {"date": d, "time_et": None, "kind": "earnings", "type": "earnings", "severity": None, "symbol": s, "when": w}  # noqa: E731
    assert edition.earnings_events(rows, NAMES, "2026-10-12") == [row("2026-10-12", "BBB", "bmo"), row("2026-10-14", "AAA", "amc")]
    assert edition.earnings_events([], NAMES, "2026-10-12") == []
    # After the close of the day the levels were built from: the gap lands in the session, so it is carried.
    eve = [{"symbol": "CCC", "date": "2026-10-09", "when": "amc"}, {"symbol": "DDD", "date": "2026-10-09", "when": "bmo"}]
    assert edition.earnings_events(eve, NAMES, "2026-10-12") == []
    assert edition.earnings_events(eve, NAMES, "2026-10-12", built_from="2026-10-09") == [row("2026-10-09", "CCC", "amc")]


def test_format_two_carries_the_index_and_earnings_when_given_and_the_site_takes_them():
    run = edition.run(NAMES, *pulls(), NOW)
    when = dt.datetime(2026, 10, 9, 22, 5, tzinfo=dt.UTC)
    vix, _ = edition.vix_block(synth(7, start=18.0), run.finished, NOW)
    earn = edition.earnings_events([{"symbol": "AAA", "date": "2026-10-14", "when": "amc"}], NAMES, run.session)
    doc = edition.build_edition(run.levels_doc, [], [], RULES, when, version=2, vix=vix, earnings=earn)
    jsonschema.Draft7Validator(SCHEMA).validate(doc)
    assert doc["market"]["vix"] == vix and doc["market"]["calendar"] is None    # no macro calendar was read
    assert doc["events"] == earn
    both = edition.build_edition(run.levels_doc, [], [], RULES, when, version=2, calendar=CALENDAR, earnings=earn)
    jsonschema.Draft7Validator(SCHEMA).validate(both)
    assert [(e["date"], e["kind"]) for e in both["events"]] == [("2026-10-12", "macro"), ("2026-10-14", "earnings"), ("2026-10-14", "macro"), ("2026-10-18", "macro")]
    assert edition.build_edition(run.levels_doc, [], [], RULES, when, version=2, earnings=[])["events"] == []   # read, and none this week
    one = edition.build_edition(run.levels_doc, [], [], RULES, when, vix=vix, earnings=earn)
    assert "market" not in one and "events" not in one                          # format 1 is what it always was


def test_the_script_reads_the_index_with_the_pulls_and_the_earnings_file(tmp_path, monkeypatch, capsys):
    folder = tmp_path / "pulls"
    folder.mkdir()
    daily, hourly, snaps = pulls(names=[str(n) for n in DESK["names"]])
    for kind, group in (("daily", daily), ("hourly", hourly), ("snapshot", snaps)):
        for name, d in group.items():
            (folder / f"{name}.{kind}.json").write_text(json.dumps(d))
    (folder / "VIX.daily.json").write_text(json.dumps({**synth(7, start=18.0), "chart_step": 86400}))
    cfg = tmp_path / "config"
    (cfg / "events").mkdir(parents=True)
    (cfg / "events" / "earnings.csv").write_text("# a comment\nsymbol,date,when,source,quality\nNVDA,2026-10-14,amc,test,confirmed\n")
    (cfg / "options_rules.json").write_text(json.dumps(RULES))
    (cfg / "options_desk.yaml").write_text(yaml.safe_dump(DESK))
    monkeypatch.setattr(script, "CONFIG_DIR", cfg)
    monkeypatch.setattr(script, "macro_calendar", lambda: None)
    monkeypatch.setattr(script, "earnings_rows", REAL_EARNINGS_ROWS)
    out = tmp_path / "edition.json"
    assert script.main(["--pulls", str(folder), "--data", str(tmp_path / "data"), "--now", NOW.isoformat(), "--dry-run", "--format", "2", "--out", str(out)]) == 0
    doc = json.loads(out.read_text())
    jsonschema.Draft7Validator(SCHEMA).validate(doc)
    assert doc["market"]["vix"]["close"] > 0 and "VIX" not in [t["symbol"] for t in doc["tickers"]]
    assert [(e["symbol"], e["when"]) for e in doc["events"]] == [("NVDA", "amc")]
    assert REAL_EARNINGS_ROWS()[0]["symbol"] == "NVDA"
    # A spreadsheet's re-save: a byte-order mark, a quoted comment, blank lines, capitals and spaces in the header.
    (cfg / "events" / "earnings.csv").write_bytes(b"\xef\xbb\xbf\"# kept, by hand\"\r\n\r\n Symbol , Date ,When\r\nNVDA,2026-10-14,amc\r\n")
    assert REAL_EARNINGS_ROWS() == [{"symbol": "NVDA", "date": "2026-10-14", "when": "amc"}]
    (cfg / "events" / "earnings.csv").write_text("name,day\nNVDA,2026-10-14\n")
    assert REAL_EARNINGS_ROWS() == [] and "no symbol and date columns" in capsys.readouterr().err
    (cfg / "events" / "earnings.csv").write_bytes(b"symbol,date,source\nNVDA,2026-10-14,caf\xe9\n")
    assert REAL_EARNINGS_ROWS() == [] and "unreadable (UnicodeDecodeError)" in capsys.readouterr().err
    monkeypatch.setattr(script, "CONFIG_DIR", tmp_path / "nowhere")
    assert REAL_EARNINGS_ROWS() == []
    # An index pull the loader cannot read costs the index, never the edition.
    monkeypatch.setattr(script, "CONFIG_DIR", cfg)
    bad = synth(7, start=18.0)
    (folder / "VIX.daily.json").write_text(json.dumps({**bad, "volume": [None] * len(bad["time"]), "chart_step": 86400}))
    assert script.main(["--pulls", str(folder), "--data", str(tmp_path / "data2"), "--now", NOW.isoformat(), "--dry-run", "--format", "2", "--out", str(out)]) == 0
    assert json.loads(out.read_text())["market"]["vix"] is None and "volatility index left out: unreadable (TypeError)" in capsys.readouterr().out
