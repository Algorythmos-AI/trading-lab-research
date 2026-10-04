"""Job heartbeats: the last run of each job (var/heartbeats/<job>.json) and an append-only run history.

The collector publishes both, so the dashboard shows what ran, when, on which commit, and how it ended.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import uuid
from pathlib import Path
from typing import Any

from wt.core.config import STATE_DIR

HEARTBEAT_DIR = STATE_DIR / "heartbeats"


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def _atomic(path: Path, body: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    tmp.write_text(json.dumps(body, indent=1, sort_keys=True))
    os.replace(tmp, path)


class Heartbeat:
    def __init__(self, job: str, sha: str | None, root: Path | None = None) -> None:
        self.root = root or HEARTBEAT_DIR
        self.rec: dict[str, Any] = {"job": job, "run_id": uuid.uuid4().hex[:12], "sha": sha, "started": _now(),
                                    "ended": None, "status": "running", "exit": None, "detail": ""}
        self.write()

    def write(self) -> None:
        try:
            _atomic(self.root / f"{self.rec['job']}.json", self.rec)
        except OSError:
            pass                        # a heartbeat must never take a job down (e.g. disk full)

    def finish(self, status: str, exit_code: int | None, detail: str = "") -> dict[str, Any]:
        """status: ok | failed | refused | timeout | skipped."""
        self.rec.update(ended=_now(), status=status, exit=exit_code, detail=detail[:300])
        self.write()
        try:
            with open(self.root / "runs.jsonl", "a") as fh:
                fh.write(json.dumps(self.rec, sort_keys=True) + "\n")
        except OSError:
            pass
        return self.rec


def ok_runs_since(job: str, since: dt.datetime, root: Path | None = None) -> int:
    """How many runs of `job` ended ok at or after `since`, from the run history."""
    n = 0
    try:
        lines = (root or HEARTBEAT_DIR).joinpath("runs.jsonl").read_text().splitlines()
    except OSError:
        return 0
    for line in lines[-500:]:
        try:
            r = json.loads(line)
            if r.get("job") == job and r.get("status") == "ok" and dt.datetime.fromisoformat(r["ended"]) >= since:
                n += 1
        except (ValueError, KeyError, TypeError):
            continue
    return n


def last_runs(root: Path | None = None) -> dict[str, dict[str, Any]]:
    out = {}
    for f in sorted((root or HEARTBEAT_DIR).glob("*.json")):
        try:
            out[f.stem] = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
    return out
