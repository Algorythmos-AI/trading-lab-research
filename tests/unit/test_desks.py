"""Desks (ADR 0005): the stocks desk keeps its paths; nothing crosses desks in the backup, the snapshot or a deploy."""
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


def test_an_alert_belongs_to_one_desk():
    assert desks.desk_of_alert("crypto:data-stale") == "crypto"
    for key in ("job:routine", "paper-b:out-of-mandate:AAPL", "evidence:chain", "summary:2026-10-02", "deploy"):
        assert desks.desk_of_alert(key) == "stocks", key
    assert sum(d.alert_prefix is None for d in desks.DESKS.values()) == 1      # exactly one catch-all


def test_the_stocks_jobs_are_untouched_and_the_crypto_desk_has_exactly_two_interval_jobs():
    stocks = {n: j for n, j in JOBS.items() if j.desk == "stocks"}
    assert set(stocks) == {"routine", "paper-b", "forward", "weekly", "dashboard", "options-live"}
    assert all(j.calendar is None for j in stocks.values())
    crypto = {n: j for n, j in JOBS.items() if j.desk == "crypto"}
    assert set(crypto) == {"crypto", "dashboard-crypto", "crypto-challengers", "crypto-learn"}
    for name in ("crypto-challengers", "crypto-learn"):      # once a day, on a clock time (DEC-0016)
        daily = crypto.pop(name)
        assert not daily.trading and daily.interval_s is None and daily.et
    for j in crypto.values():
        # never a trading job (a 24/7 one would close the equity deploy gate for good); always on a UTC boundary
        assert not j.trading and j.interval_s == 900 and j.calendar and j.deadline_min and j.et is None, j.name
        assert j.runtime_max_h * 60 > j.deadline_min + 1
    assert "OnCalendar=*:0/15:10 UTC" in units.timer(JOBS["crypto"])              # ten seconds after the bar closes
    assert "OnCalendar=*:1/15:00 UTC" in units.timer(JOBS["dashboard-crypto"])    # the publish follows the cycle
    assert "crypto" in jobs.HC_JOBS and jobs.hc_slug(JOBS["crypto"]) == "wt-crypto"
    # Every job the crypto desk runs on a timer has a dead-man check, except the publisher (the dashboard's own
    # watchdog pages on a stale snapshot). A job that only alerts on failure says nothing when it never starts.
    daily = {"crypto-challengers", "crypto-learn"}
    assert daily <= set(JOBS) and daily <= jobs.HC_JOBS
    book = (ROOT / "docs/runbooks/dead-man-switches.md").read_text()
    assert all(f"`{jobs.hc_slug(JOBS[n])}`" in book for n in ("crypto", *sorted(daily)))
    assert "MemoryMax=512M" in units.service(JOBS["crypto"], Path("/r"))


def test_the_backup_runs_every_day_now_that_evidence_is_written_at_weekends():
    timer = (ROOT / "deploy/oci/systemd/wt-backup.timer").read_text()
    assert "OnCalendar=*-*-* 19:30 America/New_York" in timer and "Mon..Fri" not in timer


def test_a_calendar_job_fires_on_the_utc_boundary_and_has_no_start_limit():
    j = Job("crypto", "com.wt.crypto", 0, 0, ("-m", "wt.crypto.cycle"), "paper", "crypto", trading=False,
            interval_s=900, calendar="*:0/15:10", desk="crypto", runtime_max_h=0.2)
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


def crypto_desk(tmp: Path, monkeypatch) -> desks.Desk:
    d = dataclasses.replace(desks.DESKS["crypto"], state_dir=tmp / "crypto",
                            ledgers=(("crypto", tmp / "crypto" / "crypto_journal.jsonl"),),
                            chain_flag=tmp / "crypto" / "chain-broken")
    monkeypatch.setitem(desks.DESKS, "crypto", d)
    d.state_dir.mkdir()
    return d


def test_a_desk_that_has_moved_is_not_installed_whatever_is_left_of_its_directory(paths, monkeypatch):  # noqa: F811
    """The crypto desk leaves for its own repository: from the moment the marker exists, nothing here anchors,
    restores or expects it, even if a stray command recreates its directory."""
    fwd, jr, tmp, _, _ = paths
    c = crypto_desk(tmp, monkeypatch)
    chained(fwd, 2)
    chained(jr, 2)
    chained(c.journal, 3)
    assert desks.installed(c) and not desks.moved(c)
    assert list(backup.chains()) == ["forward", "paper", "crypto"]
    assert desks.moved_marker(c) == tmp / "crypto.MOVED"            # beside the state directory, which is moved away
    desks.moved_marker(c).write_text("moved to its own repository\n")
    assert desks.moved(c) and not desks.installed(c)
    assert list(backup.chains()) == ["forward", "paper"]
    assert not any("crypto" in line for line in jobs.cadence(heartbeats=tmp / "none"))


def test_the_marker_is_where_the_cutover_runbook_puts_it_and_the_stocks_desk_cannot_move(tmp_path):
    assert desks.moved_marker(desks.DESKS["crypto"]) == STATE_DIR / "crypto.MOVED"
    stocks = dataclasses.replace(desks.DESKS["stocks"], state_dir=tmp_path / "var")
    desks.moved_marker(stocks).write_text("a mistake\n")
    assert not desks.moved(stocks) and desks.installed(stocks)


def test_a_broken_crypto_chain_switches_off_crypto_entries_only(paths, monkeypatch):  # noqa: F811
    fwd, jr, tmp, box, a = paths
    c = crypto_desk(tmp, monkeypatch)
    chained(fwd, 2)
    chained(jr, 2)
    chained(c.journal, 3)
    c.journal.write_bytes(c.journal.read_bytes().replace(b'"i": 1', b'"i": 9'))        # rewrite history
    assert list(backup.chains()) == ["forward", "paper", "crypto"]
    monkeypatch.setattr(backup, "restic", lambda *a, **k: type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})())
    monkeypatch.setattr(backup.hc, "ping", lambda *a, **k: True)
    backup.nightly(a, weekly=False, client=type("C", (), {"configured": False})(), today=dt.date(2026, 10, 20))
    assert c.chain_flag.exists() and not backup.CHAIN_FLAG.exists()
    assert "crypto:evidence-chain" in a.firing() and "evidence:chain" not in a.firing()


def test_the_restore_test_asks_for_every_installed_ledger_and_notices_a_missing_one(paths, monkeypatch, capsys):  # noqa: F811
    fwd, jr, tmp, _, _ = paths
    c = crypto_desk(tmp, monkeypatch)
    for p in (fwd, jr, c.journal):
        chained(p, 2)
    seen = []

    def fake(*args, timeout=3600):
        seen.append(args)
        target = Path(args[args.index("--target") + 1])
        chained(target / fwd.name, 2)
        chained(target / jr.name, 2)                         # the crypto journal does not come back
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
    monkeypatch.setattr(backup, "restic", fake)
    assert backup.restore_test() == 1
    assert [seen[0][i + 1] for i, x in enumerate(seen[0]) if x == "--include"] == [fwd.name, jr.name, c.journal.name]
    assert "MISSING ['crypto_journal.jsonl']" in capsys.readouterr().out


def test_each_desk_anchors_its_own_ledgers_and_a_growing_crypto_journal_is_not_a_rewrite(paths, monkeypatch):  # noqa: F811
    """2026-10-04: a backup had anchored the day before the crypto desk existed. With one shared anchor the next
    backup of that day would have paged "DIFFERENT heads", and so would any second backup of a day on which the
    crypto journal grew, which is every day."""
    from test_backup import Anchors
    fwd, jr, tmp, _, _ = paths
    chained(fwd, 2)
    chained(jr, 2)
    s, day = Anchors(), dt.date(2026, 10, 4)
    assert backup.anchor_desks(day, backup.chains(), s) == (True, "anchored anchors/2026-10-04.json")
    stocks_anchor = s.objs["anchors/2026-10-04.json"]

    c = crypto_desk(tmp, monkeypatch)                                # the desk is installed later the same day
    chained(c.journal, 3)
    ok, why = backup.anchor_desks(day, backup.chains(), s)
    assert ok and why == "anchors/2026-10-04.json already anchored; anchored anchors/crypto/2026-10-04.json"
    assert s.objs["anchors/2026-10-04.json"] == stocks_anchor       # untouched, and still only the stocks ledgers

    chained(c.journal, 5)                                            # the same three lines, then two more
    ok, why = backup.anchor_desks(day, backup.chains(), s)
    assert ok and why.endswith("anchors/crypto/2026-10-04.json already anchored; the ledger has only grown since")

    c.journal.write_bytes(c.journal.read_bytes().replace(b'"i": 1', b'"i": 9'))      # history rewritten
    ok, why = backup.anchor_desks(day, backup.chains(), s)
    assert not ok and why.endswith("anchors/crypto/2026-10-04.json already anchored with DIFFERENT heads")



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
    monkeypatch.setitem(JOBS, "crypto", Job("crypto", "x", 0, 0, (), "paper", "crypto", trading=False,
                                            interval_s=900, desk="crypto"))
    a = alerts.Alerts(topic="")
    a.fire("crypto:data-stale", "stale", "x")
    a.fire("job:routine", "routine failed", "x")
    for name in ("crypto", "routine"):
        heartbeat.Heartbeat(name, "abc").finish("ok", 0)
    monkeypatch.setattr(publish, "v3_views", lambda *a, **k: {})
    monkeypatch.setattr("wt.ops.window.load_sessions", lambda *a, **k: ({}, True))
    monkeypatch.setattr("wt.ops.preflight.run_checks", lambda root: [])
    out = publish.extras(dt.datetime(2026, 10, 5, 12, tzinfo=dt.UTC), tmp_path)
    assert [x["key"] for x in out["alerts"]["firing"]] == ["job:routine"]
    assert set(out["jobs"]["last"]) == {"routine"} and {r["job"] for r in out["jobs"]["runs"]} == {"routine"}


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
