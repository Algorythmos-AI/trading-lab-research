"""Sleeve S against the forward test (wt.analytics.s_agreement; EXP-0051, measures.agreement), and its section of
the weekly scorecard: synthetic journal and ledger rows only."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from wt.analytics import s_agreement as sa

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("sc_s", ROOT / "scripts/weekly_scorecard.py")
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)


def armed(day, **kw):
    return {"event": "armed", "day": day, "trial": "HYP-0070", "entries_off": [], "kill": False, **kw}


def closed(day, symbol, entry, exit_, stop, reason, n=0, **kw):
    return {"event": "trade_closed", "day": day, "trial": "HYP-0070", "symbol": symbol, "entry": entry, "exit": exit_,
            "exit_price_estimated": False, "stop": stop, "qty": 10, "R": (exit_ - entry) / (entry - stop),
            "reason": reason, "trade_id": f"{day}-S-{symbol}-{n}", "origin": "entry", **kw}


def fwd(day, symbol, entry, r, reason, attempt=1, entry_time="09:45", **kw):
    return {"session": day, "date": day, "symbol": symbol, "setup": "ZZSETUP", "attempt": attempt, "priority": 1,
            "entry_time": f"{day} {entry_time}:00-04:00", "entry": entry, "stop0": entry - 0.5, "qty": 10, "R": r,
            "exit_reason": reason, "exit_time": f"{day} 10:00:00-04:00", "tags": {"slip": 0.01},
            "strategy": "r3:REV-1", "key": f"{day}|r3:REV-1|{symbol}|{entry_time}", **kw}


def marker(day, strategy="r3:REV-1"):
    return {"session": day, "strategy": strategy, "strategy_marker": True, "n_trades": 0,
            "key": f"{day}|{strategy}|strategy_marker"}


D1, D2, D3, D4, D5 = (f"2026-11-{d:02d}" for d in (23, 24, 25, 27, 30))
JOURNAL = [
    armed(D1),
    closed(D1, "AAAA", 5.03, 5.53, 4.53, "target"),                            # pairs with the forward AAAA: +3c, same
    closed(D1, "AAAA", 5.03, 5.53, 4.53, "target"),                            # a restart's repeat: one trade_id
    closed(D1, "BBBB", 8.00, 7.50, 7.50, "stop"),                              # sleeve S only
    closed(D1, "ORPH", 3.00, 2.97, 2.97, "adopted_exit", trial=None, origin="orphan"),
    armed(D2),
    closed(D2, "CCCC", 4.00, 4.10, 3.80, "time_stop_5m", n=0),                 # first of two tries
    closed(D2, "CCCC", 4.20, 3.90, 3.90, "stop", n=1),                         # second: the forward test took one
    closed(D2, "DDDD", 6.00, 5.70, 5.70, "stop", exit_price_estimated=True),   # no real exit price: left out
    armed(D3, kill=True),                                                      # exits only; the forward test traded
    armed(D4),                                                                 # the forward test has not run D4
    closed(D4, "EEEE", 2.00, 2.20, 1.90, "target"),
]
LEDGER = [
    fwd(D1, "AAAA", 5.00, 1.10, "target"), fwd(D1, "FFFF", 9.00, -1.0, "stop"), marker(D1),
    fwd(D1, "AAAA", 5.00, 1.10, "target"),                                     # a retried append: the same key
    fwd(D1, "AAAA", 5.00, 9.99, "target", strategy="r3:MP-1", key="other"),    # another trial's row is not read
    fwd(D2, "CCCC", 4.05, 0.20, "eod_flatten"), fwd(D2, "DDDD", 6.00, -1.0, "stop"), marker(D2),
    fwd(D3, "GGGG", 7.00, 0.5, "target"), marker(D3),
    fwd(D5, "HHHH", 7.00, 0.5, "target"), marker(D5),                          # sleeve S did not arm D5
    {"session": D4, "strategy": "r3:MP-1,r3:REV-1", "error": "boom"},          # an error row is not a completed run
    marker(D4, "r3:MP-1"),
]


def test_the_constants_are_the_runner_and_the_forward_tests_own():
    from wt.live import setups_live
    text = (ROOT / "scripts/forward_test.py").read_text()
    assert f'"{sa.FWD_STRATEGY}": "{sa.FWD_TRIAL}"' in text          # R3_HYP, read without importing the job
    assert sa.S_TRIAL == setups_live.TRIAL
    assert sc.JOURNAL_S.name == "smallcap_journal.jsonl" and sc.JOURNAL_S.parent.name == "live"
    assert 'JOURNAL = DATA_DIR / "live" / "smallcap_journal.jsonl"' in (ROOT / "src/wt/live/runner_s.py").read_text()


def test_only_sessions_both_ran_are_compared():
    t = sa.compare(JOURNAL, LEDGER)["total"]
    assert (t["sessions"], t["first"], t["last"]) == (3, D1, D3)
    assert (t["s_only_sessions"], t["fwd_only_sessions"], t["entries_off_sessions"]) == (1, 1, 1)
    assert (t["s_trial"], t["fwd_trial"]) == ("HYP-0070", "HYP-0019")


def test_trades_pair_by_name_and_session_and_the_differences_are_s_minus_forward():
    a = sa.compare(JOURNAL, LEDGER)
    d1, d2, d3 = a["sessions"]
    assert (d1["s_trades"], d1["fwd_trades"], d1["both"], d1["s_only"], d1["fwd_only"]) == (2, 2, 1, 1, 1)
    assert d1["entry_diff_cents"] == [3.0] and d1["r_diff"] == [-0.1] and d1["exit_same"] == 1
    # two tries against one: the first pairs, the second is one-sided; the estimated close never counts
    assert (d2["s_trades"], d2["fwd_trades"], d2["both"], d2["s_only"], d2["fwd_only"]) == (2, 2, 1, 1, 1)
    assert d2["entry_diff_cents"] == [-5.0] and d2["r_diff"] == [0.3] and d2["exit_different"] == 1
    assert (d2["names_s"], d2["names_fwd"], d2["names_both"]) == (1, 2, 1)
    assert (d3["s_trades"], d3["fwd_trades"], d3["both"], d3["entries_off"]) == (0, 1, 0, True)
    t = a["total"]
    assert (t["s_trades"], t["fwd_trades"], t["both"], t["names_both"], t["sessions_with_a_pair"]) == (4, 5, 2, 2, 2)
    assert (t["exit_same"], t["exit_different"], t["exit_unclassified"]) == (1, 1, 0)
    assert t["entry_diff_cents"] == {"n": 2, "mean": -1.0, "mean_abs": 4.0, "max_abs": 5.0}
    assert t["r_diff"] == {"n": 2, "mean": 0.1, "mean_abs": 0.2, "max_abs": 0.3}
    assert t["s_excluded"] == {"not_entry_origin": 1, "other_trial": 0, "no_entry_price": 0, "estimated_exit": 1,
                               "no_r": 0}


def test_no_name_and_no_setup_word_comes_out():
    text = json.dumps(sa.compare(JOURNAL, LEDGER))
    assert not any(w in text for w in ("AAAA", "BBBB", "CCCC", "ZZSETUP", "REV", "symbol"))


def test_exit_classes_cover_both_vocabularies():
    for reason, want in (("stop", "stop"), ("target", "target"), ("time_stop_5m", "time_stop"),
                         ("eod_flatten", "eod"), ("eod_market", "eod"), ("eod_verify", "eod"),
                         ("exit", "other"), ("adopted_exit", "other"), ("rule", "other"), ("", "other"), (None, "other")):
        assert sa.exit_class(reason) == want
    j = [armed(D1), closed(D1, "AAAA", 5.0, 5.2, 4.5, "exit")]
    t = sa.compare(j, [fwd(D1, "AAAA", 5.0, 0.4, "target"), marker(D1)])["total"]
    assert (t["both"], t["exit_same"], t["exit_different"], t["exit_unclassified"]) == (1, 0, 0, 1)


def test_rows_that_are_not_the_rules_own_priced_trade_are_left_out_and_counted():
    j = [armed(D1), closed(D1, "AAAA", 5.0, 5.2, 4.5, "target", n=0, origin="orphan"),
         closed(D1, "AAAA", 5.0, 5.2, 4.5, "target", n=1, trial="HYP-0099"),
         closed(D1, "AAAA", 0.0, 5.2, 4.5, "target", n=2, R=None),
         closed(D1, "AAAA", 5.0, 5.2, 4.5, "target", n=3, exit_price_estimated=None),
         closed(D1, "AAAA", 5.0, 5.2, 4.5, "target", n=4, R=float("nan")),
         closed(D1, "AAAA", 5.0, 5.2, 4.5, "target", n=5)]
    t = sa.compare(j, [fwd(D1, "AAAA", 5.0, 0.4, "target"), marker(D1)])["total"]
    assert t["s_trades"] == 1 and t["both"] == 1
    assert t["s_excluded"] == {"not_entry_origin": 1, "other_trial": 1, "no_entry_price": 1, "estimated_exit": 1,
                               "no_r": 1}


def test_an_absent_or_empty_journal_is_no_sessions_yet(tmp_path):
    assert sa.read_rows(tmp_path / "none.jsonl") == []
    for journal in ([], sa.read_rows(tmp_path / "none.jsonl")):
        a = sa.compare(journal, LEDGER)
        assert a["sessions"] == [] and a["total"]["sessions"] == 0 and a["total"]["fwd_only_sessions"] == 4
        assert a["total"]["entry_diff_cents"] == {"n": 0, "mean": None, "mean_abs": None, "max_abs": None}
    assert sa.compare([], [])["total"]["sessions"] == 0


def test_a_torn_line_is_skipped(tmp_path):
    p = tmp_path / "j.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in JOURNAL[:2]) + '\n[1, 2]\n{"event": "trade_clo')
    assert sa.read_rows(p) == JOURNAL[:2]


def card(tmp_path, monkeypatch, journal):
    fwd_path, js = tmp_path / "fwd.jsonl", tmp_path / "smallcap_journal.jsonl"
    fwd_path.write_text("\n".join(json.dumps(r) for r in LEDGER))
    if journal is not None:
        js.write_text("\n".join(json.dumps(r) for r in journal) + '\n{"torn')
    monkeypatch.setattr(sc, "FWD", fwd_path)
    monkeypatch.setattr(sc, "JOURNAL", tmp_path / "no_journal.jsonl")
    monkeypatch.setattr(sc, "JOURNAL_S", js)
    monkeypatch.setattr(sc, "ROOT", tmp_path)
    monkeypatch.setattr(sc, "SCORECARD_DIR", tmp_path / "scorecards")
    monkeypatch.setattr(sc, "ROUTINE_DIR", tmp_path / "routine")
    for exp, name in sc.EXPECT.values():
        p = tmp_path / "research/experiments" / exp
        p.mkdir(parents=True, exist_ok=True)
        (p / "results.json").write_text(json.dumps({"results": {name: {"trades": [{"R": 0.1, "date": "d0"},
                                                                                 {"R": -1.0, "date": "d1"}]}}}))
    md = sc.main(dt.datetime(2026, 12, 4, 21, 0, tzinfo=ZoneInfo("America/New_York")))
    return md[md.index("## 5."):]


def test_the_scorecard_section_reports_counts_and_differences(tmp_path, monkeypatch):
    s = card(tmp_path, monkeypatch, JOURNAL)
    assert s.startswith("## 5. Sleeve S against the forward test (EXP-0051)")
    assert f"(HYP-0019): **3** ({D1} → {D3})" in s and "sleeve S (HYP-0070)" in s
    assert "only sleeve S ran: 1 · only the forward test ran: 1" in s
    assert "| Trades | 4 | 5 | 2 |" in s
    assert "- Pairs: entry mean -1.0¢ · mean absolute 4.0¢ · largest 5.0¢ (n=2)" in s
    assert "- Pairs: exit class same 1 · different 1\n" in s
    assert "- Pairs: R mean +0.10R · mean absolute 0.20R · largest 0.30R (n=2)" in s
    assert "sessions sleeve S armed with entries off: 1" in s
    assert "exit price estimated 1 · not the rule's own entry 1 · other 0" in s
    assert not any(w in s for w in ("AAAA", "CCCC", "ZZSETUP", "REV-1", "reversal"))   # ids, never a name
    assert s.rstrip().endswith("any change requires a new decision record (research/decisions)._")


def test_the_scorecard_section_without_a_journal_says_no_sessions_yet(tmp_path, monkeypatch):
    s = card(tmp_path, monkeypatch, None)
    assert "No sessions yet" in s and "only the forward test ran: 4" in s and "| Trades |" not in s
    s = card(tmp_path, monkeypatch, [armed(D1)])
    assert "(HYP-0019): **1**" in s and "| Trades | 0 | 2 | 0 |" in s
    assert "- No trade in the same name on the same session yet." in s and "Pairs:" not in s


def test_a_failing_comparison_costs_only_its_section(tmp_path, monkeypatch):
    def broken(*a):
        raise RuntimeError("boom")

    monkeypatch.setattr(sc.s_agreement, "compare", broken)
    s = card(tmp_path, monkeypatch, JOURNAL)
    assert "- Not available this week (RuntimeError)." in s
