"""Strategy B replayed on a session's recorded bars beside the runner's journal (wt.analytics.b_replay).
A record in statuses and bar indexes: no result, and nothing G2 reads."""
import datetime as dt
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

from wt.analytics import b_replay as br
from wt.signals import setups

ROOT = Path(__file__).resolve().parents[2]
D = "2026-03-02"


def day(first_above: int | None, n: int = 390) -> pd.DataFrame:
    """A session that sits at 500.5 and, from bar `first_above` on, at 503: above the boundary for sigma 0.004."""
    c = np.full(n, 500.5) if first_above is None else np.where(np.arange(n) >= first_above, 503.0, 500.5)
    return pd.DataFrame({"t": pd.date_range(f"{D} 14:30", periods=n, freq="1min", tz="UTC"),
                         "o": c, "h": c + 0.1, "l": c - 0.1, "c": c, "v": 1e4})


def journal(sig_bar=None, sigma=0.004, summary=True, inputs=True, day_=D):
    rows = [{"event": "armed", "day": "2026-02-27", "sigma": 0.009, "prev_close": 490.0},
            {"event": "decision_summary", "first": {"signal_bar": 59, "trigger": 1.0, "stop": 0.5}},
            {"event": "session_end"},
            {"event": "armed", "day": day_, "sigma": sigma, "prev_close": 500.0}]
    if summary:
        first = None if sig_bar is None else {"signal_bar": sig_bar, "trigger": 503.01, "stop": 500.9, "runner_acts": True}
        rows.append({"event": "decision_summary", "inputs": inputs, "first": first})
    return [*rows, {"event": "session_end"}]


def test_the_walk_meets_the_same_bar_the_backtest_names():
    for above in (28, 45, 100, 200, None):
        b = day(above)
        full = setups.b_intraday_momentum(b, 0.004, 500.0)
        assert br.walk(b, 0.004, 500.0) == br.reading(full)
    assert br.walk(day(28), 0.004, 500.0)["bar"] == 29 and br.walk(day(45), 0.004, 500.0)["bar"] == 59
    assert br.walk(day(28).iloc[:20], 0.004, 500.0) is None                       # no half-hour mark yet


def test_the_journals_reading_is_the_days_own_and_never_an_earlier_sessions():
    j = br.journal_reading(journal(sig_bar=59), D)
    assert j == {"sigma": 0.004, "prev_close": 500.0, "summarised": True, "inputs": True,
                 "signal": {"bar": 59, "trigger": 503.01, "stop": 500.9, "acted": True}}
    assert br.journal_reading(journal(), D)["signal"] is None
    assert br.journal_reading(journal(summary=False), D) == {"sigma": 0.004, "prev_close": 500.0, "summarised": False,
                                                             "inputs": None, "signal": None}      # not the 27th's bar 59
    assert br.journal_reading(journal(), "2026-03-03") is None
    assert br.journal_reading([], D) is None


def test_a_session_is_compared_reading_by_reading():
    b = day(45)
    fwd = setups.b_intraday_momentum(b, 0.004, 500.0)
    same = br.record(D, b, fwd, br.journal_reading(journal(sig_bar=59), D))
    assert (same["forward_vs_replay"], same["replay_vs_journal"], same["armed"]) == ("same", "same", True)
    assert same["replay"]["bar"] == same["forward"]["bar"] == 59
    assert br.record(D, b, fwd, br.journal_reading(journal(sig_bar=89), D))["replay_vs_journal"] == "different"
    assert br.record(D, b, fwd, br.journal_reading(journal(), D))["replay_vs_journal"] == "only_first"
    quiet = br.record(D, day(None), None, br.journal_reading(journal(), D))
    assert (quiet["forward_vs_replay"], quiet["replay_vs_journal"]) == ("neither", "neither")
    assert br.record(D, day(None), None, br.journal_reading(journal(sig_bar=59), D))["replay_vs_journal"] == "only_second"
    wide = br.record(D, b, fwd, br.journal_reading(journal(sig_bar=None, sigma=0.02), D))   # the runner's sigma was wider
    assert (wide["forward_vs_replay"], wide["replay_vs_journal"]) == ("only_first", "neither")


def test_what_cannot_be_compared_is_unknown_never_a_match():
    b, fwd = day(45), setups.b_intraday_momentum(day(45), 0.004, 500.0)
    none = br.record(D, b, fwd, None)                                             # the runner never armed
    assert (none["armed"], none["forward_vs_replay"], none["replay_vs_journal"]) == (False, "unknown", "unknown")
    cut = br.record(D, b, fwd, br.journal_reading(journal(summary=False), D))     # armed, no summary (a crash)
    assert (cut["forward_vs_replay"], cut["replay_vs_journal"]) == ("same", "unknown")
    blind = br.record(D, b, fwd, br.journal_reading(journal(inputs=False), D))    # it never had its prices
    assert blind["replay_vs_journal"] == "unknown"
    t = br.tally([none, cut, blind, br.record(D, b, fwd, br.journal_reading(journal(sig_bar=59), D))], "replay_vs_journal")
    assert t == {"same": 1, "different": 0, "neither": 0, "only_first": 0, "only_second": 0, "unknown": 3}


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_the_forward_test_keeps_the_record_and_a_failure_costs_nothing(tmp_path, monkeypatch, capsys):
    ft = load("forward_test")
    monkeypatch.setattr(ft, "FWD", tmp_path / "forward")
    monkeypatch.setattr(ft, "RUNNER_JOURNAL", tmp_path / "journal.jsonl")
    (tmp_path / "journal.jsonl").write_text("\n".join([*map(json.dumps, journal(sig_bar=59)), "{ torn"]))
    b = day(45)
    d = dt.date(2026, 3, 2)
    ft.note_replay(d, b, setups.b_intraday_momentum(b, 0.004, 500.0))
    doc = json.loads((tmp_path / "forward" / "replay" / f"{d}.json").read_text())
    assert doc["replay_vs_journal"] == "same" and doc["session"] == D and doc["git_sha"]
    assert not (tmp_path / "forward" / "forward_trades.jsonl").exists()           # beside the ledger, never in it
    monkeypatch.setattr(ft.b_replay, "record", lambda *a: 1 / 0)
    ft.note_replay(d, b, None)                                                    # printed, not raised
    assert "replay record 2026-03-02" in capsys.readouterr().out


def test_the_scorecard_counts_the_statuses_and_leaves_g2_alone(tmp_path, monkeypatch):
    sc = load("weekly_scorecard")
    monkeypatch.setattr(sc, "FWD", tmp_path / "forward" / "forward_trades.jsonl")
    assert "sessions recorded 0, comparable 0" in sc.replay_line()
    (tmp_path / "forward" / "replay").mkdir(parents=True)
    for i, (a, b) in enumerate((("same", "same"), ("neither", "neither"), ("different", "same"), ("unknown", "unknown"))):
        (tmp_path / "forward" / "replay" / f"2026-03-0{i + 2}.json").write_text(json.dumps({"replay_vs_journal": a, "forward_vs_replay": b}))
    (tmp_path / "forward" / "replay" / "2026-03-09.json").write_text("{ torn")
    line = sc.replay_line()
    assert "sessions recorded 4, comparable 3" in line
    assert "same bar 1 · no signal on either 1 · different bar 1 · replay only 0 · journal only 0" in line
    assert "Forward test against the replay: same 3 · not the same 0" in line
    assert "b_replay" not in (ROOT / "src/wt/analytics/g2.py").read_text()        # the gate does not read this record
