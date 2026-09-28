import importlib.util
import json
from pathlib import Path

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
    j = [{"event": "armed", "day": "2026-10-01"}, {"event": "armed", "day": "2026-10-02"},
         {"event": "trade_closed", "day": "2026-10-01", "R": 0.5, "virtual": {"equity": 601, "settled_cash": 300, "latched": False}},
         {"event": "loop_error", "error": "x"}]
    jr.write_text("\n".join(json.dumps(x) for x in j))
    monkeypatch.setattr(sc, "FWD", fwd)
    monkeypatch.setattr(sc, "JOURNAL", jr)
    monkeypatch.setattr(sc, "ROOT", tmp_path)
    (tmp_path / "research/experiments/EXP-0005b-g1-etf-dev-realcost").mkdir(parents=True)
    for exp, name in sc.EXPECT.values():
        p = tmp_path / "research/experiments" / exp
        p.mkdir(parents=True, exist_ok=True)
        (p / "results.json").write_text(json.dumps({"results": {name: {"trades": [{"R": r, "date": f"d{k}"} for k, r in enumerate([0.1, -1, 2, 0.3] * 10)]}}}))
    md = sc.main()
    assert "BELOW expectation" in md                      # -1R forward vs positive backtest -> warning
    assert "**1/2** = 50%" in md                          # paper traded 10-01, forward B traded both days
    assert "loop errors 1" in md and "NOT met" in md      # incident surfaces and blocks G2
