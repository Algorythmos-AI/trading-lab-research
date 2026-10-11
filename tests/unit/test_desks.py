"""Desks (ADR 0005): the stocks desk keeps its paths; nothing crosses desks in the backup, the snapshot or a deploy.

The crypto desk, the second one, left for its own repository; the tests of what it left behind are here too."""
from __future__ import annotations

import dataclasses
import datetime as dt
import threading
import time
from pathlib import Path

from test_backup import chained, paths  # noqa: F401 — the fixture
from test_deploy_transaction import commit, git, head, world  # noqa: F401 — the fixture

from wt.core import desk as desks
from wt.core.config import DATA_DIR, FORWARD_LEDGER, ROOT, STATE_DIR
from wt.ops import backup, deploy, jobs, locks, publish, units
from wt.ops.schedule import JOBS, Job


def test_the_stocks_desk_is_exactly_where_the_lab_always_was():
    s = desks.DESKS["stocks"]
    assert s.kill_file == ROOT / "KILL" and s.strategy == "B" and s.session == "us_equity"
    assert s.ledgers == (("forward", FORWARD_LEDGER), ("paper", DATA_DIR / "live" / "journal.jsonl"))
    assert s.chain_flag == STATE_DIR / "evidence" / "chain-broken" == backup.CHAIN_FLAG
    assert s.journal == backup.JOURNAL and s.snapshot_schema == publish.SCHEMA_ID


def test_no_two_ledgers_share_a_file_name_or_an_anchor_name():
    """The restore test finds ledgers by file name, and the anchor is keyed by ledger name."""
    every = [(n, p) for d in desks.DESKS.values() for n, p in d.ledgers]
    assert len({p.name for _, p in every}) == len(every) == len({n for n, _ in every})


def test_an_alert_belongs_to_one_desk(monkeypatch):
    for key in ("job:routine", "paper-b:out-of-mandate:AAPL", "evidence:chain", "summary:2026-10-02", "deploy"):
        assert desks.desk_of_alert(key) == "stocks", key
    assert sum(d.alert_prefix is None for d in desks.DESKS.values()) == 1      # exactly one catch-all
    monkeypatch.setitem(desks.DESKS, "fx", dataclasses.replace(desks.DESKS["stocks"], name="fx", alert_prefix="fx:"))
    assert desks.desk_of_alert("fx:data-stale") == "fx" and desks.desk_of_alert("job:routine") == "stocks"


def test_only_the_stocks_desk_runs_from_this_repository():
    """The crypto desk left for its own repository (research/MOVED.md). Its record, its four jobs, their units and
    their dead-man checks went with it; what it left on the host is named in RETIRED."""
    assert set(desks.DESKS) == {"stocks"}
    assert {j.desk for j in JOBS.values()} == {"stocks"}
    left = {"crypto", "dashboard-crypto", "crypto-challengers", "crypto-learn"}
    assert not left & set(JOBS) and not left & set(units.MEMORY) and not left & jobs.HC_JOBS
    assert [(r.name, r.alert_prefix, set(r.jobs)) for r in desks.RETIRED] == [("crypto", "crypto:", left)]
    assert not {n for d in desks.DESKS.values() for n, _ in d.ledgers} & {"crypto", "crypto-harvest"}


def test_what_a_retired_desk_left_behind_belongs_to_no_desk():
    """Its own keys carry its prefix. Its jobs' keys never did (`job:crypto`), and neither did the deploy's notice
    about the machine-learning environment: all of them were raised here and can never be resolved here."""
    for key in ("crypto:data-stale", "crypto:latch:trend", "crypto:evidence-chain", "job:crypto", "job:crypto-learn",
                "job:dashboard-crypto", "refuse:crypto-challengers:2026-10-10", "refuse:crypto:2026-10-10", "deploy-ml"):
        assert desks.retired_alert(key) and desks.desk_of_alert(key) is None, key
    for key in ("job:routine", "job:dashboard", "refuse:paper-b:2026-10-10", "deploy", "evidence:chain", "summary:2026-10-10",
                "cryptic", "job:crypto-other", "paper-b:out-of-mandate:AAPL"):
        assert not desks.retired_alert(key) and desks.desk_of_alert(key) == "stocks", key
    assert all(desks.retired_job(n) for r in desks.RETIRED for n in r.jobs)
    assert not any(desks.retired_job(n) for n in JOBS)


def test_the_stocks_jobs_are_untouched():
    assert set(JOBS) == {"routine", "paper-b", "forward", "weekly", "dashboard", "options-live"}
    assert all(j.calendar is None for j in JOBS.values())
    assert jobs.HC_JOBS == {"routine", "paper-b", "forward", "weekly"}


def test_the_backup_still_runs_every_day():
    timer = (ROOT / "deploy/oci/systemd/wt-backup.timer").read_text()
    assert "OnCalendar=*-*-* 19:30 America/New_York" in timer and "Mon..Fri" not in timer


def test_a_calendar_job_fires_on_the_utc_boundary_and_has_no_start_limit():
    j = Job("fx", "com.wt.fx", 0, 0, ("-m", "wt.fx.cycle"), "paper", "fx", trading=False,
            interval_s=900, calendar="*:0/15:10", desk="fx", runtime_max_h=0.2)
    t = units.timer(j).splitlines()
    assert "OnCalendar=*:0/15:10 UTC" in t and not any(x.startswith(("OnUnitActiveSec", "OnBootSec")) for x in t)
    svc = units.service(j, Path("/r")).splitlines()
    assert "StartLimitIntervalSec=0" in svc and "Restart=no" in svc


# ---------------------------------------------------------------- backup

def test_a_desk_that_is_not_installed_is_not_backed_up_or_anchored(paths):  # noqa: F811
    fwd, jr, tmp, _, _ = paths
    chained(fwd, 2)
    chained(jr, 2)
    assert list(backup.chains()) == ["forward", "paper"]


def second_desk(tmp: Path, monkeypatch) -> desks.Desk:
    """A desk beside the stocks desk. None runs from this repository today; the shared layers still keep desks
    apart (ADR 0005), and these tests hold them to it for the next one."""
    d = desks.Desk("fx", "F", tmp / "fx", tmp / "fx" / "KILL", (("fx", tmp / "fx" / "fx_journal.jsonl"),),
                   tmp / "fx" / "chain-broken", "always_open", "fx:", "trading-lab/fx-snapshot")
    monkeypatch.setitem(desks.DESKS, "fx", d)
    d.state_dir.mkdir()
    return d


def test_a_desk_is_installed_once_its_state_directory_exists(paths, monkeypatch):  # noqa: F811
    fwd, jr, tmp, _, _ = paths
    d = second_desk(tmp, monkeypatch)
    chained(fwd, 2)
    chained(jr, 2)
    chained(d.journal, 3)
    assert desks.installed(d) and list(backup.chains()) == ["forward", "paper", "fx"]
    d.journal.unlink()
    d.state_dir.rmdir()
    assert not desks.installed(d) and list(backup.chains()) == ["forward", "paper"]
    assert desks.installed(desks.DESKS["stocks"])


def test_a_broken_chain_on_another_desk_switches_off_that_desks_entries_only(paths, monkeypatch):  # noqa: F811
    fwd, jr, tmp, box, a = paths
    c = second_desk(tmp, monkeypatch)
    chained(fwd, 2)
    chained(jr, 2)
    chained(c.journal, 3)
    c.journal.write_bytes(c.journal.read_bytes().replace(b'"i": 1', b'"i": 9'))        # rewrite history
    assert list(backup.chains()) == ["forward", "paper", "fx"]
    monkeypatch.setattr(backup, "restic", lambda *a, **k: type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})())
    monkeypatch.setattr(backup.hc, "ping", lambda *a, **k: True)
    backup.nightly(a, weekly=False, client=type("C", (), {"configured": False})(), today=dt.date(2026, 10, 20))
    assert c.chain_flag.exists() and not backup.CHAIN_FLAG.exists()
    assert "fx:evidence-chain" in a.firing() and "evidence:chain" not in a.firing()


def test_the_restore_test_asks_for_every_installed_ledger_and_notices_a_missing_one(paths, monkeypatch, capsys):  # noqa: F811
    fwd, jr, tmp, _, _ = paths
    c = second_desk(tmp, monkeypatch)
    for p in (fwd, jr, c.journal):
        chained(p, 2)
    seen = []

    def fake(*args, timeout=3600):
        seen.append(args)
        target = Path(args[args.index("--target") + 1])
        chained(target / fwd.name, 2)
        chained(target / jr.name, 2)                         # the other desk's journal does not come back
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
    monkeypatch.setattr(backup, "restic", fake)
    assert backup.restore_test() == 1
    assert [seen[0][i + 1] for i, x in enumerate(seen[0]) if x == "--include"] == [fwd.name, jr.name, c.journal.name]
    assert "MISSING ['fx_journal.jsonl']" in capsys.readouterr().out


def test_each_desk_anchors_its_own_ledgers_and_a_growing_journal_is_not_a_rewrite(paths, monkeypatch):  # noqa: F811
    """2026-10-04: a backup had anchored the day before a second desk existed. With one shared anchor the next
    backup of that day would have paged "DIFFERENT heads", and so would any second backup of a day on which that
    desk's journal grew."""
    from test_backup import Anchors
    fwd, jr, tmp, _, _ = paths
    chained(fwd, 2)
    chained(jr, 2)
    s, day = Anchors(), dt.date(2026, 10, 4)
    assert backup.anchor_desks(day, backup.chains(), s) == (True, "anchored anchors/2026-10-04.json")
    stocks_anchor = s.objs["anchors/2026-10-04.json"]

    c = second_desk(tmp, monkeypatch)                                # the desk is installed later the same day
    chained(c.journal, 3)
    ok, why = backup.anchor_desks(day, backup.chains(), s)
    assert ok and why == "anchors/2026-10-04.json already anchored; anchored anchors/fx/2026-10-04.json"
    assert s.objs["anchors/2026-10-04.json"] == stocks_anchor       # untouched, and still only the stocks ledgers

    chained(c.journal, 5)                                            # the same three lines, then two more
    ok, why = backup.anchor_desks(day, backup.chains(), s)
    assert ok and why.endswith("anchors/fx/2026-10-04.json already anchored; the ledger has only grown since")

    c.journal.write_bytes(c.journal.read_bytes().replace(b'"i": 1', b'"i": 9'))      # history rewritten
    ok, why = backup.anchor_desks(day, backup.chains(), s)
    assert not ok and why.endswith("anchors/fx/2026-10-04.json already anchored with DIFFERENT heads")



def test_a_stocks_ledger_that_grew_after_the_days_first_backup_is_not_a_rewrite_either(paths):  # noqa: F811
    """A backup run before the session (by hand, or caught up after a reboot) anchors the morning's heads. The
    evening run then finds longer ledgers: an append, not an alarm. A changed earlier line still is one."""
    from test_backup import Anchors
    fwd, jr, tmp, _, _ = paths
    chained(fwd, 2)
    chained(jr, 2)
    s, day = Anchors(), dt.date(2026, 10, 5)
    assert backup.anchor_desks(day, backup.chains(), s)[0]
    chained(fwd, 4)                                                  # the forward test appended two lines
    chained(jr, 3)
    assert backup.anchor_desks(day, backup.chains(), s) == (
        True, "anchors/2026-10-05.json already anchored; the ledger has only grown since")

    fwd.write_bytes(fwd.read_bytes().replace(b'"i": 0', b'"i": 7'))  # line 1 rewritten; the anchored line 2 is untouched
    ok, why = backup.anchor_desks(day, backup.chains(), s)
    assert not ok and why == "anchors/2026-10-05.json already anchored with DIFFERENT heads"

    chained(fwd, 1)                                                  # shorter than what was anchored
    assert not backup.anchor_desks(day, backup.chains(), s)[0]
    # called without the files (as older callers do), only identical heads pass
    chained(fwd, 4)
    assert backup.anchor(day, backup.chains(), s) == (False, "anchors/2026-10-05.json already anchored with DIFFERENT heads")


def test_head_at_is_the_head_the_file_had_at_that_length(tmp_path):
    from wt.core import ledger
    p = tmp_path / "l.jsonl"
    chained(p, 3)
    assert ledger.head_at(p, 3) == ledger.head(p)[1]
    first_three = p.read_bytes()
    chained(p, 5)
    assert p.read_bytes().startswith(first_three) and ledger.head_at(p, 3) != ledger.head(p)[1]
    assert ledger.head_at(p, 6) is None and ledger.head_at(p, 0) is None and ledger.head_at(tmp_path / "no", 1) is None


# ---------------------------------------------------------------- the stocks snapshot

def test_the_stocks_snapshot_shows_no_other_desks_alerts_or_jobs(tmp_path, monkeypatch):
    from wt.ops import alerts, heartbeat
    monkeypatch.setattr(alerts, "ALERT_DIR", tmp_path / "alerts")
    monkeypatch.setattr(heartbeat, "HEARTBEAT_DIR", tmp_path / "hb")
    monkeypatch.setattr(alerts, "_send", lambda *a, **k: True)
    monkeypatch.setitem(desks.DESKS, "fx", dataclasses.replace(desks.DESKS["stocks"], name="fx", alert_prefix="fx:"))
    monkeypatch.setitem(JOBS, "fx", Job("fx", "x", 0, 0, (), "paper", "fx", trading=False, interval_s=900, desk="fx"))
    a = alerts.Alerts(topic="")
    a.fire("fx:data-stale", "stale", "x")
    a.fire("job:routine", "routine failed", "x")
    for name in ("fx", "routine"):
        heartbeat.Heartbeat(name, "abc").finish("ok", 0)
    monkeypatch.setattr(publish, "v3_views", lambda *a, **k: {})
    monkeypatch.setattr("wt.ops.window.load_sessions", lambda *a, **k: ({}, True))
    monkeypatch.setattr("wt.ops.preflight.run_checks", lambda root: [])
    out = publish.extras(dt.datetime(2026, 10, 5, 12, tzinfo=dt.UTC), tmp_path)
    assert [x["key"] for x in out["alerts"]["firing"]] == ["job:routine"]
    assert set(out["jobs"]["last"]) == {"routine"} and {r["job"] for r in out["jobs"]["runs"]} == {"routine"}


def test_what_the_crypto_desk_left_on_the_host_never_reads_as_the_stocks_desks(tmp_path, monkeypatch, capsys):
    """The state the host has on the day the desk's code is removed: its alerts still recorded as firing, its jobs'
    last heartbeats and run history still on disk. With its record gone every one of them would be the stocks
    desk's, which owns whatever no other desk claims: shown as firing for good, and listed among its jobs."""
    from wt.ops import alerts, heartbeat
    monkeypatch.setattr(alerts, "ALERT_DIR", tmp_path / "alerts")
    monkeypatch.setattr(heartbeat, "HEARTBEAT_DIR", tmp_path / "hb")
    monkeypatch.setattr(alerts, "_send", lambda *a, **k: True)
    a = alerts.Alerts(topic="")
    for key in ("crypto:data-stale", "crypto:latch:trend", "job:crypto-learn", "deploy-ml", "job:routine"):
        a.fire(key, key, "x")
    for name in ("crypto", "dashboard-crypto", "crypto-challengers", "crypto-learn", "routine"):
        heartbeat.Heartbeat(name, "abc").finish("ok", 0)
    monkeypatch.setattr(publish, "v3_views", lambda *a, **k: {})
    monkeypatch.setattr("wt.ops.window.load_sessions", lambda *a, **k: ({}, True))
    monkeypatch.setattr("wt.ops.preflight.run_checks", lambda root: [])
    out = publish.extras(dt.datetime(2026, 10, 5, 12, tzinfo=dt.UTC), tmp_path)
    assert [x["key"] for x in out["alerts"]["firing"]] == ["job:routine"]          # before anything was cleared
    assert set(out["jobs"]["last"]) == {"routine"} and {r["job"] for r in out["jobs"]["runs"]} == {"routine"}
    monkeypatch.setattr(jobs, "cadence", lambda: [])
    jobs.status(tmp_path)
    shown = capsys.readouterr().out
    assert "Alerts firing: job:routine\n" in shown and "crypto" not in shown


def test_the_first_job_after_the_removal_forgets_the_retired_desks_alerts_once(tmp_path, monkeypatch):
    """Dropped, not resolved: no "recovered" notice goes out for a desk that is running elsewhere, and no history
    row is written. One log line names what went; the next job finds nothing and says nothing."""
    from wt.ops import alerts
    sent = []
    monkeypatch.setattr(alerts, "_send", lambda msg, *a, **k: sent.append(msg["title"]) or True)
    a = alerts.Alerts(tmp_path / "alerts", topic="t")
    for key in ("crypto:data-stale", "crypto:exit-gap:trend:BTC/USD", "job:dashboard-crypto", "deploy-ml", "job:routine"):
        a.fire(key, key, "x")
    a.resolve("crypto:data-stale", "back", "x")                    # a resolved key of the desk goes too
    a.once_per_day("refuse:crypto", "refused", "x", day="2026-10-10")
    before, history = len(sent), (tmp_path / "alerts" / "history.jsonl").read_text()
    lines: list[str] = []
    gone = jobs.forget_retired(a, lines.append)
    assert gone == ["crypto:data-stale", "crypto:exit-gap:trend:BTC/USD", "deploy-ml", "job:dashboard-crypto",
                    "refuse:crypto:2026-10-10"]
    assert len(lines) == 1 and "5 alert key(s)" in lines[0] and "crypto:data-stale" in lines[0]
    assert list(a.firing()) == ["job:routine"]
    assert len(sent) == before and (tmp_path / "alerts" / "history.jsonl").read_text() == history
    state = tmp_path / "alerts" / "state.json"
    stamp = state.stat().st_mtime_ns
    assert jobs.forget_retired(a, lines.append) == [] and len(lines) == 1 and state.stat().st_mtime_ns == stamp
    assert jobs.forget_retired(object(), lines.append) == [] and len(lines) == 1      # never raises


def test_every_job_run_clears_them_before_it_starts(tmp_path, monkeypatch):
    from wt.ops import alerts
    monkeypatch.setattr(alerts, "_send", lambda *a, **k: True)
    monkeypatch.setattr(locks, "LOCK_DIR", tmp_path / "locks")
    a = alerts.Alerts(tmp_path / "alerts", topic="")
    a.fire("crypto:latch", "latched", "x")
    lines: list[str] = []
    monkeypatch.setattr(jobs, "Log", lambda root, job: lines.append)

    class Stop(Exception):
        pass

    def heartbeat(name, sha):
        raise Stop
    monkeypatch.setattr(jobs, "Heartbeat", heartbeat)
    try:
        jobs.run_job(JOBS["dashboard"], tmp_path, alerts=a)
    except Stop:
        pass
    assert a.firing() == {} and sum("forgot 1 alert key(s)" in x for x in lines) == 1


# ---------------------------------------------------------------- deploys

def test_a_deploy_waits_for_an_interval_job_in_flight_and_holds_its_lock(world, monkeypatch):  # noqa: F811
    dev, live, first, state = world
    new = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    release = threading.Event()

    def publisher():
        with locks.job_lock("dashboard"):
            release.wait(5)
    t = threading.Thread(target=publisher)
    t.start()
    time.sleep(0.2)
    monkeypatch.setattr(deploy, "QUIESCE_WAIT_S", 0.3)
    assert deploy.deploy(new) == 2 and head(live) == first            # still running: nothing changed
    release.set()
    t.join()
    seen = {}
    monkeypatch.setattr(deploy, "smoke", lambda: (seen.setdefault("held", locks.is_held("dashboard")), "ok"))
    assert deploy.deploy(new) == 0 and head(live) == new and seen["held"]       # held across the switch


def test_a_job_that_starts_during_a_deploy_waits_instead_of_refusing(monkeypatch, tmp_path):
    monkeypatch.setattr(locks, "LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr(jobs, "DEPLOY_WAIT_S", 5.0)
    monkeypatch.setattr(jobs, "Log", lambda root, job: (lambda msg: None))
    refused, started = [], []
    monkeypatch.setattr(jobs, "refuse", lambda job, reason, *a, **k: refused.append(reason) or 0)

    class Stop(Exception):
        pass

    def heartbeat(name, sha):
        started.append(time.monotonic())
        raise Stop
    monkeypatch.setattr(jobs, "Heartbeat", heartbeat)
    done = threading.Event()

    def a_deploy():
        with locks.job_lock(locks.DEPLOY_LOCK), deploy.quiesced(1.0):
            done.set()
            time.sleep(0.6)
    t = threading.Thread(target=a_deploy)
    t.start()
    done.wait(2)
    t0 = time.monotonic()
    try:
        jobs.run_job(jobs.JOBS["dashboard"], tmp_path, alerts=object())
    except Stop:
        pass
    t.join()
    assert not refused and started and started[0] - t0 >= 0.3      # it waited for the deploy, then ran
