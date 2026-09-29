"""wt.analytics.ops_view: SLA matrix, blotter, digest and audit trail."""
import datetime as dt
import json

from wt.analytics import ops_view as ov
from wt.ops import audit

TODAY = dt.date(2026, 10, 2)                       # a Friday
SESSIONS = {TODAY - dt.timedelta(days=i): object() for i in range(14)
            if (TODAY - dt.timedelta(days=i)).weekday() < 5}


def run(job, day, status="ok", hour=12):
    return {"job": job, "status": status, "started": f"{day}T{hour:02d}:00:00+00:00"}


def cell(m, job, day):
    return next(c for c in m["cells"] if c["job"] == job and c["date"] == str(day))


def test_sla_cells_and_summary():
    d1, d2, d3 = TODAY - dt.timedelta(days=3), TODAY - dt.timedelta(days=2), TODAY - dt.timedelta(days=1)
    runs = [run("paper-b", d1), run("paper-b", d2, "refused"), run("dashboard", d1), run("dashboard", d2),
            run("dashboard", d2, "failed"), run("dashboard", d3, "failed"), run("forward", d1, "timeout")]
    m = ov.sla(runs, TODAY, SESSIONS)
    assert len(m["days"]) == 14 and m["days"][-1] == str(TODAY)
    assert cell(m, "paper-b", d1)["status"] == "ok" and cell(m, "paper-b", d2)["status"] == "refused"
    assert cell(m, "paper-b", d3)["status"] == "missed"                      # a session day with no run
    assert cell(m, "paper-b", TODAY)["status"] == "n/a"                      # today may still run
    assert cell(m, "paper-b", TODAY - dt.timedelta(days=4))["status"] == "n/a"   # before its first run
    assert cell(m, "dashboard", d2) == {"job": "dashboard", "date": str(d2), "status": "partial", "runs": 2}
    assert cell(m, "dashboard", d3)["status"] == "failed" and cell(m, "forward", d1)["status"] == "failed"
    assert cell(m, "routine", d1)["status"] == "n/a"                          # never ran at all
    pb = next(s for s in m["summary"] if s["job"] == "paper-b")
    assert pb == {"job": "paper-b", "expected": 3, "ok": 1, "refused": 1, "failed": 0, "missed": 1, "ok_pct": 33.3}


def test_sla_weekend_is_none_not_missed():
    sat = TODAY - dt.timedelta(days=6)                                       # 2026-09-26, a Saturday
    m = ov.sla([run("paper-b", sat - dt.timedelta(days=1))], TODAY, SESSIONS)
    assert cell(m, "paper-b", sat)["status"] == "none"


def test_blotter_keeps_prices_and_r_only():
    rows = [{"event": "armed"}, {"event": "trade_closed", "day": "2026-10-01", "symbol": "QQQM", "qty": 2,
             "entry": 200.0, "exit": 202.0, "stop": 199.0, "R": 2.0, "reason": "target", "origin": "entry",
             "exit_price_estimated": False, "booked": True, "virtual": {"equity": 604.0}}]
    b = ov.blotter(rows)
    assert b == [{"date": "2026-10-01", "symbol": "QQQM", "qty": 2, "entry": 200.0, "exit": 202.0, "stop": 199.0,
                  "r": 2.0, "reason": "target", "origin": "entry", "estimated": False, "booked": True}]


def test_digest_is_write_once_per_day_and_compares_with_the_last_day(tmp_path):
    (tmp_path / "2026-09-30.json").write_text(json.dumps({"cum_r": 1.0, "kill": True, "firing": 0}))
    first = ov.digest({"cum_r": 1.5, "kill": True, "firing": 0}, tmp_path, TODAY)
    again = ov.digest({"cum_r": 9.0, "kill": False, "firing": 3}, tmp_path, TODAY)
    assert first["since"] == "2026-09-30"
    items = {i["key"]: i for i in again["items"]}
    assert items["cum_r"] == {"key": "cum_r", "label": "Cumulative R", "prev": "1.0", "now": "9.0", "changed": True}
    assert json.loads((tmp_path / f"{TODAY}.json").read_text())["cum_r"] == 1.5      # first snapshot kept


def test_digest_without_history_is_empty(tmp_path):
    assert ov.digest({"cum_r": 0}, tmp_path, TODAY) == {"since": None, "items": []}


def test_digest_metrics_from_a_snapshot():
    snap = {"ops": {"paper": {"virtual": {"equity": 612.0, "start": 600.0}, "total_r": 2.5, "trades": 3,
                              "g2": {"trades": 3}}, "deployed": {"head": "f53c9aa0123456789"}},
            "alerts": {"firing": [{"key": "x"}]}, "kill": {"on": True}, "preflight": [{"ok": True}, {"ok": False}]}
    assert ov.digest_metrics(snap) == {"equity_pct": 2.0, "cum_r": 2.5, "trades": 3, "firing": 1, "kill": True,
                                       "head": "f53c9aa01234", "preflight_failed": 1, "g2_trades": 3}


def test_audit_trail_merges_sources_in_time_order_without_owner_text(tmp_path):
    dep = tmp_path / "20260929T064229Z.json"
    dep.write_text(json.dumps({"to": "f53c9aa0123456789", "smoke_ok": True}))
    (tmp_path / "junk.json").write_text("{}")
    log = tmp_path / "events.jsonl"
    audit.append("kill_on", "owner's private reason", path=log, now=dt.datetime(2026, 9, 30, 1, tzinfo=dt.UTC))
    ev = ov.audit_trail(deploys=[dep, tmp_path / "junk.json"],
                        account={"latch_history": [{"at": "2026-09-28T00:00:00+00:00", "reason": "secret"}]},
                        runs=[run("paper-b", "2026-09-29", "refused"), run("paper-b", "2026-09-30")],
                        alert_history=[{"at": "2026-09-30T02:00:00+00:00", "event": "fired", "title": "late"}],
                        audit_rows=audit.read(log))
    assert [e["kind"] for e in ev] == ["latch_reset", "deploy", "job_refused", "kill_on", "alert_fired"]
    assert "private" not in json.dumps(ev) and "secret" not in json.dumps(ev)
    assert ev[1]["detail"] == "to f53c9aa01234; smoke ok"


def test_audit_log_chain_detects_edits(tmp_path):
    log = tmp_path / "events.jsonl"
    for k in ("kill_on", "kill_off", "kill_on"):
        audit.append(k, path=log)
    rows = audit.read(log)
    assert audit.verify(rows) == (True, None)
    rows[1]["kind"] = "note"
    assert audit.verify(rows) == (False, 1)
    assert audit.verify(audit.read(log)[1:]) == (False, 0)          # a dropped head breaks the chain too
    assert audit.main(["bogus"]) == 2



def test_a_torn_audit_line_is_ended_and_skipped(tmp_path):
    log = tmp_path / "events.jsonl"
    audit.append("kill_on", path=log)
    with open(log, "a") as f:
        f.write('{"seq": 1, "kind": "kill_o')                    # a crash mid-write
    audit.append("kill_off", path=log)
    rows = audit.read(log)
    assert [r.get("kind") for r in rows if "_bad" not in r] == ["kill_on", "kill_off"]
    assert sum(1 for r in rows if "_bad" in r) == 1 and audit.verify(rows) == (True, None)
