"""The v3 snapshot contract: a superset of v2, enum leaves, a payload budget, and a fixture that can't go stale."""
import datetime as dt
import importlib.util
import json
from pathlib import Path

from wt.ops import publish

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("gen_fixture", ROOT / "scripts" / "gen_fixture.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)


def test_schema_version_is_3_and_the_schema_file_is_current():
    assert publish.SCHEMA_VERSION == 3
    assert json.loads(publish.SCHEMA_PATH.read_text()) == publish.to_schema()


def test_a_v2_snapshot_still_validates():
    """The deployed Mac publishes v2 until it is redeployed: the dashboard must keep accepting it."""
    v2 = json.loads(gen.V2.read_text())
    assert v2["schema_version"] == 2
    assert publish.validate(v2) == []


def test_the_v3_fixture_validates_and_is_current():
    v3 = json.loads(gen.V3.read_text())
    assert v3["schema_version"] == 3 and publish.validate(v3) == []
    assert gen.main(["--check"]) == 0


def test_enum_leaves_reject_unknown_values():
    san = publish.Sanitizer(lambda x: x, None, strict=False)
    assert san.apply(publish.SLA_STATUS, "ok") == "ok"
    assert san.apply(publish.SLA_STATUS, "OK") is None and san.apply(publish.SLA_STATUS, 1) is None
    bad = json.loads(gen.V3.read_text())
    bad["sla"]["cells"][0]["status"] = "great"
    assert any("sla/cells/0/status" in e for e in publish.validate(bad))


def test_worst_case_payload_stays_under_budget():
    views = gen.synthetic(n_trades=2000, days=14, n_alerts=2000)
    assert len(views["blotter"]) == 100 and len(views["perf"]["curve"]) == 400
    assert len(views["today"]["trades"]) == 50 and len(views["today"]["days"]) == 90
    snap = gen.build_v3(json.loads(gen.V2.read_text()), views)
    body = json.dumps(snap, separators=(",", ":"))
    assert publish.validate(snap) == []
    assert len(body) < publish.BUDGET, len(body)


def test_v3_views_on_an_empty_host_are_valid(tmp_path):
    now = dt.datetime(2026, 10, 2, 20, tzinfo=dt.UTC)
    views = publish.v3_views(now, runs=[], sessions={}, kill=False, live=tmp_path / "live",
                             alert_dir=tmp_path / "alerts", deploy_dir=tmp_path / "deploy",
                             audit_log=tmp_path / "audit.jsonl")
    snap = gen.build_v3(json.loads(gen.V2.read_text()), {**views, "digest": {"since": None, "items": []}})
    assert publish.validate(snap) == []
    assert snap["perf"]["stats"]["n"] == 0 and snap["risk"]["controls"]["latched"] is None
    assert snap["audit"] == {"chain_ok": True, "chain_bad_seq": None, "rows": 0, "bad_lines": 0, "events": []}
    assert snap["today"]["session"] is None and snap["today"]["trades"] == [] and snap["today"]["pnl"]["trades"] == 0


def test_one_failing_view_leaves_the_others(tmp_path, monkeypatch, capsys):
    from wt.analytics import ops_view

    def boom(*a, **k):
        raise ZeroDivisionError

    monkeypatch.setattr(ops_view, "sla", boom)
    now = dt.datetime(2026, 10, 2, 20, tzinfo=dt.UTC)
    views = publish.v3_views(now, runs=[], sessions={}, kill=False, live=tmp_path / "live",
                             alert_dir=tmp_path / "alerts", deploy_dir=tmp_path / "deploy",
                             audit_log=tmp_path / "audit.jsonl")
    assert "sla" not in views and {"risk", "perf", "blotter", "audit", "alerts_history"} <= set(views)
    assert "v3 view sla failed (ZeroDivisionError)" in capsys.readouterr().err


def test_perf_uses_clean_sessions_and_dedupes_trades(tmp_path):
    live = tmp_path / "live"
    live.mkdir()
    rows = []
    for i in range(3):
        d = f"2026-10-0{i + 1}"
        rows += [{"ts": f"{d}T13:30:00+00:00", "event": "armed", "day": d, "kill": i == 2},
                 {"ts": f"{d}T15:00:00+00:00", "event": "trade_closed", "day": d, "trade_id": f"t{i}", "R": 1.0},
                 {"ts": f"{d}T20:00:00+00:00", "event": "session_end"}]
    rows.append(dict(rows[1]))                                     # a replayed close: counted once
    (live / "journal.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    now = dt.datetime(2026, 10, 3, 20, tzinfo=dt.UTC)
    views = publish.v3_views(now, runs=[], sessions={}, kill=False, live=live, alert_dir=tmp_path / "a",
                             deploy_dir=tmp_path / "d", audit_log=tmp_path / "audit.jsonl")
    assert views["perf"]["stats"]["n"] == 3 and views["perf"]["sessions"] == 2      # the KILL-on day isn't clean


def test_add_digest_writes_one_file_per_et_day(tmp_path):
    san = publish.Sanitizer(lambda x: x, None, strict=False)
    snap = json.loads(gen.V3.read_text())
    publish.add_digest(snap, san, dt.datetime(2026, 10, 2, 3, tzinfo=dt.UTC), daily_dir=tmp_path)
    assert [p.name for p in tmp_path.iterdir()] == ["2026-10-01.json"]       # 03:00 UTC is still Oct 1 in ET
    assert snap["digest"] == {"since": None, "items": []}
