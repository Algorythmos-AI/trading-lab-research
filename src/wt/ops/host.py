"""The machine the jobs run on: launchd on the Mac, systemd on the Linux VM (ADR 0004).

Everything host-specific the ops code needs goes through here, so the deploy gate, the job runner and the status
collector work the same on both:

  * running_jobs(jobs)  which trading jobs are running right now (the deploy gate refuses while any is);
  * loaded(job)         whether the job's agent/unit is installed (the job runner's follower fallback);
  * swap()              swap use, for the dashboard's host panel.

WT_HOST=launchd|systemd overrides the platform default (tests, and a Linux box that isn't the VM).
Both fail closed: when the service manager can't be asked, jobs count as running.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Protocol

from wt.ops.schedule import Job

ACTIVE = {"active", "activating", "deactivating", "reloading"}
_LAUNCH_RE = re.compile(r"^(\S+)\s+(-?\d+|-)\s+(\S+)$")


def unit(job: Job) -> str:
    return f"wt-{job.name}"


class Host(Protocol):
    kind: str

    def running_jobs(self, jobs: list[Job]) -> dict[str, bool]: ...

    def loaded(self, job: Job) -> bool: ...

    def swap(self) -> dict[str, float] | None: ...


def _run(cmd: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


class LaunchdHost:
    kind = "launchd"

    def running_jobs(self, jobs: list[Job]) -> dict[str, bool]:
        try:
            text = _run(["launchctl", "list"]).stdout
        except (OSError, subprocess.SubprocessError):
            return {"launchctl": True}          # can't tell: treat as running (fail closed)
        pids: dict[str, bool] = {}
        for line in text.splitlines():
            m = _LAUNCH_RE.match(line.strip())
            if m:
                pids[m.group(3)] = m.group(1) != "-"
        return {j.label: pids.get(j.label, False) for j in jobs}

    def loaded(self, job: Job) -> bool:
        try:
            return _run(["launchctl", "list", job.label]).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return True                         # unknown: assume installed rather than run a job twice

    def swap(self) -> dict[str, float] | None:
        try:
            text = _run(["sysctl", "vm.swapusage"]).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        m = re.search(r"total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M", text)
        if not m:
            return None
        total, used, free = (float(x) / 1024 for x in m.groups())
        return {"total_gb": round(total, 2), "used_gb": round(used, 2), "free_gb": round(free, 2),
                "used_pct": round(100 * used / total, 1) if total else 0.0}


class SystemdHost:
    kind = "systemd"

    def _state(self, name: str) -> str | None:
        try:
            r = _run(["systemctl", "show", "--property=ActiveState", "--value", f"{name}.service"])
        except (OSError, subprocess.SubprocessError):
            return None
        return r.stdout.strip() if r.returncode == 0 else None

    def running_jobs(self, jobs: list[Job]) -> dict[str, bool]:
        out: dict[str, bool] = {}
        for j in jobs:
            state = self._state(unit(j))
            if state is None:
                return {"systemctl": True}      # can't tell: treat as running (fail closed)
            out[unit(j)] = state in ACTIVE
        return out

    def loaded(self, job: Job) -> bool:
        try:
            return _run(["systemctl", "cat", f"{unit(job)}.service"]).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return True

    def swap(self, meminfo: Path = Path("/proc/meminfo")) -> dict[str, float] | None:
        try:
            info: dict[str, Any] = {}
            for line in meminfo.read_text().splitlines():
                k, _, v = line.partition(":")
                info[k.strip()] = float(v.split()[0]) / (1024 * 1024)   # kB -> GB
        except (OSError, ValueError, IndexError):
            return None
        total, free = info.get("SwapTotal", 0.0), info.get("SwapFree", 0.0)
        used = total - free
        return {"total_gb": round(total, 2), "used_gb": round(used, 2), "free_gb": round(free, 2),
                "used_pct": round(100 * used / total, 1) if total else 0.0}


def current() -> Host:
    kind = os.environ.get("WT_HOST") or ("launchd" if sys.platform == "darwin" else "systemd")
    return LaunchdHost() if kind == "launchd" else SystemdHost()
