"""The stock desk (Gap Hunter, DEC-0066's "sleeve S") as a host job: the `paper-s` job and unit, what the deploy gate
and the boot reconcile know about it, and the host's secret helpers. The QQQ rule's job (`paper-b`) is retired
(DEC-0069): no job or unit of it is rendered, a unit still installed runs nothing, and `paper-s`'s own unit is
byte for byte what it was before.

The lease key is in test_lease.py; the runner's own behaviour under systemd, the shadow role and its pages are in
test_runner_s.py."""
from __future__ import annotations

import datetime as dt
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml
from test_host_linux import _job, jobroot  # noqa: F401 — the fixture

from wt.core.clock import et
from wt.ops import bootreconcile, deploy, hostsync, jobs, locks, safeio, units
from wt.ops.heartbeat import last_runs
from wt.ops.schedule import JOBS, TRADING_JOBS
from wt.ops.window import Session

ROOT = Path(__file__).resolve().parents[2]
BIN = ROOT / "deploy" / "oci" / "bin"
T0 = dt.datetime(2026, 11, 20, 13, 30, tzinfo=dt.UTC)
LIVE = Path("/home/wt/trading")


# ---- the job and its unit -----------------------------------------------------------------------------------------------

# The unit as it was rendered on origin/integration before DEC-0069 (a4460834): sha256 c8dccfc0... and 026939e7...
PAPER_S_SERVICE = """[Unit]
Description=Trading Lab paper-s: Sleeve S paper session (stock desk); scans from the open, flat by the close
Wants=wt-secrets.service network-online.target time-sync.target
After=wt-secrets.service network-online.target time-sync.target
OnFailure=wt-alert@%n.service
StartLimitIntervalSec=6h
StartLimitBurst=3

[Service]
Type=exec
User=wt
Group=wt
WorkingDirectory=/home/wt/trading
EnvironmentFile=/run/wt-secrets/env
Environment=WT_ENV_FILE=/run/wt-secrets/env
Environment=WT_HOST=systemd
Environment=PYTHONPATH=src
Environment=PYTHONUNBUFFERED=1
Environment=TZ=UTC
ExecStart=/home/wt/trading/.venv/bin/python -m wt.ops.jobs run paper-s
Restart=on-failure
RestartSec=60
RestartPreventExitStatus=124
RuntimeMaxSec=36000
KillMode=mixed
TimeoutStopSec=60
LimitCORE=0
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
OOMScoreAdjust=-500
"""
PAPER_S_TIMER = """[Unit]
Description=Start Trading Lab paper-s

[Timer]
OnCalendar=Mon..Fri 08:30 America/New_York
AccuracySec=1s
Persistent=false
Unit=wt-paper-s.service

[Install]
WantedBy=timers.target
"""


def test_the_paper_s_unit_is_byte_for_byte_what_it_was_before_the_qqq_job_left():
    import hashlib
    rendered = units.render_all(LIVE)
    svc, timer = rendered["wt-paper-s.service"], rendered["wt-paper-s.timer"]
    assert svc == PAPER_S_SERVICE and timer == PAPER_S_TIMER
    assert hashlib.sha256(svc.encode()).hexdigest() == "c8dccfc02d0b2ab829b430177b06d09c85760cc7f33501f5122ea887b0f07387"
    assert hashlib.sha256(timer.encode()).hexdigest() == "026939e73d520aa285cd075fc7d0236863e5ba41db6b39e0f83030e63589c88d"
    for line in ("Environment=WT_HOST=systemd", "Restart=on-failure", "OOMScoreAdjust=-500", "RuntimeMaxSec=36000",
                 "EnvironmentFile=/run/wt-secrets/env"):
        assert line in svc.splitlines()
    assert not any(x.startswith("Memory") for x in svc.splitlines())     # a runner is never capped


def test_the_paper_s_job_is_what_it_was():
    s = JOBS["paper-s"]
    assert (s.label, s.hour, s.minute, s.command, s.mode, s.log, s.et, s.runtime_max_h, s.desk, s.trading,
            s.preflight) == ("com.wt.paper-s", 22, 30, ("-c", "from wt.live.runner_s import run; run()"), "paper",
                             "paper_s", "Mon..Fri 08:30", 10, "stocks", True, True)
    assert "paper-s" in TRADING_JOBS and "paper-s" in jobs.KNOWN_JOBS and "paper_s" in jobs.KNOWN_LOGS


def test_no_paper_b_job_or_unit_is_rendered():
    """DEC-0069: the QQQ rule is retired. Its job is in no table derived from the schedule, and no unit, launchd
    agent or reboot start names it."""
    from wt.ops import agents
    assert "paper-b" not in JOBS and "paper-b" not in TRADING_JOBS and "paper-b" not in jobs.HC_JOBS
    assert not any(j.label == "com.wt.paper-b" or "runner_b" in " ".join(j.command) for j in JOBS.values())
    rendered = units.render_all(LIVE)
    assert not [n for n in rendered if "paper-b" in n]
    assert not [n for n, text in rendered.items() if "paper-b" in text or "runner_b" in text]
    assert not [p for p in units.installed_files(ROOT, LIVE) if "paper-b" in p or "paper_b" in p]
    assert "paper_b" not in jobs.KNOWN_LOGS
    assert not [j for j in JOBS.values() if b"paper-b" in agents.render(j, LIVE)]
    assert not (ROOT / "deploy" / "run_paper_b.sh").exists()
    for f in ("wt-alert", "wt-boot-reconcile"):
        assert "paper-b" not in (BIN / f).read_text(), f
    assert "paper-b" not in (ROOT / "deploy/oci/systemd/wt-boot-reconcile.service").read_text()


def test_the_installer_removes_a_unit_that_is_no_longer_a_job():
    """What takes wt-paper-b off the host: the owner's `sudo wt-install-units` stops, disables and deletes every
    installed job unit the code no longer renders. Read from the script: it is never run here."""
    text = (BIN / "wt-install-units").read_text()
    loop = text.split('if [[ -r "$list" ]]; then')[1].split("\nfi\n")[0]
    assert 'comm -23 <(sort "$list")' in loop                            # installed before, not rendered now
    assert 'systemctl disable --now "$u"' in loop and 'rm -f "/etc/systemd/system/$u"' in loop
    assert text.index("units render --out var/units") < text.index('if [[ -r "$list" ]]; then')


def test_a_paper_b_unit_still_installed_runs_nothing_and_fails_nothing(jobroot, monkeypatch, capsys):  # noqa: F811
    """Between the deploy and `sudo wt-install-units` the old timer still fires `wt.ops.jobs run paper-b`. That is a
    quiet exit 0: no lock, no heartbeat, no ping, no child, no page, and nothing for OnFailure= to report."""
    root, a, box, tmp, pings = jobroot
    monkeypatch.setattr(jobs, "run_job", lambda *args, **kw: pytest.fail("run_job called for a retired job"))
    assert "paper-b" in jobs.ARCHIVED_JOBS and jobs.GONE_JOBS["paper-b"] == "DEC-0069"
    assert jobs.main(["run", "paper-b"]) == 0
    assert "paper-b is no longer a job in this release (DEC-0069)" in capsys.readouterr().err
    assert pings == [] and box == [] and last_runs(tmp / "hb") == {}
    assert not (tmp / "locks").exists() and not (root / "logs").exists()
    # Its past runs stay on the record: the publisher hides only the jobs in RETIRED_JOBS (the closed crypto desk).
    assert "paper-b" not in jobs.RETIRED_JOBS and "paper-b" in jobs.KNOWN_JOBS


def test_the_qqq_rules_runner_is_still_importable_and_has_no_job():
    """History stays checkable: the module, its journal path and its helpers are where they were."""
    from wt.core.config import DATA_DIR
    from wt.live import runner_b, runner_s
    assert callable(runner_b.run) and runner_b.LIVE == DATA_DIR / "live"       # journal.jsonl and the plans live there
    for helper in ("measure_skew", "target_exit_limit", "times_from_clock", "with_deadline"):
        assert getattr(runner_s, helper) is getattr(runner_b, helper)
    assert locks.RUNNER_LOCK == "paper-b-runner" and locks.RUNNER_LOCK in locks.RUNNER_LOCKS


def test_its_deadline_is_the_close_plus_45_minutes():
    day = dt.date(2026, 11, 20)
    sessions = {day: Session(day, et(day, "09:30"), et(day, "16:00"))}
    start = et(day, "08:30")
    assert jobs.deadline_for(JOBS["paper-s"], start, sessions) == et(day, "16:45") == \
        jobs.deadline_for(JOBS["paper-o"], start, sessions)
    assert jobs.deadline_for(JOBS["paper-s"], start, {}) == start + dt.timedelta(minutes=15)


def test_it_has_a_dead_man_check_and_the_runbook_names_it():
    assert "paper-s" in jobs.HC_JOBS and jobs.hc_slug(JOBS["paper-s"]) == "wt-paper-s"
    assert "`wt-paper-s`" in (ROOT / "docs/runbooks/dead-man-switches.md").read_text()


def test_a_reboot_inside_the_session_restarts_it_and_never_the_retired_job():
    day = dt.date(2026, 11, 20)
    full = {day: Session(day, et(day, "09:30"), et(day, "16:00"))}
    for hhmm, want in (("06:14", False), ("06:15", True), ("12:00", True), ("15:59", True), ("16:00", False)):
        due = bootreconcile.due(et(day, hhmm), full)
        assert ("wt-paper-s.service" in due) is want and "wt-paper-b.service" not in due, hhmm
    assert bootreconcile.due(et(day, "11:00"), {}) == []


def test_the_deploy_gate_and_the_host_sync_read_both_runners_locks(tmp_path, monkeypatch):
    assert locks.RUNNER_LOCK == "paper-b-runner" and locks.RUNNER_LOCK_S == "paper-s-runner"
    assert locks.RUNNER_LOCKS == ("paper-b-runner", "paper-s-runner")
    monkeypatch.setattr(locks, "LOCK_DIR", tmp_path / "locks")
    seen: dict[str, list[str]] = {}
    monkeypatch.setattr(deploy, "load_sessions", lambda now: ({}, True))
    monkeypatch.setattr(deploy, "running_jobs", lambda: {})
    monkeypatch.setattr(deploy, "held", lambda names: seen.setdefault("asked", list(names)) and [])
    monkeypatch.setattr(deploy, "deploy_blockers", lambda now, sessions, running, held, exact: held)
    deploy.gate_blockers(T0)
    assert seen["asked"] == [*TRADING_JOBS, "paper-b-runner", "paper-s-runner"] and "paper-s" in seen["asked"]
    # A sleeve S runner orphaned by a dead wrapper holds only its own lock: the gate and the sync still see it.
    with locks.job_lock(locks.RUNNER_LOCK_S):
        assert locks.held([*TRADING_JOBS, *locks.RUNNER_LOCKS]) == ["paper-s-runner"]
        with hostsync.all_locks() as busy:
            assert busy == ["paper-s-runner"]
    with hostsync.all_locks() as busy:
        assert busy == []


# ---- the job runner ------------------------------------------------------------------------------------------------------

def test_without_its_key_pair_on_the_host_the_job_is_a_refusal_not_a_crash(jobroot, monkeypatch):  # noqa: F811
    root, a, box, tmp, pings = jobroot
    for name in jobs.S_KEYS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("APCA_API_KEY_ID", "PKQ-TEST")                  # the data pair is no substitute
    monkeypatch.setenv("APCA_API_SECRET_KEY", "q-secret")
    ran = tmp / "ran"
    job = _job(f"open({str(ran)!r}, 'w').close()", name="paper-s")
    assert jobs.run_job(job, root, alerts=a) == 0 and not ran.exists()    # exit 0: systemd restarts nothing
    assert [m["title"] for m in box] == ["paper-s refused to run"]
    assert box[0]["message"] == "the stock desk's key pair is not on this host" and box[0]["priority"] == 3
    assert last_runs(tmp / "hb")["paper-s"]["status"] == "refused" and ("wt-paper-s", "fail") in pings
    monkeypatch.setenv("APCA_S_KEY_ID", "PKS-TEST")                    # half a pair is no pair
    assert jobs.run_job(job, root, alerts=a) == 0 and not ran.exists()
    monkeypatch.setenv("APCA_S_SECRET_KEY", "s-secret")
    assert jobs.run_job(job, root, alerts=a) == 0 and ran.exists()
    assert last_runs(tmp / "hb")["paper-s"]["status"] == "ok" and pings[-1] == ("wt-paper-s", "")
    assert not any(slug == "wt-paper-b-armed" or slug == "wt-paper-b" for slug, _ in pings)


def test_a_failed_paper_s_run_pages_and_pings_only_its_own_check(jobroot, monkeypatch):  # noqa: F811
    root, a, box, tmp, pings = jobroot
    monkeypatch.setenv("APCA_S_KEY_ID", "PKS-TEST")
    monkeypatch.setenv("APCA_S_SECRET_KEY", "s-secret")
    for gone in ("paper_outcome", "alert_paper", "b_exposure", "exits_only_allowed", "paper_summary"):
        assert not hasattr(jobs, gone), gone                # the QQQ job's after-session checks left with it
    assert jobs.run_job(_job("raise SystemExit(3)", name="paper-s"), root, alerts=a) == 3
    assert box[-1]["title"] == "paper-s failed" and box[-1]["priority"] == 4
    assert ("wt-paper-s", "fail") in pings and not any(slug.startswith("wt-paper-b") for slug, _ in pings)


def test_the_job_starts_when_the_data_pair_holds_the_desks_own_keys(jobroot, monkeypatch):  # noqa: F811
    """DEC-0069, stage c: APCA_API_* may come to hold the stock desk's pair. The job runner does not mind."""
    root, a, box, tmp, pings = jobroot
    for name, value in (("APCA_S_KEY_ID", "PKS-TEST"), ("APCA_S_SECRET_KEY", "s-secret"),
                        ("APCA_API_KEY_ID", "PKS-TEST"), ("APCA_API_SECRET_KEY", "s-secret")):
        monkeypatch.setenv(name, value)
    ran = tmp / "ran"
    assert jobs.run_job(_job(f"open({str(ran)!r}, 'w').close()", name="paper-s"), root, alerts=a) == 0
    assert ran.exists() and box == [] and pings[-1] == ("wt-paper-s", "")


# ---- the host's helpers and config --------------------------------------------------------------------------------------

def test_the_secret_helpers_carry_sleeve_ss_pair_as_optional_hidden_values():
    text = (BIN / "wt-set-secrets").read_text()
    for field in ('"APCA_S_KEY_ID||1|0"', '"APCA_S_SECRET_KEY||1|0"'):           # hidden, not required
        assert field in text, field
    assert text.index("APCA_CLONE_SECRET_KEY") < text.index("APCA_S_KEY_ID") < text.index("NTFY_TOPIC")
    fetch = (BIN / "wt-fetch-secrets").read_text()
    required = fetch.split("REQUIRED=(")[1].split(")")[0]
    optional = fetch.split("OPTIONAL=(")[1].split(")")[0]
    primary = fetch.split("PRIMARY_REQUIRED=(")[1].split(")")[0]
    for name in jobs.S_KEYS:
        assert name in optional.split() and name not in required.split() and name not in primary.split()
        assert name in safeio.SECRET_KEYS                              # scrubbed from logs and pages like the others
    example = (ROOT / ".env.example").read_text()
    assert "\nAPCA_S_KEY_ID=\n" in example and "\nAPCA_S_SECRET_KEY=\n" in example


def test_a_failed_paper_s_unit_pages_at_priority_five_and_other_units_do_not(tmp_path):
    # wt-paper-b is no longer special (DEC-0069): a leftover unit of it exits 0, and would page like any other.
    out = tmp_path / "curl-args"
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "curl").write_text(f'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "{out}"\n')     # records, sends nothing
    (bin_ / "curl").chmod(0o755)
    paging = tmp_path / "paging"
    paging.write_text("NTFY_TOPIC=test-topic\nNTFY_SERVER=https://ntfy.invalid\n")
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "WT_PAGING_FILE": str(paging), "WT_ALERT_TEST": "1"}
    want = {"wt-paper-s.service": "5", "wt-paper-b.service": "4", "wt-paper-o.service": "4", "wt-forward.service": "4"}
    for unit, prio in want.items():
        r = subprocess.run(["bash", str(BIN / "wt-alert"), unit], env=env, capture_output=True, text=True,
                           timeout=30, cwd=tmp_path)
        assert r.returncode == 0 and f"Priority: {prio}" in out.read_text().splitlines(), unit


def test_the_dashboard_config_names_the_job_and_no_page_or_doc_names_a_setup():
    cfg = yaml.safe_load((ROOT / "config" / "dashboard.yaml").read_text())
    over = {j["label"]: j for j in cfg["host"]["overlay"]}
    assert over["com.wt.paper-s"] == {"label": "com.wt.paper-s", "name": "Gap Hunter (stock desk)",
                                      "must_start_before_et": "09:30"}
    assert not [j for j in [*cfg["host"]["overlay"], *cfg["host"]["jobs"]] if "paper-b" in j["label"]]
    # RESTRICTED text stays out of what this change wrote for people: the runbook section and the runner's pages.
    book = (ROOT / "docs/runbooks/position-alerts.md").read_text()
    pages = "\n".join(re.findall(r'pager\.\w+\((.*?)\)\n', (ROOT / "src/wt/live/runner_s.py").read_text(), re.S))
    assert pages.count("paper-s:") >= 15
    for text in (book.split("## Gap Hunter")[1], pages):
        assert not re.search(r"REV-1|reversal|bull flag|headline|catalyst", text, re.I)
