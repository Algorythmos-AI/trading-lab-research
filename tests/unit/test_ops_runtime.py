"""Runtime safety net (PR 2): schedule, deploy gate windows, alerts, locks, preflight, migration, job runner."""
from __future__ import annotations

import datetime as dt
import json
import plistlib
import subprocess
import sys
from pathlib import Path

import pytest

from wt.core.clock import ET
from wt.ops import agents, alerts, jobs, migrate, preflight, window
from wt.ops.heartbeat import Heartbeat, last_runs
from wt.ops.locks import is_held, job_lock
from wt.ops.schedule import JOBS, SYDNEY, Job

UTC = dt.UTC


def syd(y, m, d, hh, mm):
    return dt.datetime(y, m, d, hh, mm, tzinfo=SYDNEY)


def cal(*days, close="16:00"):
    return window.sessions_from_calendar([{"date": d, "open": "09:30", "close": close} for d in days])


# ---- windows across the three offset regimes (Sydney standard time never overlaps US standard time) ----------

@pytest.mark.parametrize("session, blocked, open_, regime", [
    # AEST/EDT: close 16:00 EDT = 06:00 AEST; blocked until close + 2 h = 08:00 Sydney
    ("2026-09-30", syd(2026, 10, 1, 7, 30), syd(2026, 10, 1, 8, 30), "AEST/EDT"),
    # AEDT/EDT (Sydney DST from 2026-10-04): close = 07:00 AEDT; the old "06:40 is safe" rule was wrong here
    ("2026-10-14", syd(2026, 10, 15, 8, 30), syd(2026, 10, 15, 9, 30), "AEDT/EDT"),
    # AEDT/EST (US DST ends 2026-11-01): close = 08:00 AEDT
    ("2026-11-11", syd(2026, 11, 12, 9, 45), syd(2026, 11, 12, 10, 15), "AEDT/EST"),
    # AEDT/EDT again in March (US DST starts first)
    ("2027-03-24", syd(2027, 3, 25, 8, 30), syd(2027, 3, 25, 9, 30), "AEDT/EDT (March)"),
])
def test_trading_blackout_follows_the_new_york_close(session, blocked, open_, regime):
    s = cal(session)
    assert window.trading_blackout(blocked, s) is not None, regime
    assert window.trading_blackout(open_, s) is None, regime


def test_blackout_starts_at_0700_et_and_ignores_non_sessions():
    s = cal("2026-09-30")
    assert window.trading_blackout(dt.datetime(2026, 9, 30, 6, 59, tzinfo=ET), s) is None
    assert window.trading_blackout(dt.datetime(2026, 9, 30, 7, 0, tzinfo=ET), s) is not None
    assert window.trading_blackout(dt.datetime(2026, 10, 3, 12, 0, tzinfo=ET), s) is None   # Saturday


def test_half_day_close_shortens_the_window():
    s = cal("2026-11-27", close="13:00")
    assert window.trading_blackout(dt.datetime(2026, 11, 27, 14, 59, tzinfo=ET), s) is not None
    assert window.trading_blackout(dt.datetime(2026, 11, 27, 15, 1, tzinfo=ET), s) is None


def test_upcoming_start_blocks_the_hour_before_a_job():
    assert any("com.wt.routine" in x for x in window.upcoming_starts(syd(2026, 9, 30, 20, 45)))
    assert window.upcoming_starts(syd(2026, 9, 30, 14, 0)) == []


def test_deploy_blockers_combines_every_reason():
    now = syd(2026, 9, 30, 14, 0)
    assert window.deploy_blockers(now, cal("2026-09-29"), {"com.wt.paper-b": False}, []) == []
    b = window.deploy_blockers(now, cal("2026-09-29"), {"com.wt.paper-b": True}, ["forward"], exact_calendar=False)
    assert any("running" in x for x in b) and any("lock" in x for x in b) and any("calendar" in x for x in b)


def test_forward_waits_for_close_plus_20_only_during_the_session():
    s = cal("2026-09-30")
    # launched 05:40 AEST = 15:40 EDT: wait until 16:20 EDT
    assert window.forward_wait_until(syd(2026, 10, 1, 5, 40), s) == dt.datetime(2026, 9, 30, 16, 20, tzinfo=ET)
    # AEDT/EST: 05:40 AEDT = 13:40 EST, still waits for the close
    s2 = cal("2026-11-11")
    assert window.forward_wait_until(syd(2026, 11, 12, 5, 40), s2) == dt.datetime(2026, 11, 11, 16, 20, tzinfo=ET)
    # late wake-up after close + 20, a weekend, or before the open: run at once (catch-up), never wait a day
    assert window.forward_wait_until(dt.datetime(2026, 9, 30, 18, 0, tzinfo=ET), s) is None
    assert window.forward_wait_until(dt.datetime(2026, 10, 3, 9, 0, tzinfo=ET), s) is None
    assert window.forward_wait_until(dt.datetime(2026, 9, 30, 8, 0, tzinfo=ET), s) is None


def test_weekly_job_fires_on_saturday_only():
    fires = JOBS["weekly"].fires(syd(2026, 9, 29, 12, 0), days=8)
    assert fires and all(f.isoweekday() == 6 and f.hour == 11 for f in fires)


# ---- alerts ----------------------------------------------------------------------------------------------------

@pytest.fixture
def sent(monkeypatch):
    box: list[dict] = []
    ok = {"value": True}

    def fake_send(msg, topic, server, timeout=5.0):
        if not ok["value"] or not topic:
            return False
        box.append(msg)
        return True
    monkeypatch.setattr(alerts, "_send", fake_send)
    return box, ok


def test_scrub_removes_money_and_account_ids_but_keeps_dates_and_r():
    s = alerts.scrub("equity US$612.40, loss $-12.5 on PA3T8Y4VW2KV; see logs/paper_b_20260929.log; -1.00R 2.5%")
    assert "612" not in s and "12.5" not in s and "PA3T8Y4VW2KV" not in s
    assert "20260929" in s and "-1.00R" in s and "2.5%" in s


def test_fire_and_resolve_send_only_on_transitions(tmp_path, sent):
    box, _ = sent
    a = alerts.Alerts(root=tmp_path, topic="t")
    assert a.fire("job:x", "x failed", "exit 1") is True
    assert a.fire("job:x", "x failed", "exit 1") is False           # still firing: not repeated
    assert a.resolve("job:x", "x ok", "fine") is True
    assert a.resolve("job:x", "x ok", "fine") is False
    assert [m["title"] for m in box] == ["x failed", "x ok"]


def test_a_once_per_day_alert_stops_counting_as_firing_after_the_next_day(tmp_path, sent):
    a = alerts.Alerts(root=tmp_path, topic="t")
    today = dt.datetime.now(dt.UTC).date()
    for back in (0, 1, 2, 9):
        a.once_per_day("summary", "daily summary", "x", day=(today - dt.timedelta(days=back)).isoformat())
    a.fire("job:routine", "routine failed", "exit 1")               # a condition: fires until it is resolved
    assert set(a.firing()) == {"job:routine", f"summary:{today}", f"summary:{today - dt.timedelta(days=1)}"}


def test_once_per_day(tmp_path, sent):
    box, _ = sent
    a = alerts.Alerts(root=tmp_path, topic="t")
    assert a.once_per_day("refuse:routine", "refused", "disk", day="2026-09-29")
    assert not a.once_per_day("refuse:routine", "refused", "disk", day="2026-09-29")
    assert a.once_per_day("refuse:routine", "refused", "disk", day="2026-09-30")
    assert len(box) == 2


def test_offline_messages_spool_then_flush_in_order(tmp_path, sent):
    box, ok = sent
    ok["value"] = False
    a = alerts.Alerts(root=tmp_path, topic="t")
    a.notify("first", "1")
    a.notify("second", "2")
    assert len(list((tmp_path / "spool").glob("*.json"))) == 2 and box == []
    ok["value"] = True
    a.notify("third", "3")
    assert [m["title"] for m in box] == ["first", "second", "third"]
    assert list((tmp_path / "spool").glob("*.json")) == []


def test_no_topic_means_alerts_off_nothing_spooled(tmp_path, sent):
    a = alerts.Alerts(root=tmp_path, topic="")
    assert a.notify("t", "m") is False
    assert not (tmp_path / "spool").exists() or list((tmp_path / "spool").glob("*.json")) == []


def _age_spool(tmp_path, days: float) -> None:
    for f in (tmp_path / "spool").glob("*.json"):
        m = json.loads(f.read_text())
        m["at"] = (dt.datetime.now(dt.UTC) - dt.timedelta(days=days)).isoformat()
        f.write_text(json.dumps(m))


def test_urgent_spooled_alerts_outlive_a_day_and_say_they_are_late(tmp_path, sent):
    box, ok = sent
    ok["value"] = False
    a = alerts.Alerts(root=tmp_path, topic="t")
    a.notify("not flat", "check the broker", priority=5)
    a.notify("summary", "daily", priority=2)
    _age_spool(tmp_path, 2)                                        # the host was offline for two days
    ok["value"] = True
    assert a.flush() == 1
    assert [m["title"] for m in box] == ["not flat"] and box[0]["message"].startswith("(delayed: raised ")
    ok["value"] = False
    a.notify("latched", "limit", priority=5)
    _age_spool(tmp_path, 8)                                        # a week late is too late even for priority 5
    ok["value"] = True
    assert a.flush() == 0


def test_the_spool_is_capped(tmp_path, sent, monkeypatch):
    box, ok = sent
    ok["value"] = False
    monkeypatch.setattr(alerts, "SPOOL_MAX_FILES", 5)
    a = alerts.Alerts(root=tmp_path, topic="t")
    for i in range(12):
        a.notify(f"m{i}", "x", priority=4)
    left = sorted(json.loads(f.read_text())["title"] for f in (tmp_path / "spool").glob("*.json"))
    assert left == sorted(f"m{i}" for i in range(7, 12))           # the newest five survive


# ---- locks and heartbeats ----------------------------------------------------------------------------------------

def test_job_lock_is_exclusive(tmp_path):
    with job_lock("forward", tmp_path) as got:
        assert got and is_held("forward", tmp_path)
        with job_lock("forward", tmp_path) as second:
            assert second is False
    assert not is_held("forward", tmp_path)


def test_heartbeat_records_the_run(tmp_path):
    hb = Heartbeat("routine", "abc1234", tmp_path)
    hb.finish("failed", 1, "boom")
    assert last_runs(tmp_path)["routine"]["status"] == "failed"
    assert json.loads((tmp_path / "runs.jsonl").read_text().splitlines()[-1])["exit"] == 1


# ---- preflight ---------------------------------------------------------------------------------------------------

def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(cwd), "PATH": "/usr/bin:/bin:/opt/homebrew/bin"})


@pytest.fixture
def repo(tmp_path):
    origin, work = tmp_path / "origin.git", tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    work.mkdir()
    _git(work, "init", "-q", "-b", "main")
    (work / "src").mkdir()
    (work / "src" / "a.py").write_text("x = 1\n")
    (work / "requirements.lock.txt").write_text("pandas==3.0.6\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "init")
    _git(work, "remote", "add", "origin", str(origin))
    _git(work, "push", "-q", "origin", "main")
    (work / ".venv").mkdir()
    (work / preflight.LOCK_STAMP).write_text(preflight.lock_hash(work) + "\n")
    (work / ".env").write_text("A=1\n")
    (work / ".env").chmod(0o600)
    return work


def test_preflight_passes_on_a_clean_reviewed_checkout(repo):
    fails = preflight.failures(preflight.run_checks(repo, min_free_gb=0))
    assert fails == [], fails


def test_preflight_refuses_unreviewed_or_dirty_code(repo):
    (repo / "src" / "a.py").write_text("x = 2\n")
    assert "clean code" in {c.name for c in preflight.failures(preflight.run_checks(repo, min_free_gb=0))}
    _git(repo, "commit", "-qam", "local only")
    names = {c.name for c in preflight.failures(preflight.run_checks(repo, min_free_gb=0))}
    assert "reviewed commit" in names


def test_preflight_refuses_legacy_state_stale_venv_open_env_and_low_disk(repo):
    (repo / "research/forward").mkdir(parents=True)
    (repo / "research/forward/forward_trades.jsonl").write_text("{}\n")
    (repo / "requirements.lock.txt").write_text("pandas==3.0.7\n")
    (repo / ".env").chmod(0o644)
    names = {c.name for c in preflight.failures(preflight.run_checks(repo, min_free_gb=1e9))}
    assert {"runtime state migrated", "venv matches lockfile", ".env private", "free disk"} <= names


# ---- migration ---------------------------------------------------------------------------------------------------

def test_migrate_moves_verifies_keeps_a_backup_and_is_idempotent(repo, tmp_path):
    state = tmp_path / "state"
    fwd = repo / "research/forward"
    (fwd / "routine/2026-09-28").mkdir(parents=True)
    (fwd / "forward_trades.jsonl").write_text('{"session": "2026-09-28", "session_marker": true}\n')
    (fwd / "routine/2026-09-28/0800_tier1.json").write_text("{}")
    (repo / "watchlist").mkdir()
    (repo / "watchlist/2026-09-28.json").write_text(json.dumps({"date": "2026-09-28", "forward": True}))
    (repo / "watchlist/2026-01-05.json").write_text(json.dumps({"date": "2026-01-05"}))   # research, uncommitted
    r = migrate.migrate(repo, state, now=dt.datetime(2026, 9, 29, tzinfo=UTC))
    assert sorted(r.moved) == ["research/forward/forward_trades.jsonl",
                               "research/forward/routine/2026-09-28/0800_tier1.json", "watchlist/2026-09-28.json"]
    assert (state / "forward/forward_trades.jsonl").read_text().startswith('{"session"')
    assert (state / "routine/2026-09-28/0800_tier1.json").exists() and (state / "watchlist/2026-09-28.json").exists()
    assert not (fwd / "forward_trades.jsonl").exists() and not (fwd / "routine").exists()
    assert (repo / "watchlist/2026-01-05.json").exists()                                    # left alone
    assert (state / "migrated/20260929T000000Z/research/forward/forward_trades.jsonl").exists()
    again = migrate.migrate(repo, state)
    assert again.moved == [] and again.conflicts == []


def test_migrate_leaves_conflicts_alone(repo, tmp_path):
    state = tmp_path / "state"
    (repo / "research/forward").mkdir(parents=True)
    (repo / "research/forward/forward_trades.jsonl").write_text("old\n")
    (state / "forward").mkdir(parents=True)
    (state / "forward/forward_trades.jsonl").write_text("new\n")
    r = migrate.migrate(repo, state)
    assert r.conflicts == ["research/forward/forward_trades.jsonl"]
    assert (repo / "research/forward/forward_trades.jsonl").read_text() == "old\n"


# ---- job runner --------------------------------------------------------------------------------------------------

@pytest.fixture
def jobroot(tmp_path, monkeypatch, sent):
    root = tmp_path / "root"
    (root / ".venv/bin").mkdir(parents=True)
    (root / ".venv/bin/python").symlink_to(sys.executable)
    monkeypatch.setattr(jobs, "load_sessions", lambda now: ({}, True))
    monkeypatch.setattr(jobs, "_sha", lambda root: "abc1234")
    monkeypatch.setattr(jobs, "launchd_loaded", lambda label: True)
    monkeypatch.setattr("wt.ops.locks.LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr("wt.ops.heartbeat.HEARTBEAT_DIR", tmp_path / "hb")
    monkeypatch.setattr(jobs.preflight, "run_checks", lambda root: [preflight.Check("ok", True)])
    return root, alerts.Alerts(root=tmp_path / "alerts", topic="t"), sent[0], tmp_path


def _job(code: str, name="routine", deadline=None) -> Job:
    return Job(name, f"com.wt.{name}", 0, 0, ("-c", code), "backtest", name, deadline_min=deadline)


def test_failed_job_alerts_and_records_the_heartbeat(jobroot):
    root, a, box, tmp = jobroot
    assert jobs.run_job(_job("import sys; sys.exit(3)"), root, alerts=a) == 3
    assert box[-1]["title"] == "routine failed" and box[-1]["priority"] == 4
    assert last_runs(tmp / "hb")["routine"]["status"] == "failed"
    assert jobs.run_job(_job("pass"), root, alerts=a) == 0                        # recovery notice
    assert box[-1]["title"] == "routine recovered"


def test_refusal_exits_zero_and_alerts_once(jobroot, monkeypatch):
    root, a, box, tmp = jobroot
    monkeypatch.setattr(jobs.preflight, "run_checks", lambda root: [preflight.Check("free disk", False, "1.0 GB")])
    assert jobs.run_job(_job("raise SystemExit(9)"), root, alerts=a) == 0
    assert jobs.run_job(_job("raise SystemExit(9)"), root, alerts=a) == 0
    assert [m["title"] for m in box] == ["routine refused to run"]
    assert last_runs(tmp / "hb")["routine"]["status"] == "refused"


def test_paper_b_starts_exits_only_when_it_holds_a_position(jobroot, monkeypatch):
    root, a, box, tmp = jobroot
    monkeypatch.setattr(jobs.preflight, "run_checks", lambda root: [preflight.Check("free disk", False, "1.0 GB")])
    monkeypatch.setattr(jobs, "b_exposure", lambda: True)
    monkeypatch.setattr(jobs, "JOURNAL", tmp / "journal.jsonl")
    child = "import os, sys; sys.exit(0 if os.environ.get('WT_EXITS_ONLY') == '1' else 5)"
    assert jobs.run_job(_job(child, name="paper-b"), root, alerts=a) == 0
    assert box[0]["title"] == "paper-b: entries off, exits only" and box[0]["priority"] == 4
    assert last_runs(tmp / "hb")["paper-b"]["status"] == "ok"


@pytest.mark.parametrize("check,exposure", [("on main", True), ("venv matches lockfile", True), ("free disk", False)])
def test_paper_b_is_refused_when_exits_only_is_not_safe(jobroot, monkeypatch, check, exposure):
    root, a, box, tmp = jobroot
    monkeypatch.setattr(jobs.preflight, "run_checks", lambda root: [preflight.Check(check, False, "x")])
    monkeypatch.setattr(jobs, "b_exposure", lambda: exposure)
    assert jobs.run_job(_job("raise SystemExit(9)", name="paper-b"), root, alerts=a) == 0
    assert [m["title"] for m in box] == ["paper-b refused to run"]
    assert last_runs(tmp / "hb")["paper-b"]["status"] == "refused"


def test_a_second_concurrent_run_is_refused(jobroot):
    root, a, box, tmp = jobroot
    with job_lock("routine", tmp / "locks"):
        assert jobs.run_job(_job("pass"), root, alerts=a) == 0
    assert box[-1]["title"] == "routine refused to run"


def test_deadline_kills_a_hung_job(jobroot, monkeypatch):
    root, a, box, tmp = jobroot
    monkeypatch.setattr(jobs, "deadline_for",
                        lambda job, start, sessions: dt.datetime.now(UTC) + dt.timedelta(seconds=1))
    monkeypatch.setattr(jobs, "KILL_GRACE_S", 2)
    assert jobs.run_job(_job("import time; time.sleep(60)", name="forward"), root, alerts=a) == 124
    assert "stopped at its deadline" in box[-1]["message"]
    assert last_runs(tmp / "hb")["forward"]["status"] == "timeout"


def test_paper_outcome_raises_trading_critical_alerts(tmp_path, sent):
    box, _ = sent
    a = alerts.Alerts(root=tmp_path, topic="t")
    rows = [{"event": "loop_error"}] * 3 + [
        {"event": "reconcile", "actions": ["UNKNOWN unprotected position QQQM x3 -> flatten required"]},
        {"event": "END_OF_DAY_NOT_FLAT"},
        {"event": "session_end", "virtual": {"latched": True, "latch_reason": "day -2%"}}]
    o = jobs.paper_outcome(rows)
    assert o["not_flat"] and o["unknown_positions"] == 1 and o["latched"] and o["loop_errors"] == 3
    jobs.alert_paper(o, a)
    assert {m["priority"] for m in box} == {5, 4} and len(box) == 4


def test_forward_summary_reports_r_only(tmp_path):
    led = tmp_path / "l.jsonl"
    led.write_text("\n".join(json.dumps(r) for r in [
        {"session": "2026-09-29", "strategy": "r3:MP-1", "symbol": "ABCD", "R": 1.5},
        {"session": "2026-09-29", "strategy": "B_qqq_qqqm", "R": -1.0},
        {"session": "2026-09-29", "strategy": "r3:MP-1", "strategy_marker": True, "n_trades": 1},
        {"session": "2026-09-29", "session_marker": True, "n_trades": 2}]))
    line = jobs.forward_summary(led)
    assert line.startswith("Forward 2026-09-29: 2 trade(s), +0.50R total") and "$" not in line


# ---- launchd agents ---------------------------------------------------------------------------------------------

def test_agents_render_from_the_schedule(tmp_path):
    p = plistlib.loads(agents.render(JOBS["weekly"], Path("/x/trading")))
    assert p["ProgramArguments"] == ["/x/trading/deploy/run_job.sh", "weekly"]
    assert p["StartCalendarInterval"] == {"Hour": 11, "Minute": 0, "Weekday": 6}
    assert "/opt/homebrew/bin" in p["EnvironmentVariables"]["PATH"] and p["RunAtLoad"] is False
    (tmp_path / "com.wt.weekly.plist").write_bytes(agents.render(JOBS["weekly"], Path("/x/trading")))
    d = agents.diff(Path("/x/trading"), tmp_path)
    assert "com.wt.weekly: differs from the code" not in d and "com.wt.routine: not installed" in d


def test_a_child_that_cannot_start_is_a_recorded_failure(jobroot):
    root, a, box, tmp = jobroot
    (root / ".venv/bin/python").unlink()
    assert jobs.run_job(_job("pass"), root, alerts=a) == 127
    assert last_runs(tmp / "hb")["routine"]["status"] == "failed" and box[-1]["title"] == "routine failed"


def test_dashboard_agent_runs_on_an_interval_and_is_not_a_trading_job():
    p = plistlib.loads(agents.render(JOBS["dashboard"], Path("/x/trading")))
    assert p["StartInterval"] == 900 and "StartCalendarInterval" not in p
    assert JOBS["dashboard"].trading is False and JOBS["dashboard"].fires(syd(2026, 9, 30, 9, 0)) == []
    assert window.upcoming_starts(syd(2026, 9, 30, 9, 0)) == []


def test_collector_may_write_only_var_dashboard_inside_the_live_checkout(tmp_path):
    from wt.ops.safeio import guard_out_dir
    live = tmp_path / "trading"
    assert guard_out_dir(live / "var/dashboard", [live], allowed=[live / "var/dashboard"]) == (live / "var/dashboard").resolve()
    with pytest.raises(PermissionError):
        guard_out_dir(live / "var/other", [live], allowed=[live / "var/dashboard"])


def test_rollback_cleanup_ignores_positions_outside_bs_mandate_and_restores_mode(monkeypatch):
    from wt.brokers.sim import SimBroker
    from wt.core.types import Order, Position
    from wt.ops import deploy
    monkeypatch.delenv("MODE", raising=False)
    b = SimBroker()
    b.pos["AAPL"] = Position("AAPL", 1, 200.0)                 # a manual test buy: not B's
    b.place(Order("wt-B-20260929-aaaaaaaaaaaa", "QQQM", "sell", 2, "stop", stop_price=240.0, tif="gtc"))
    assert deploy.broker_cleanup_before_rollback(lambda: b) is None
    assert b.open_orders() == []                                # our GTC stop is gone
    assert "MODE" not in __import__("os").environ               # nothing leaks into the smoke test or venv sync
    b.pos["QQQM"] = Position("QQQM", 2, 250.0)
    assert "strategy B holds a position" in deploy.broker_cleanup_before_rollback(lambda: b)


def test_alert_transitions_are_logged_for_the_dashboard(tmp_path, monkeypatch):
    from wt.ops import alerts as al
    monkeypatch.setattr(al, "_send", lambda msg, topic, server, timeout=5.0: True)
    a = al.Alerts(root=tmp_path, topic="t")
    tmp_path.mkdir(exist_ok=True)
    assert a.fire("job:paper-b", "paper-b late", "m")
    assert not a.fire("job:paper-b", "paper-b late", "m")            # repeats are not transitions
    assert a.resolve("job:paper-b", "paper-b recovered", "m")
    rows = [json.loads(x) for x in (tmp_path / "history.jsonl").read_text().splitlines()]
    assert [(r["key"], r["event"], r["priority"]) for r in rows] == [("job:paper-b", "fired", 4),
                                                                     ("job:paper-b", "resolved", 2)]


def test_alert_history_failures_never_raise(tmp_path, monkeypatch):
    from wt.ops import alerts as al
    monkeypatch.setattr(al, "_send", lambda msg, topic, server, timeout=5.0: True)
    (tmp_path / "history.jsonl").mkdir(parents=True)                  # appending to a directory fails
    assert al.Alerts(root=tmp_path, topic="t").fire("k", "t", "m")


def test_alert_history_is_cut_to_its_newer_half(tmp_path, monkeypatch):
    from wt.ops import alerts as al
    monkeypatch.setattr(al, "HISTORY_MAX_BYTES", 2000)
    for i in range(40):
        al._history(tmp_path, f"k{i}", "fired", "t")
    lines = (tmp_path / "history.jsonl").read_text().splitlines()
    assert len(lines) < 40 and json.loads(lines[-1])["key"] == "k39"
