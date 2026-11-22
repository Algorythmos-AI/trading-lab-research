"""The Radar → Options shadow as a host job (DEC-0070 section 4): its schedule row, unit, dead-man check and start-by
time; and `python -m wt.options.radar_select job`: today's session, the Radar read again until 07:45 New York, one run
on the last edition read, a second run that is not a failure, and a killed run's leftovers."""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

import pytest
import yaml
from test_radar_select import CFG, DESK, S, chain_reader, edition, er, world

from wt.ops import jobs, units
from wt.ops.schedule import JOBS
from wt.options import radar_candidates as rc
from wt.options import radar_select as rs
from wt.options import select_fetch as sf

ROOT = Path(__file__).resolve().parents[2]
START = dt.datetime(2026, 11, 23, 11, 45, tzinfo=dt.UTC)            # 06:45 New York (EST)
UNTIL = dt.datetime(2026, 11, 23, 12, 45, tzinfo=dt.UTC)            # 07:45 New York


# ---------------------------------------------------------------- the job on the host
def test_the_job_row_runs_the_shadow_after_the_radar_and_ends_before_the_publish_deadline() -> None:
    j = JOBS["options-select"]
    assert j.command == ("-m", "wt.options.radar_select", "job") and j.et == "Mon..Fri 06:45"
    assert j.desk == "options" and not j.trading and not j.preflight and j.interval_s is None
    start = dt.datetime(2026, 11, 23, 6, 45)
    assert start + dt.timedelta(minutes=j.deadline_min or 0) <= dt.datetime(2026, 11, 23, *rs.PUBLISH_BY)
    assert start + dt.timedelta(minutes=j.deadline_min or 0) > dt.datetime(2026, 11, 23, *rs.RADAR_RETRY_UNTIL)
    # systemd's limit covers run_job's wait for a deploy (30 min) plus the child's own deadline
    assert j.runtime_max_h * 60 > jobs.DEPLOY_WAIT_S / 60 + (j.deadline_min or 0)
    assert "OnCalendar=Mon..Fri 06:45 America/New_York" in units.timer(j)


def test_the_unit_never_restarts_and_is_capped() -> None:
    lines = units.service(JOBS["options-select"], Path("/home/wt/trading")).splitlines()
    for want in ("Restart=no", "MemoryMax=768M", "MemorySwapMax=0", "RuntimeMaxSec=9000",
                 "ExecStart=/home/wt/trading/.venv/bin/python -m wt.ops.jobs run options-select"):
        assert want in lines, want
    assert "OOMScoreAdjust=-500" not in lines and not any(c in lines for c in units.LAB_CAPS)


def test_a_run_that_never_happened_is_seen_off_the_host_and_on_the_dashboard() -> None:
    assert "options-select" in jobs.HC_JOBS
    assert "`wt-options-select`" in (ROOT / "docs/runbooks/dead-man-switches.md").read_text()
    cfg = yaml.safe_load((ROOT / "config/dashboard.yaml").read_text())
    row = [r for r in cfg["host"]["overlay"] if r["label"] == "com.wt.options-select"]
    assert len(row) == 1 and row[0]["must_start_before_et"] == "07:00"


# ---------------------------------------------------------------- the job's own logic
class Clock:
    """A clock that moves only when the job sleeps."""

    def __init__(self, t: dt.datetime) -> None:
        self.t, self.slept = t, []

    def __call__(self) -> dt.datetime:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += dt.timedelta(seconds=s)


class Reader:
    def __init__(self, *answers: Any) -> None:
        self.answers, self.reads = list(answers), 0

    def __call__(self) -> Any:
        self.reads += 1
        a = self.answers[min(self.reads, len(self.answers)) - 1]
        if isinstance(a, Exception):
            raise a
        return a


@pytest.fixture
def job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(rc, "load_config", lambda path=rc.CONFIG_PATH: CFG)
    monkeypatch.setattr(sf, "desk_names", lambda: list(DESK))
    monkeypatch.setattr(rs, "read_earnings", lambda: [er("XYZ", "2027-01-28"), er("ABC", "2027-01-28")])
    monkeypatch.setattr(rs, "alpaca_chain_reader", lambda *a, **k: chain_reader)

    def go(reader: Reader, clock: Clock) -> int:
        broker, _ = world()
        return rs.main(["job", "--root", str(tmp_path)], client=lambda: broker, read_radar=reader, clock=clock,
                       sleep=clock.sleep)
    return go


def saved(root: Path, name: str) -> dict[str, Any]:
    out: dict[str, Any] = json.loads((root / S / name).read_text())
    return out


def test_a_day_with_no_session_writes_nothing(job: Any, tmp_path: Path) -> None:
    reader = Reader(edition())
    assert job(reader, Clock(dt.datetime(2026, 11, 21, 11, 45, tzinfo=dt.UTC))) == rs.EXIT_OK      # a Saturday
    assert job(reader, Clock(dt.datetime(2026, 11, 26, 11, 45, tzinfo=dt.UTC))) == rs.EXIT_OK      # Thanksgiving
    assert reader.reads == 0 and list(tmp_path.iterdir()) == []


def test_a_fresh_edition_is_run_on_at_once(job: Any, tmp_path: Path) -> None:
    clock, reader = Clock(START), Reader(edition())
    assert job(reader, clock) == rs.EXIT_OK
    assert reader.reads == 1 and clock.slept == []
    assert saved(tmp_path, "run.json")["radar_status"] == "ok"
    assert "XYZ" in saved(tmp_path, "universe.json")["names"]


def test_a_stale_edition_is_read_again_and_the_run_uses_the_fresh_one(job: Any, tmp_path: Path) -> None:
    clock = Clock(START)
    reader = Reader(edition(edition_date="2026-11-20", run_id="r-old"), edition(run_id="r-new"))
    assert job(reader, clock) == rs.EXIT_OK
    assert reader.reads == 2 and clock.slept == [rs.RADAR_RETRY_EVERY_S]       # one edition read per try, no more
    cand = saved(tmp_path, "candidates.json")
    assert cand["status"] == "ok" and cand["provenance"]["run_id"] == "r-new"
    run = saved(tmp_path, "run.json")
    assert run["run_at"] == (START + dt.timedelta(seconds=rs.RADAR_RETRY_EVERY_S)).isoformat()   # the read's time


def test_a_radar_never_fresh_by_0745_runs_on_the_twelve_and_says_so(job: Any, tmp_path: Path) -> None:
    clock, reader = Clock(START), Reader(edition(edition_date="2026-11-20"))
    assert job(reader, clock) == rs.EXIT_OK
    assert reader.reads == 13 and clock.t == UNTIL                  # 06:45, 06:50, ..., 07:45
    run = saved(tmp_path, "run.json")
    assert run["radar_status"] == "radar_stale" and run["run_at"] == UNTIL.isoformat()
    assert saved(tmp_path, "universe.json")["names"] == DESK


def test_a_reader_that_always_fails_is_the_radar_missing_with_its_cause(job: Any, tmp_path: Path) -> None:
    clock, reader = Clock(START), Reader(TimeoutError("no answer"))
    assert job(reader, clock) == rs.EXIT_OK
    run = saved(tmp_path, "run.json")
    assert run["radar_status"] == "radar_missing" and "TimeoutError" in run["radar_detail"]
    assert "no answer" not in json.dumps(run)                       # the type, never the text
    assert saved(tmp_path, "universe.json")["names"] == DESK


def test_a_failed_read_then_a_good_one_runs_on_the_good_one(job: Any, tmp_path: Path) -> None:
    clock, reader = Clock(START), Reader(ConnectionError("down"), edition())
    assert job(reader, clock) == rs.EXIT_OK
    assert reader.reads == 2 and saved(tmp_path, "run.json")["radar_status"] == "ok"


def test_a_second_job_run_for_the_session_is_not_a_failure(job: Any, tmp_path: Path, capsys: Any) -> None:
    assert job(Reader(edition()), Clock(START)) == rs.EXIT_OK
    first = (tmp_path / S / "run.json").read_bytes()
    reader = Reader(edition(run_id="r-other"))
    assert job(reader, Clock(START)) == rs.EXIT_OK
    assert reader.reads == 0 and (tmp_path / S / "run.json").read_bytes() == first
    assert "already run" in capsys.readouterr().out


def test_a_fetch_failure_still_fails_the_job(job: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*a: Any, **k: Any) -> Any:
        raise sf.FetchError("http", "bars unavailable")
    monkeypatch.setattr(rs, "run", broken)
    assert job(Reader(edition()), Clock(START)) == rs.EXIT_ERROR
    assert not (tmp_path / S).exists()


def test_a_killed_runs_leftovers_are_removed_and_a_live_ones_kept(job: Any, tmp_path: Path) -> None:
    dead, live = tmp_path / f".{S}.tmp-999999999", tmp_path / f".{S}.tmp-{os.getppid()}"
    other = tmp_path / ".2026-11-20.tmp-999999999"                   # another session's: not this run's to judge
    for p in (dead, live, other):
        p.mkdir()
    assert job(Reader(edition()), Clock(START)) == rs.EXIT_OK
    assert not dead.exists() and live.exists() and other.exists() and (tmp_path / S / "run.json").exists()


def test_the_off_switch_runs_nothing(job: Any, tmp_path: Path) -> None:
    (tmp_path / rs.OFF).touch()
    reader = Reader(edition())
    assert job(reader, Clock(START)) == rs.EXIT_OK
    assert reader.reads == 0 and not (tmp_path / S).exists()
