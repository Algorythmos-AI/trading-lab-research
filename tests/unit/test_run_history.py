"""The run history is read from its end, and one frequent job cannot crowd the others out of the dashboard."""
from __future__ import annotations

import datetime as dt
import json

from wt.ops import heartbeat


def _run(job: str, started: str, status: str = "ok") -> dict:
    return {"job": job, "started": started, "ended": started, "status": status, "exit": 0}


def test_only_the_end_of_a_huge_history_is_read(tmp_path):
    with open(tmp_path / "runs.jsonl", "w") as fh:
        for i in range(60_000):                                   # far past any reader's size limit
            fh.write(json.dumps(_run("dashboard", f"2026-01-01T00:00:{i % 60:02d}+00:00", "ok")) + "\n")
        fh.write(json.dumps(_run("paper-b", "2026-10-06T12:30:00+00:00")) + "\n")
    assert (tmp_path / "runs.jsonl").stat().st_size > heartbeat.TAIL_BYTES
    rows = heartbeat.recent_runs(tmp_path)
    assert rows[-1]["job"] == "paper-b" and 1000 < len(rows) < 60_000
    assert all(isinstance(r, dict) and "job" in r for r in rows)   # the line cut by the seek is dropped, not parsed
    since = dt.datetime(2026, 10, 6, tzinfo=dt.UTC)
    assert heartbeat.ok_runs_since("paper-b", since, tmp_path) == 1


def test_a_missing_or_damaged_history_reads_as_empty(tmp_path):
    assert heartbeat.recent_runs(tmp_path) == []
    (tmp_path / "runs.jsonl").write_text('{"job": "routine"}\nnot json\n[1, 2]\n\n')
    assert heartbeat.recent_runs(tmp_path) == [{"job": "routine"}]


def test_a_frequent_job_keeps_its_newest_runs_and_every_days_worst():
    runs = []
    for day in range(1, 11):
        for n in range(100):
            bad = (day, n) == (3, 40)
            runs.append(_run("dashboard", f"2026-10-{day:02d}T{n // 5:02d}:{n % 5 * 10:02d}:00+00:00", "failed" if bad else "ok"))
        runs.append(_run("routine", f"2026-10-{day:02d}T11:30:00+00:00"))
    out = heartbeat.thin_runs(runs, {"dashboard"}, keep_last=60)
    dash = [r for r in out if r["job"] == "dashboard"]
    assert sum(1 for r in out if r["job"] == "routine") == 10                  # session jobs are never thinned
    assert len(dash) == 60 + 10 + 1                                            # newest 60, each day's first run, the failure
    assert any(r["status"] == "failed" and r["started"].startswith("2026-10-03") for r in dash)
    assert {r["started"][:10] for r in dash} == {f"2026-10-{d:02d}" for d in range(1, 11)}
    assert out == sorted(out, key=runs.index)                                  # order kept
