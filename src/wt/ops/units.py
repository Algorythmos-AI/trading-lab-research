"""systemd units for the Linux VM, generated from `wt.ops.schedule.JOBS` (ADR 0004).

    python -m wt.ops.units render --out DIR --root /home/wt/trading    # write wt-<job>.service/.timer files
    python -m wt.ops.units diff --out DIR                                # which installed units differ

Claude never installs or reloads units: `wt-deploy` renders them into var/units/ and the owner installs them
(`sudo deploy/oci/bin/wt-install-units`), outside the trading window.

Design (reviewed 2026-09-29):
  * Jobs run as the unprivileged `wt` user. Secrets come from the tmpfs file root's wt-secrets.service writes once
    per boot; `Wants=` (not `Requires=`), so restarting wt-secrets for a key rotation never restarts paper-b.
  * Type=exec with RuntimeMaxSec above each job's own deadline plus its in-process wait: the jobs time themselves;
    systemd only catches a runaway. RestartPreventExitStatus=124 keeps a deadline kill from restarting.
  * Restart=on-failure with RestartSec=60 and at most 3 starts in 6 h, so a crash loop can't burn through.
  * KillMode=mixed + TimeoutStopSec=60: SIGTERM reaches the job runner, which forwards it to the job, waits,
    writes its heartbeat and pages (wt.ops.jobs); systemd kills the rest after 60 s.
  * OnFailure pages through wt-alert@, which doesn't depend on the secrets unit.
  * Timers fire in America/New_York (`Job.et`), AccuracySec=1s, Persistent=false: a missed start is not replayed
    after a reboot; wt-boot-reconcile starts paper-b and forward if the boot falls inside their windows.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from wt.ops.schedule import JOBS, PY, Job

UNIT_DIR = Path("/etc/systemd/system")
SECRETS_FILE = "/run/wt-secrets/env"
USER = "wt"


def service(job: Job, root: Path, user: str = USER) -> str:
    restart = "on-failure" if job.trading else "no"            # the dashboard just runs again in 15 minutes
    lines = [
        "[Unit]",
        f"Description=Trading Lab {job.name}: {job.what}",
        "Wants=wt-secrets.service network-online.target",
        "After=wt-secrets.service network-online.target",
        "OnFailure=wt-alert@%n.service",
        "StartLimitIntervalSec=6h",
        "StartLimitBurst=3",
        "",
        "[Service]",
        "Type=exec",
        f"User={user}",
        f"Group={user}",
        f"WorkingDirectory={root}",
        f"EnvironmentFile={SECRETS_FILE}",
        f"Environment=WT_ENV_FILE={SECRETS_FILE}",
        "Environment=WT_HOST=systemd",
        "Environment=PYTHONPATH=src",
        "Environment=PYTHONUNBUFFERED=1",
        "Environment=TZ=UTC",
        f"ExecStart={root / PY} -m wt.ops.jobs run {job.name}",
        f"Restart={restart}",
        "RestartSec=60",
        "RestartPreventExitStatus=124",
        f"RuntimeMaxSec={int(job.runtime_max_h * 3600)}",
        "KillMode=mixed",
        "TimeoutStopSec=60",
        "LimitCORE=0",
        "NoNewPrivileges=yes",
        "PrivateTmp=yes",
        "ProtectSystem=full",
    ]
    if job.name == "paper-b":
        lines.append("OOMScoreAdjust=-500")                    # the last thing the kernel should kill
    return "\n".join(lines) + "\n"


def timer(job: Job) -> str:
    if job.interval_s:
        when = ["OnBootSec=2min", f"OnUnitActiveSec={job.interval_s}s"]
    else:
        assert job.et, f"{job.name} has no systemd schedule (Job.et)"
        when = [f"OnCalendar={job.et} America/New_York"]
    return "\n".join([
        "[Unit]",
        f"Description=Start Trading Lab {job.name}",
        "",
        "[Timer]",
        *when,
        "AccuracySec=1s",
        "Persistent=false",
        f"Unit=wt-{job.name}.service",
        "",
        "[Install]",
        "WantedBy=timers.target",
    ]) + "\n"


def render_all(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for job in JOBS.values():
        out[f"wt-{job.name}.service"] = service(job, root)
        out[f"wt-{job.name}.timer"] = timer(job)
    return out


def diff(rendered: dict[str, str], unit_dir: Path = UNIT_DIR) -> list[str]:
    out = []
    for name, text in sorted(rendered.items()):
        p = unit_dir / name
        if not p.exists():
            out.append(f"{name}: not installed")
        elif p.read_text() != text:
            out.append(f"{name}: differs from the code")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m wt.ops.units")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--root", type=Path, default=Path.cwd())
    d = sub.add_parser("diff")
    d.add_argument("--root", type=Path, default=Path.cwd())
    d.add_argument("--unit-dir", type=Path, default=UNIT_DIR)
    a = ap.parse_args(argv)
    units = render_all(a.root if a.root.is_absolute() else a.root.resolve())   # keep /home as given
    if a.cmd == "render":
        a.out.mkdir(parents=True, exist_ok=True)
        for name, text in units.items():
            (a.out / name).write_text(text)
        print(f"rendered {len(units)} units into {a.out}")
        return 0
    changes = diff(units, a.unit_dir)
    print("\n".join(changes) if changes else "systemd units match the code")
    return 1 if changes else 0


if __name__ == "__main__":
    sys.exit(main())
