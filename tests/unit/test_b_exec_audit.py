"""EXP-0048: B's paper execution against the backtest fill model (synthetic records only; no network)."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

from wt.core import ledger
from wt.research import b_exec_audit as bx

ROOT = Path(__file__).resolve().parents[2]


def _driver() -> Any:
    spec = importlib.util.spec_from_file_location("b_exec_audit_driver", ROOT / "scripts/b_exec_audit.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _day(day: str, *, trade: dict[str, Any] | None = None, blocked: list[list[str]] | None = None,
         extra: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = [{"ts": f"{day}T13:00:00+00:00", "event": "armed", "day": day, "kill": False,
                                   "entries_off": False, "flatten": f"{day}T15:50:00-05:00"}]
    for b in blocked or []:
        rows.append({"ts": f"{day}T15:00:00+00:00", "event": "blocked", "blockers": b})
    rows += extra or []
    if trade:
        rows += [
            {"ts": f"{day}T15:30:00+00:00", "event": "decision", "runner_acts": True,
             "signal_t": f"{day}T15:29:00+00:00"},
            {"ts": f"{day}T15:30:04+00:00", "event": "entry_placed", "trigger": trade["trigger"],
             "stop": trade["stop"], "target": trade["target"], "ratio": 0.4, "qty": 10},
            {"ts": f"{day}T15:30:10+00:00", "event": "entry_filled", "price": trade["entry"], "qty": 10,
             "trade_id": f"B-{day}"},
            {"ts": trade.get("closed_ts", f"{day}T20:51:00+00:00"), "event": "trade_closed", "day": day,
             "entry": trade["entry"], "exit": trade["exit"], "stop": trade["stop"], "R": trade["R"],
             "reason": trade["reason"], "exit_price_estimated": trade.get("estimated", False),
             "trade_id": f"B-{day}"}]
    rows += [{"ts": f"{day}T21:05:00+00:00", "event": "decision_summary", "asked": 13, "marks": 13,
              "spread_only_marks": 2, "would_signals": 1},
             {"ts": f"{day}T21:06:00+00:00", "event": "session_end", "outcome": "ok"}]
    return rows


T1 = {"trigger": 100.0, "stop": 99.0, "target": 102.0, "entry": 100.05, "exit": 102.0, "R": 1.9, "reason": "target"}
T2 = {"trigger": 200.0, "stop": 198.0, "target": 204.0, "entry": 200.0, "exit": 197.9, "R": -1.05, "reason": "stop"}
T3 = {"trigger": 50.0, "stop": 49.5, "target": 51.0, "entry": 50.02, "exit": 50.3, "R": 0.56, "reason": "eod_flatten"}


def _plan(day: str, t: dict[str, Any], log: list[list[Any]] | None = None) -> dict[str, Any]:
    return {"date": day, "trigger": t["trigger"], "stop": t["stop"], "target": t["target"],
            "limit": round(t["trigger"] + 0.1 * (t["trigger"] - t["stop"]), 2), "avg_entry": t["entry"],
            "exit_reason": t["reason"], "log": log or []}


def _snapshot(tmp: Path, days: list[list[dict[str, Any]]], plans: list[dict[str, Any]],
              replay: list[dict[str, Any]] | None = None) -> Path:
    snap = tmp / "snap"
    (snap / "plans").mkdir(parents=True)
    (snap / "replay").mkdir()
    for rows in days:
        for r in rows:
            ledger.append(snap / "journal.jsonl", r)
    for p in plans:
        (snap / "plans" / f"plan_{p['date']}.json").write_text(json.dumps(p))
    for r in replay or []:
        (snap / "replay" / f"{r['session']}.json").write_text(json.dumps(r))
    return snap


def _rows(snap: Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in (snap / "journal.jsonl").read_text().splitlines() if x]


def test_entry_and_exit_shortfall_against_the_model(tmp_path: Path) -> None:
    flat_log = [["exit_failed", "eod_flatten", "sell within long position: shares held"],
                ["exit_unfilled_restopped", 10], ["closed", "eod_flatten", 50.3]]
    snap = _snapshot(tmp_path, [_day("2026-10-01", trade=T1), _day("2026-10-02", trade=T2),
                                _day("2026-10-05", trade=T3)],
                     [_plan("2026-10-01", T1), _plan("2026-10-02", T2), _plan("2026-10-05", T3, flat_log)])
    sess = bx.sessions(_rows(snap), "2026-10-05")
    fs = bx.fills(sess, {p: json.loads((snap / "plans" / f"plan_{p}.json").read_text())
                         for p in ("2026-10-01", "2026-10-02", "2026-10-05")})
    by = {f.day: f for f in fs}
    # entry: (100.05 - 100 - 0.022 * 0.4) / 1 = 0.0412 R
    assert bx.entry_shortfall_R(by["2026-10-01"]) == pytest.approx(0.0412)
    # target filled at the target: no shortfall; stop: model 198 - 0.0088, paper 197.9 -> 0.0912 / 2 R
    assert bx.exit_shortfall_R(by["2026-10-01"]) == pytest.approx(0.0)
    assert bx.exit_shortfall_R(by["2026-10-02"]) == pytest.approx((197.9912 - 197.9) / 2)
    assert bx.exit_shortfall_R(by["2026-10-05"]) is None            # a flatten is not measurable here
    assert by["2026-10-01"].placed_latency_s == pytest.approx(4.0)  # bar 15:29 closes 15:30:00; placed 15:30:04
    assert by["2026-10-01"].fill_latency_s == pytest.approx(6.0)
    assert by["2026-10-05"].flatten_delay_s == pytest.approx(60.0)  # 15:50 ET flatten, closed 20:51 UTC
    out = bx.aggregate(sess, fs, n_boot=200)
    assert out["trades"] == 3 and out["sessions"]["armed"] == 3
    assert out["exit_by_kind"]["eod_flatten"] == {"trades": 1, "measured": 0, "estimated_price_excluded": 0,
                                                 "shortfall_R": {"n": 0}}
    assert out["incidents"]["trades_with"]["exit_failed"] == 1
    assert out["incidents"]["exit_failed_kinds"] == {"sell_exceeds_available": 1, "other": 0}
    assert out["incidents"]["trades_with_any_exit_incident"] == 1
    assert out["entry"]["filled_within_collar"] == 3
    assert out["decision_marks"] == {"summaries": 3, "asked": 39, "marks": 39, "spread_only_marks": 6,
                                     "would_signals": 3}
    assert "ci95" in out["entry"]["shortfall_vs_model_R"]


def test_output_carries_no_per_trade_value(tmp_path: Path) -> None:
    snap = _snapshot(tmp_path, [_day("2026-10-01", trade=T1)], [_plan("2026-10-01", T1)])
    sess = bx.sessions(_rows(snap), "2026-10-01")
    fs = bx.fills(sess, {"2026-10-01": _plan("2026-10-01", T1)})
    text = json.dumps(bx.aggregate(sess, fs, n_boot=50))
    for leak in ("100.05", "102.0", "1.9", "2026-10-01", "B-2026"):
        assert leak not in text
    for key in ('"R"', '"exit"', '"pnl"', '"reason"', '"virtual"'):
        assert key not in text


def test_estimated_exit_is_excluded_and_counted(tmp_path: Path) -> None:
    t = {**T2, "estimated": True}
    snap = _snapshot(tmp_path, [_day("2026-10-02", trade=t)], [_plan("2026-10-02", t)])
    sess = bx.sessions(_rows(snap), "2026-10-02")
    out = bx.aggregate(sess, bx.fills(sess, {"2026-10-02": _plan("2026-10-02", t)}), n_boot=50)
    assert out["exit_by_kind"]["stop"]["measured"] == 0
    assert out["exit_by_kind"]["stop"]["estimated_price_excluded"] == 1


def test_cutoff_drops_later_sessions(tmp_path: Path) -> None:
    snap = _snapshot(tmp_path, [_day("2026-10-01", trade=T1), _day("2026-10-02", trade=T2)],
                     [_plan("2026-10-01", T1), _plan("2026-10-02", T2)])
    sess = bx.sessions(_rows(snap), "2026-10-01")
    assert [s.day for s in sess] == ["2026-10-01"]


def test_blockers_by_registered_category(tmp_path: Path) -> None:
    snap = _snapshot(tmp_path, [_day("2026-10-01", blocked=[["spread_or_no_quote"], ["event:skip:CPI", "latched:x"]]),
                                _day("2026-10-02", blocked=[["spread_or_no_quote"], ["something_new"]])], [])
    b = bx.blockers(bx.sessions(_rows(snap), "2026-10-02"))
    assert b["blocked_rows"] == 4
    assert b["marks_by_category"]["spread_or_no_quote"] == 2
    assert b["sessions_by_category"]["spread_or_no_quote"] == 2
    assert b["marks_by_category"]["event"] == 1 and b["marks_by_category"]["latched"] == 1
    assert b["marks_by_category"]["other"] == 1


def test_faults_are_counted_by_event(tmp_path: Path) -> None:
    extra = [{"ts": "2026-10-01T15:00:00+00:00", "event": "loop_error", "error": "boom"},
             {"ts": "2026-10-01T15:01:00+00:00", "event": "loop_error", "error": "boom"},
             {"ts": "2026-10-01T15:02:00+00:00", "event": "brand_new_event"}]
    snap = _snapshot(tmp_path, [_day("2026-10-01", extra=extra)], [])
    f = bx.faults(bx.sessions(_rows(snap), "2026-10-01"))
    assert f["rows"]["loop_error"] == 2 and f["sessions"]["loop_error"] == 1
    assert f["other_events"] == 1


def test_journal_plan_mismatch_raises(tmp_path: Path) -> None:
    snap = _snapshot(tmp_path, [_day("2026-10-01", trade=T1)], [])
    sess = bx.sessions(_rows(snap), "2026-10-01")
    with pytest.raises(bx.SnapshotError, match="no plan file"):
        bx.fills(sess, {})
    with pytest.raises(bx.SnapshotError, match="disagree"):
        bx.fills(sess, {"2026-10-01": {**_plan("2026-10-01", T1), "avg_entry": 100.5}})


def test_reconcile_reports_differences(tmp_path: Path) -> None:
    snap = _snapshot(tmp_path, [_day("2026-10-01", trade=T1), _day("2026-10-02", trade=T2)],
                     [_plan("2026-10-01", T1), _plan("2026-10-02", T2)])
    sess = bx.sessions(_rows(snap), "2026-10-02")
    fs = bx.fills(sess, {"2026-10-01": _plan("2026-10-01", T1), "2026-10-02": _plan("2026-10-02", T2)})
    assert bx.reconcile(fs, sess, {"trades": 2, "total_R": 0.85, "armed_sessions": 2}) == []
    assert len(bx.reconcile(fs, sess, {"trades": 3, "total_R": 0.80, "armed_sessions": 2})) == 2


def test_summary_small_samples() -> None:
    assert bx.summary([], 1, 10) == {"n": 0}
    one = bx.summary([0.5], 1, 10)
    assert one == {"n": 1, "mean": 0.5, "median": 0.5}
    three = bx.summary([0.0, 1.0, 2.0], 1, 500)
    assert three["sd"] == pytest.approx(1.0) and three["ci95"][0] <= 1.0 <= three["ci95"][1]
    assert three["detectable_mean_80pct"] == pytest.approx(2.8015852 / 3 ** 0.5, rel=1e-6)


def _cfg(exp: Path, **reconcile: Any) -> None:
    exp.mkdir(parents=True)
    (exp / "config.yaml").write_text(json.dumps({
        "cutoff": {"last_session": "2026-10-02"}, "seed": 48, "n_boot": 200,
        "reconcile": reconcile or {"trades": 2, "total_R": 0.85, "armed_sessions": 2}}))


def test_driver_runs_checks_and_refuses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d = _driver()
    monkeypatch.setattr(d, "EXPS", tmp_path / "exps")
    monkeypatch.setattr(d, "ROOT", tmp_path)
    import wt.research.manifest as man
    monkeypatch.setattr(man, "assert_clean_for_preregistered_run", lambda root=None: "sha")
    monkeypatch.setattr(man, "write_manifest", lambda *a, **k: {})
    rec = {"session": "2026-10-01", "replay_vs_journal": "same", "forward_vs_replay": "same"}
    snap = _snapshot(tmp_path, [_day("2026-10-01", trade=T1), _day("2026-10-02", trade=T2)],
                     [_plan("2026-10-01", T1), _plan("2026-10-02", T2)], replay=[rec])
    assert d.main(["EXP-9999-unregistered", "--snapshot", str(snap)]) == 1
    _cfg(tmp_path / "exps/EXP-0001-x")
    assert d.main(["EXP-0001-x", "--snapshot", str(snap)]) == 0
    res = json.loads((tmp_path / "exps/EXP-0001-x/results.json").read_text())
    assert res["trades"] == 2 and res["replay"]["replay_vs_journal"]["same"] == 1
    assert res["inputs"]["journal"]["chain_intact"] is True
    assert d.main(["EXP-0001-x", "--snapshot", str(snap), "--check"]) == 0
    assert d.main(["EXP-0001-x", "--snapshot", str(snap)]) == 1        # append-only: no overwrite
    _cfg(tmp_path / "exps/EXP-0002-y", trades=5, total_R=0.85, armed_sessions=2)
    assert d.main(["EXP-0002-y", "--snapshot", str(snap)]) == 2        # reconcile fails loudly


def test_driver_refuses_a_broken_chain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d = _driver()
    monkeypatch.setattr(d, "EXPS", tmp_path / "exps")
    import wt.research.manifest as man
    monkeypatch.setattr(man, "assert_clean_for_preregistered_run", lambda root=None: "sha")
    snap = _snapshot(tmp_path, [_day("2026-10-01", trade=T1), _day("2026-10-02", trade=T2)],
                     [_plan("2026-10-01", T1), _plan("2026-10-02", T2)])
    lines = (snap / "journal.jsonl").read_text().splitlines()
    lines[1] = lines[1].replace('"event"', '"x": 1, "event"', 1)      # still JSON, no longer the chained line
    (snap / "journal.jsonl").write_text("\n".join(lines) + "\n")
    _cfg(tmp_path / "exps/EXP-0001-x")
    assert d.main(["EXP-0001-x", "--snapshot", str(snap)]) == 2
