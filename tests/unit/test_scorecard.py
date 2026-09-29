import datetime as dt
import importlib.util
import json
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("sc", ROOT / "scripts/weekly_scorecard.py")
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)


def test_scorecard_flags_agreement_incidents_and_band(tmp_path, monkeypatch):
    fwd, jr = tmp_path / "fwd.jsonl", tmp_path / "journal.jsonl"
    rows = []
    for i in range(25):
        d = f"2026-10-{i + 1:02d}"
        rows.append({"session": d, "strategy": "B_qqq_qqqm", "R": -1.0})       # terrible forward results
        rows.append({"session": d, "session_marker": True, "n_trades": 1})
    fwd.write_text("\n".join(json.dumps(r) for r in rows))
    j = [{"event": "armed", "day": "2026-10-01", "kill": False, "ts": "2026-10-01T12:30:00+00:00"},
         {"event": "trade_closed", "day": "2026-10-01", "R": 0.5, "trade_id": "2026-10-01-B-QQQM-0",
          "ts": "2026-10-01T15:00:00+00:00", "virtual": {"equity": 601, "settled_cash": 300, "latched": False}},
         {"event": "trade_closed", "day": "2026-10-01", "R": 0.5, "trade_id": "2026-10-01-B-QQQM-0",
          "ts": "2026-10-01T15:05:00+00:00"},                                   # a pre-phase-2 restart duplicate
         {"event": "session_end", "ts": "2026-10-01T20:00:00+00:00"},
         {"event": "armed", "day": "2026-10-02", "kill": False, "ts": "2026-10-02T12:30:00+00:00"},
         {"event": "loop_error", "error": "x", "ts": "2026-10-02T14:00:00+00:00"},
         {"event": "session_end", "ts": "2026-10-02T20:00:00+00:00"},
         {"event": "armed", "day": "2026-10-03", "kill": True, "ts": "2026-10-03T12:30:00+00:00"},   # KILL night
         {"event": "session_end", "ts": "2026-10-03T20:00:00+00:00"}]
    jr.write_text("\n".join(json.dumps(x) for x in j))
    monkeypatch.setattr(sc, "FWD", fwd)
    monkeypatch.setattr(sc, "JOURNAL", jr)
    monkeypatch.setattr(sc, "ROOT", tmp_path)
    monkeypatch.setattr(sc, "SCORECARD_DIR", tmp_path / "scorecards")
    (tmp_path / "research/experiments/EXP-0005b-g1-etf-dev-realcost").mkdir(parents=True)
    for exp, name in sc.EXPECT.values():
        p = tmp_path / "research/experiments" / exp
        p.mkdir(parents=True, exist_ok=True)
        (p / "results.json").write_text(json.dumps({"results": {name: {"trades": [{"R": r, "date": f"d{k}"} for k, r in enumerate([0.1, -1, 2, 0.3] * 10)]}}}))
    md = sc.main()
    assert "BELOW expectation" in md                      # -1R forward vs positive backtest -> warning
    assert "**1/2** = 50%" in md                          # paper traded 10-01, forward B traded both days
    assert "loop errors 1" in md                          # the incident surfaces
    assert "Sessions armed: **3** · clean (count for G2): **2**" in md     # the KILL night does not count
    assert "trades closed: **1**" in md                   # the duplicate close counts once


def ledger(tmp_path, monkeypatch, rows):
    fwd = tmp_path / "fwd.jsonl"
    fwd.write_text("\n".join(json.dumps(r) for r in rows))
    monkeypatch.setattr(sc, "FWD", fwd)
    monkeypatch.setattr(sc, "JOURNAL", tmp_path / "no_journal.jsonl")
    monkeypatch.setattr(sc, "ROOT", tmp_path)
    monkeypatch.setattr(sc, "SCORECARD_DIR", tmp_path / "scorecards")
    for exp, name in sc.EXPECT.values():
        p = tmp_path / "research/experiments" / exp
        p.mkdir(parents=True, exist_ok=True)
        (p / "results.json").write_text(json.dumps({"results": {name: {"trades": [{"R": r, "date": f"d{k}"} for k, r in enumerate([0.1, -1, 2, 0.3] * 10)]}}}))


def table_row(md, strat):
    return next(line for line in md.splitlines() if line.startswith(f"| {strat} |"))


def test_round3_v2_and_biased_strategies(tmp_path, monkeypatch):
    rows = [{"session": "2026-10-01", "strategy": "r3:F:GG-1", "strategy_marker": True, "n_trades": 0},
            {"session": "2026-10-01", "strategy": "r3:P:GG-2", "R": 1.5, "symbol": "X", "tags": {"slip": 0.01}},
            {"session": "2026-10-01", "strategy": "r3:P:GG-2", "strategy_marker": True, "n_trades": 1},
            {"session": "2026-10-01", "strategy": "hod_bull_flag_atr_M1_v2", "R": -1.0},
            {"session": "2026-10-01", "strategy": "hod_bull_flag_atr_M1", "R": -1.0},
            {"session": "2026-10-01", "strategy": "watchlist_bull_flag_atr_M1", "R": 3.0},
            {"session": "2026-10-01", "strategy": "r3:MP-1,r3:REV-1", "error": "boom"}]
    ledger(tmp_path, monkeypatch, rows)
    md = sc.main(dt.datetime(2026, 10, 2, 21, 0, tzinfo=ZoneInfo("America/New_York")))
    assert table_row(md, "r3:F:GG-1").endswith("| 0 | — | — | — | — | no baseline | — | waiting for trades |")
    assert table_row(md, "r3:P:GG-2") == "| r3:P:GG-2 | 1 | +1.500 | 100% | inf | +1.50 | no baseline | — | forward record only |"
    assert "no baseline" in table_row(md, "hod_bull_flag_atr_M1_v2")
    for old in sc.BIASED:
        assert table_row(md, old).endswith("| — | biased — not evidence (DEC-0011) |")
    assert "r3:MP-1" not in md                             # an error row is not a strategy
    assert md.index("| B_qqq_qqqm |") < md.index("| r3:F:GG-1 |")


def test_rows_repeated_under_one_key_count_once(tmp_path, monkeypatch):
    rows = [{"session": "2026-10-01", "strategy": "B_qqq_qqqm", "R": 1.0, "key": "B|2026-10-01|0",
             "prev_sha256": "a" * 64, "git_sha": "abc1234"},
            {"session": "2026-10-01", "strategy": "B_qqq_qqqm", "R": 1.0, "key": "B|2026-10-01|0",
             "prev_sha256": "b" * 64, "git_sha": "abc1234"},                          # a retried append
            {"session": "2026-10-02", "strategy": "B_qqq_qqqm", "R": -0.5},             # legacy rows have no key
            {"session": "2026-10-02", "strategy": "B_qqq_qqqm", "R": -0.5}]
    assert len(sc.dedupe(rows)) == 3
    ledger(tmp_path, monkeypatch, rows)
    md = sc.main(dt.datetime(2026, 10, 2, 21, 0, tzinfo=ZoneInfo("America/New_York")))
    assert table_row(md, "B_qqq_qqqm").startswith("| B_qqq_qqqm | 3 | +0.000 |")


def test_report_is_dated_by_the_new_york_session(tmp_path, monkeypatch):
    ledger(tmp_path, monkeypatch, [])
    saturday_sydney = dt.datetime(2026, 10, 3, 11, 0, tzinfo=ZoneInfo("Australia/Sydney"))   # the weekly job's slot
    md = sc.main(saturday_sydney)
    assert md.startswith("# Forward scorecard — 2026-10-02")                   # Friday's session in New York
    assert (tmp_path / "scorecards/scorecard_2026-10-02.md").exists()
    assert sc.session_date(dt.datetime(2026, 1, 5, 23, 30, tzinfo=dt.timezone.utc)) == dt.date(2026, 1, 5)
