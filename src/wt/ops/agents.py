"""launchd agents, generated from `wt.ops.schedule.JOBS` (no hand-edited plists, no hard-coded home paths).

    python -m wt.ops.agents diff                 # which installed agents differ from what the code expects
    python -m wt.ops.agents install --trading    # OWNER ONLY: write the plists and (re)load them

Installing reloads jobs that trade, so it is for the owner to run, outside the trading window. The command refuses
while the deploy gate is closed.
"""
from __future__ import annotations

import argparse
import os
import plistlib
import subprocess
import sys
from pathlib import Path
from typing import Any

from wt.core.config import ROOT
from wt.ops.schedule import JOBS, Job

AGENT_DIR = Path.home() / "Library" / "LaunchAgents"
PATH = f"/opt/homebrew/bin:{Path.home()}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


def render(job: Job, root: Path = ROOT) -> bytes:
    interval: dict[str, int] = {"Hour": job.hour, "Minute": job.minute}
    if job.weekday is not None:
        interval["Weekday"] = job.weekday
    body: dict[str, Any] = {
        "Label": job.label,
        "ProgramArguments": [str(root / "deploy" / "run_job.sh"), job.name],
        "StartCalendarInterval": interval,
        "EnvironmentVariables": {"PATH": PATH, "HOME": str(Path.home())},
        "StandardOutPath": str(root / "logs" / f"launchd_{job.name}.out"),
        "StandardErrorPath": str(root / "logs" / f"launchd_{job.name}.err"),
        "RunAtLoad": False,
        "ProcessType": "Standard",
    }
    return plistlib.dumps(body, sort_keys=True)


def diff(root: Path = ROOT, agent_dir: Path = AGENT_DIR) -> list[str]:
    out = []
    for job in JOBS.values():
        p = agent_dir / f"{job.label}.plist"
        if not p.exists():
            out.append(f"{job.label}: not installed")
            continue
        try:
            installed = plistlib.loads(p.read_bytes())
        except (OSError, plistlib.InvalidFileException, ValueError):
            out.append(f"{job.label}: unreadable")
            continue
        if installed != plistlib.loads(render(job, root)):
            out.append(f"{job.label}: differs from the code")
    return out


def install(root: Path = ROOT, agent_dir: Path = AGENT_DIR) -> int:
    from wt.ops.deploy import gate_blockers
    if blockers := gate_blockers():
        print("Refusing to reload the trading agents now:\n  " + "\n  ".join(blockers))
        return 2
    agent_dir.mkdir(parents=True, exist_ok=True)
    (root / "logs").mkdir(exist_ok=True)
    uid = os.getuid()
    for job in JOBS.values():
        p = agent_dir / f"{job.label}.plist"
        p.write_bytes(render(job, root))
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/{job.label}"], capture_output=True)
        r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(p)], capture_output=True, text=True)
        print(f"{job.label}: {'loaded' if r.returncode == 0 else 'FAILED ' + r.stderr.strip()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.agents")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("diff")
    i = sub.add_parser("install")
    i.add_argument("--trading", action="store_true", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "diff":
        d = diff()
        print("\n".join(d) if d else "launchd agents match the code")
        return 0
    return install()


if __name__ == "__main__":
    sys.exit(main())
