"""The Linux VM host (ADR 0004): host detection, systemd units, ET timers across DST, SIGTERM forwarding,
healthchecks pings and the fail-closed secrets file. The Mac's launchd behaviour must not change."""
from __future__ import annotations

import datetime as dt
import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from wt.ops import alerts, hc, host, jobs, preflight, publish, units, window
from wt.ops.heartbeat import last_runs
from wt.ops.schedule import JOBS, NEW_YORK, Job, et_days

# ---- host ------------------------------------------------------------------------------------------------------


def test_host_defaults_and_override(monkeypatch):
    assert host.current().kind == "launchd"                      # tests pin WT_HOST=launchd (conftest)
    monkeypatch.setenv("WT_HOST", "systemd")
    assert host.current().kind == "systemd"


def test_launchd_running_jobs_and_fail_closed(monkeypatch):
    out = "PID\tStatus\tLabel\n123\t0\tcom.wt.paper-b\n-\t0\tcom.wt.routine\n"
    monkeypatch.setattr(host, "_run", lambda cmd, timeout=10.0: SimpleNamespace(stdout=out, returncode=0))
    got = host.LaunchdHost().running_jobs([JOBS["paper-b"], JOBS["routine"], JOBS["forward"]])
    assert got == {"com.wt.paper-b": True, "com.wt.routine": False, "com.wt.forward": False}

    def boom(cmd, timeout=10.0):
        raise OSError("no launchctl")
    monkeypatch.setattr(host, "_run", boom)
    assert host.LaunchdHost().running_jobs([JOBS["paper-b"]]) == {"launchctl": True}


def test_systemd_running_jobs_and_fail_closed(monkeypatch):
    states = {"wt-paper-b.service": "active", "wt-routine.service": "inactive", "wt-forward.service": "activating"}
    monkeypatch.setattr(host, "_run", lambda cmd, timeout=10.0: SimpleNamespace(stdout=states[cmd[-1]] + "\n",
                                                                               returncode=0))
    got = host.SystemdHost().running_jobs([JOBS["paper-b"], JOBS["routine"], JOBS["forward"]])
    assert got == {"wt-paper-b": True, "wt-routine": False, "wt-forward": True}
    monkeypatch.setattr(host, "_run", lambda cmd, timeout=10.0: SimpleNamespace(stdout="", returncode=1))
    assert host.SystemdHost().running_jobs([JOBS["paper-b"]]) == {"systemctl": True}


def test_systemd_swap_from_meminfo(tmp_path):
    m = tmp_path / "meminfo"
    m.write_text("MemTotal:       12000000 kB\nSwapTotal:       4194304 kB\nSwapFree:        3145728 kB\n")
    s = host.SystemdHost().swap(m)
    assert s == {"total_gb": 4.0, "used_gb": 1.0, "free_gb": 3.0, "used_pct": 25.0}
    assert host.SystemdHost().swap(tmp_path / "missing") is None


# ---- schedules and units ---------------------------------------------------------------------------------------

def test_et_day_specs():
    assert et_days("Mon..Fri") == {0, 1, 2, 3, 4} and et_days("Fri") == {4} and et_days("Mon,Wed") == {0, 2}


@pytest.mark.parametrize("day", [dt.date(2026, 11, 2), dt.date(2027, 3, 15)])   # the Monday after each US change
def test_et_timers_keep_new_york_wall_time_across_dst(day):
    before = dt.datetime.combine(day - dt.timedelta(days=3), dt.time(12), tzinfo=NEW_YORK)   # the Friday before
    fires = JOBS["paper-b"].fires_et(before, days=4)
    monday = next(t for t in fires if t.date() == day)
    assert (monday.hour, monday.minute) == (8, 30) and monday.tzinfo == NEW_YORK
    assert all(t.weekday() < 5 for t in fires)                    # never on the weekend the clocks change


def test_every_trading_job_has_a_systemd_schedule_and_a_runtime_above_its_deadline():
    for j in JOBS.values():
        assert j.et or j.interval_s, j.name
        if j.deadline_min:
            assert j.runtime_max_h * 60 > j.deadline_min + 1, j.name
    assert JOBS["paper-b"].runtime_max_h >= 10


def test_paper_b_unit(tmp_path):
    svc = units.service(JOBS["paper-b"], Path("/home/wt/trading"))
    for line in ("Type=exec", "User=wt", "Wants=wt-secrets.service network-online.target time-sync.target",
                 "After=wt-secrets.service network-online.target time-sync.target", "OnFailure=wt-alert@%n.service",
                 "EnvironmentFile=/run/wt-secrets/env", "Environment=WT_HOST=systemd", "Restart=on-failure",
                 "RestartSec=60", "RestartPreventExitStatus=124", "RuntimeMaxSec=36000", "KillMode=mixed",
                 "TimeoutStopSec=60", "OOMScoreAdjust=-500", "LimitCORE=0",
                 "ExecStart=/home/wt/trading/.venv/bin/python -m wt.ops.jobs run paper-b"):
        assert line in svc.splitlines(), line
    assert "Requires=" not in svc                                  # a secrets restart must not restart paper-b
    assert svc.index("StartLimitIntervalSec") < svc.index("[Service]")   # StartLimit* belong in [Unit]
    assert "OnCalendar=Mon..Fri 08:30 America/New_York" in units.timer(JOBS["paper-b"])
    assert "Persistent=false" in units.timer(JOBS["paper-b"])


def test_dashboard_unit_is_an_interval_and_never_restarts():
    assert "Restart=no" in units.service(JOBS["dashboard"], Path("/r"))
    t = units.timer(JOBS["dashboard"])
    assert "OnUnitActiveSec=900s" in t and "OnCalendar" not in t


def test_render_and_diff(tmp_path):
    rendered = units.render_all(Path("/home/wt/trading"))
    assert set(rendered) == {f"wt-{j}.{k}" for j in JOBS for k in ("service", "timer")}
    assert units.main(["render", "--out", str(tmp_path), "--root", "/home/wt/trading"]) == 0
    assert units.diff(rendered, tmp_path) == []
    (tmp_path / "wt-routine.timer").write_text("changed")
    assert units.diff(rendered, tmp_path) == ["wt-routine.timer: differs from the code"]


@pytest.mark.skipif(shutil.which("systemd-analyze") is None, reason="systemd-analyze is only on Linux")
def test_systemd_accepts_every_calendar_spec():
    for j in JOBS.values():
        if j.et:
            r = subprocess.run(["systemd-analyze", "calendar", f"{j.et} America/New_York"], capture_output=True)
            assert r.returncode == 0, (j.name, r.stderr)


def test_gate_uses_new_york_times_on_systemd():
    at = dt.datetime(2026, 9, 30, 12, 0, tzinfo=NEW_YORK)           # 40 min before forward's 12:40 ET systemd start
    assert any("com.wt.forward" in x for x in window.upcoming_starts(at, clock="systemd"))
    # launchd starts forward at 05:40 Sydney, which is 15:40 ET that day: not within the hour
    assert not any("com.wt.forward" in x for x in window.upcoming_starts(at, clock="launchd"))


# ---- job runner: SIGTERM, pings --------------------------------------------------------------------------------

@pytest.fixture
def jobroot(tmp_path, monkeypatch):
    root = tmp_path / "root"
    (root / ".venv/bin").mkdir(parents=True)
    (root / ".venv/bin/python").symlink_to(sys.executable)
    monkeypatch.setattr(jobs, "load_sessions", lambda now: ({}, True))
    monkeypatch.setattr(jobs, "_sha", lambda root: "abc1234")
    monkeypatch.setattr(jobs, "launchd_loaded", lambda label: True)
    monkeypatch.setattr(jobs, "JOURNAL", tmp_path / "journal.jsonl")
    monkeypatch.setattr("wt.ops.locks.LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr("wt.ops.heartbeat.HEARTBEAT_DIR", tmp_path / "hb")
    monkeypatch.setattr(jobs.preflight, "run_checks", lambda root: [preflight.Check("ok", True)])
    box: list[dict] = []
    monkeypatch.setattr(alerts, "_send", lambda msg, topic, server, timeout=5.0: box.append(msg) or True)
    pings: list[tuple] = []
    monkeypatch.setattr(hc, "ping", lambda slug, signal="", body="", timeout=5.0: pings.append((slug, signal)) or True)
    return root, alerts.Alerts(root=tmp_path / "alerts", topic="t"), box, tmp_path, pings


def _job(code: str, name="routine") -> Job:
    return Job(name, f"com.wt.{name}", 0, 0, ("-c", code), "backtest", name)


def test_sigterm_is_forwarded_and_the_run_is_recorded(jobroot, monkeypatch):
    root, a, box, tmp, pings = jobroot
    monkeypatch.setattr(jobs, "KILL_GRACE_S", 5)
    child = "import signal, sys, time; signal.signal(signal.SIGTERM, lambda *a: sys.exit(0)); time.sleep(60)"
    threading.Timer(1.5, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    assert jobs.run_job(_job(child), root, alerts=a) == 143
    assert last_runs(tmp / "hb")["routine"]["status"] == "terminated"
    assert box[-1]["title"] == "routine failed" and "SIGTERM" in box[-1]["message"]
    assert ("wt-routine", "fail") in pings
    assert signal.getsignal(signal.SIGTERM) is not jobs.run_child     # the handler was restored


def test_pings_success_refusal_and_lock(jobroot, monkeypatch):
    root, a, box, tmp, pings = jobroot
    assert jobs.run_job(_job("pass"), root, alerts=a) == 0
    assert pings[-1] == ("wt-routine", "")
    monkeypatch.setattr(jobs.preflight, "run_checks", lambda root: [preflight.Check("on main", False, "x")])
    assert jobs.run_job(_job("pass"), root, alerts=a) == 0
    assert pings[-1] == ("wt-routine", "fail")
    n = len(pings)
    from wt.ops.locks import job_lock
    with job_lock("routine", tmp / "locks"):
        assert jobs.run_job(_job("pass"), root, alerts=a) == 0
    assert len(pings) == n                                          # a held lock is not a failure: no ping


def test_paper_b_armed_ping_on_a_day_without_a_session(jobroot):
    root, a, box, tmp, pings = jobroot
    (tmp / "journal.jsonl").write_text("")
    code = (f"import json, datetime; open({str(tmp / 'journal.jsonl')!r}, 'a').write(json.dumps("
            "{'ts': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': 'no_session'}) + '\\n')")
    assert jobs.run_job(_job(code, name="paper-b"), root, alerts=a) == 0
    assert ("wt-paper-b-armed", "") in pings and ("wt-paper-b", "") in pings


def test_paper_b_that_never_armed_fails_its_armed_check(jobroot):
    root, a, box, tmp, pings = jobroot
    assert jobs.run_job(_job("raise SystemExit(3)", name="paper-b"), root, alerts=a) == 3
    assert ("wt-paper-b-armed", "fail") in pings and ("wt-paper-b", "fail") in pings


def test_hc_ping_is_off_without_a_key_and_never_raises(monkeypatch):
    assert hc.ping("wt-routine") is False
    monkeypatch.setenv("HC_PING_KEY", "k")
    seen = {}

    def post(url, data, timeout):
        seen.update(url=url, data=data.decode())
        raise hc.requests.ConnectionError("down")
    monkeypatch.setattr(hc.requests, "post", post)
    assert hc.ping("wt-routine", "fail", "loss US$12.50 on PA3T8Y4VW2KV") is False
    assert seen["url"] == "https://hc-ping.com/k/wt-routine/fail"
    assert "12.50" not in seen["data"] and "PA3T8Y4VW2KV" not in seen["data"]


# ---- the secrets file fails closed -----------------------------------------------------------------------------

def test_preflight_checks_the_vm_secrets_file_and_paging(tmp_path, monkeypatch):
    f = tmp_path / "env"
    monkeypatch.setenv("WT_ENV_FILE", str(f))
    assert preflight.check_env_mode(tmp_path).ok is False                       # missing
    f.write_text("")
    f.chmod(0o400)
    assert "empty" in preflight.check_env_mode(tmp_path).detail
    f.chmod(0o600)
    f.write_text("NTFY_TOPIC=x\n")
    f.chmod(0o400)
    assert preflight.check_env_mode(tmp_path).ok is True
    monkeypatch.setenv("WT_HOST", "systemd")
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    names = {c.name: c for c in preflight.run_checks(tmp_path)}
    assert names["paging configured"].ok is False
    assert "paging configured" in jobs.EXITS_ONLY_CHECKS                        # a paper-b position is still managed


def test_publisher_refuses_without_its_secrets_file(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(publish, "OUT", tmp_path)
    monkeypatch.setattr("wt.ops.locks.LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr(publish, "load_docs", lambda out=None: {"x": {}})
    monkeypatch.setenv("WT_ENV_FILE", str(tmp_path / "missing"))
    assert publish.main(["--no-collect"]) == 2
    assert "not publishing" in capsys.readouterr().err


def test_known_secret_values_are_scrubbed_from_the_environment(monkeypatch):
    from wt.ops import safeio
    monkeypatch.setenv("APCA_API_SECRET_KEY", "supersecretvalue123")
    monkeypatch.setenv("NTFY_TOPIC", "short")                                  # too short to scrub safely
    vals = safeio.secret_env_values()
    assert "supersecretvalue123" in vals and "short" not in vals


def test_heavy_jobs_have_memory_limits_and_the_runner_has_none():
    root = Path("/home/wt/trading")
    for name in ("routine", "forward", "weekly"):
        svc = units.service(JOBS[name], root).splitlines()
        assert "MemoryHigh=1536M" in svc and "MemoryMax=2G" in svc and "MemorySwapMax=512M" in svc
    assert "MemoryMax=1G" in units.service(JOBS["dashboard"], root).splitlines()
    assert not any(x.startswith("Memory") for x in units.service(JOBS["paper-b"], root).splitlines())


def test_rendered_units_have_no_inline_comments():
    for name, text in units.render_all(Path("/home/wt/trading")).items():
        for line in text.splitlines():
            assert "#" not in line.split("=", 1)[-1] or line.startswith("ExecStart"), f"{name}: {line}"


def test_the_install_fingerprint_covers_units_static_units_and_helpers(tmp_path):
    import shutil
    repo = Path(__file__).resolve().parents[2]
    fp = units.fingerprint(repo)
    paths = [line.split("  ", 1)[1] for line in fp.splitlines()]
    assert "/etc/systemd/system/wt-paper-b.service" in paths and "/etc/systemd/system/wt-backup.timer" in paths
    assert "/usr/local/bin/wt-deploy" in paths and paths == sorted(paths)
    assert units.fingerprint(repo) == fp                              # stable
    trees = {}
    for name in ("base", "changed"):
        trees[name] = tmp_path / name
        for d in (units.HELPER_DIR, units.STATIC_DIR):
            shutil.copytree(repo / d, trees[name] / d)
    (trees["changed"] / units.HELPER_DIR / "wt-deploy").write_text("changed\n")
    live = Path("/home/wt/trading")                                  # the checkout the units run from
    a, b = (set(units.fingerprint(t, live).splitlines()) for t in trees.values())
    assert {line.split("  ", 1)[1] for line in a ^ b} == {"/usr/local/bin/wt-deploy"}   # a changed helper, alone


def test_a_shadow_host_pings_only_its_own_heartbeat(monkeypatch):
    monkeypatch.setenv("HC_PING_KEY", "k")
    monkeypatch.setenv("WT_ROLE", "shadow")
    monkeypatch.setenv("WT_HOST_ID", "gcp-use1")
    urls = []
    monkeypatch.setattr(hc.requests, "post", lambda url, data, timeout: urls.append(url) or type("R", (), {"ok": True})())
    assert hc.ping("wt-paper-b") is False and urls == []           # shared job slugs: never from a shadow
    assert hc.heartbeat("published") is True
    assert urls == ["https://hc-ping.com/k/wt-host-gcp-use1"]
    monkeypatch.setenv("WT_ROLE", "primary")
    assert hc.ping("wt-paper-b") is True and urls[-1] == "https://hc-ping.com/k/wt-paper-b"
