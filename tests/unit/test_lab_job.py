"""The options lab's jobs on the host (DEC-0060): the recorder's schedule, its unit's caps and restart policy, the
weekly archive check, and the secrets they read. Nothing else in the schedule or the units changes."""
from __future__ import annotations

from pathlib import Path

from wt.ops import units
from wt.ops.schedule import JOBS

ROOT = Path(__file__).resolve().parents[2]


def svc(name: str) -> list[str]:
    return units.service(JOBS[name], Path("/home/wt/trading")).splitlines()


def test_the_recorder_job_runs_the_lab_recorder_every_session_and_is_not_a_trading_job() -> None:
    j = JOBS["lab-tape"]
    assert j.command == ("-m", "wt.lab.recorder") and j.et == "Mon..Fri 09:15" and j.desk == "options"
    assert not j.trading and not j.preflight and j.interval_s is None
    assert j.deadline_min == 530 and j.runtime_max_h * 60 > j.deadline_min + 1      # 09:15 + 530 min = 18:05
    assert "OnCalendar=Mon..Fri 09:15 America/New_York" in units.timer(j)


def test_the_recorder_unit_restarts_on_failure_within_bounds_and_yields_to_the_runners() -> None:
    lines = svc("lab-tape")
    for want in ("Restart=on-failure", "RestartSec=60", "RestartPreventExitStatus=124 2", "StartLimitIntervalSec=6h",
                 "StartLimitBurst=3", "MemoryHigh=768M", "MemoryMax=1G", "MemorySwapMax=0", *units.LAB_CAPS,
                 "ExecStart=/home/wt/trading/.venv/bin/python -m wt.ops.jobs run lab-tape", "RuntimeMaxSec=32400"):
        assert want in lines, want
    assert "OOMScoreAdjust=-500" not in lines


def test_no_other_unit_changes() -> None:
    for name, j in JOBS.items():
        if name == "lab-tape":
            continue
        lines = svc(name)
        assert not any(c in lines for c in units.LAB_CAPS), name
        assert "RestartPreventExitStatus=124" in lines, name                       # unchanged for every other job
        assert ("Restart=on-failure" in lines) == j.trading, name               # only trading jobs restart
    assert units.RESTART_JOBS == {"lab-tape"}


def test_the_weekly_archive_check_reads_only_and_never_restarts() -> None:
    j = JOBS["lab-archive-check"]
    assert j.command == ("-m", "wt.lab.archive", "check") and j.et == "Sat 11:00" and not j.trading
    lines = svc("lab-archive-check")
    assert "Restart=no" in lines and "MemoryMax=512M" in lines


def test_the_secrets_helper_asks_for_the_labs_own_bucket_token_and_settings() -> None:
    text = (ROOT / "deploy/oci/bin/wt-set-secrets").read_text()
    for field in ('"R2_LAB_ACCESS_KEY_ID||1|0"', '"R2_LAB_SECRET_ACCESS_KEY||1|0"', '"WT_LAB_KEY_PREFIX|APCA_CLONE|0|0"',
                  '"WT_LAB_RATE_LIMIT|1000|0|0"'):
        assert field in text, field


def test_the_lab_bucket_token_is_scrubbed_from_logs_and_alerts() -> None:
    from wt.ops import safeio
    assert {"R2_LAB_ACCESS_KEY_ID", "R2_LAB_SECRET_ACCESS_KEY"} <= set(safeio.SECRET_KEYS)
    assert "s3cr3t-lab-token" in safeio.secret_env_values({"R2_LAB_SECRET_ACCESS_KEY": "s3cr3t-lab-token"})
