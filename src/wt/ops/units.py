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
  * Restart=on-failure with RestartSec=60 and at most 3 starts in 6 h, so a crash loop can't burn through. Only
    the clock-time jobs get that limit: systemd counts every start, so on the 15-minute publisher it refused all
    but 3 starts in 6 h. An interval job never restarts, so it has no loop to bound (StartLimitIntervalSec=0).
  * KillMode=mixed + TimeoutStopSec=60: SIGTERM reaches the job runner, which forwards it to the job, waits,
    writes its heartbeat and pages (wt.ops.jobs); systemd kills the rest after 60 s.
  * OnFailure pages through wt-alert@, which doesn't depend on the secrets unit.
  * Timers fire in America/New_York (`Job.et`), AccuracySec=1s, Persistent=false: a missed start is not replayed
    after a reboot; wt-boot-reconcile starts paper-b and forward if the boot falls inside their windows.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from wt.ops.schedule import JOBS, PY, Job

UNIT_DIR = Path("/etc/systemd/system")
SECRETS_FILE = "/run/wt-secrets/env"
USER = "wt"
HELPER_DIR = Path("deploy/oci/bin")           # installed to /usr/local/bin by wt-install-units
STATIC_DIR = Path("deploy/oci/systemd")       # installed to /etc/systemd/system by wt-install-units

# cgroup memory per job on the 4 GB VM (e2-medium): (MemoryHigh, MemoryMax, MemorySwapMax). The heavy jobs throttle at
# High and are killed at Max rather than pushing the paper runner, which runs at the same time, into the OOM killer.
# The tail loader keeps them near 1 GB, so these are fuses, not budgets. The publisher's limit covers its collector
# child too. The runner itself is never capped (OOMScoreAdjust=-500 instead): killing it mid-session is the worst
# outcome.
MEMORY: dict[str, tuple[str | None, str, str | None]] = {
    "routine": ("1536M", "2G", "512M"),
    "forward": ("1536M", "2G", "512M"),
    "weekly": ("1536M", "2G", "512M"),
    "dashboard": (None, "1G", "256M"),
    "options-live": (None, "512M", "128M"),
    "crypto": (None, "512M", "128M"),
    "dashboard-crypto": (None, "512M", "128M"),
    "crypto-challengers": ("1G", "1536M", "256M"),
    "crypto-learn": ("1536M", "2G", "512M"),
}


def service(job: Job, root: Path, user: str = USER) -> str:
    restart = "on-failure" if job.trading else "no"            # the dashboard just runs again in 15 minutes
    lines = [
        "[Unit]",
        f"Description=Trading Lab {job.name}: {job.what}",
        # time-sync.target (with chrony-wait enabled): a job never starts on an unsynced clock
        "Wants=wt-secrets.service network-online.target time-sync.target",
        "After=wt-secrets.service network-online.target time-sync.target",
        "OnFailure=wt-alert@%n.service",
        # the limit counts timer starts too, so an interval job must not have one
        *(["StartLimitIntervalSec=0"] if job.interval_s else ["StartLimitIntervalSec=6h", "StartLimitBurst=3"]),
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
    if job.name in MEMORY:
        high, cap, swap = MEMORY[job.name]
        lines += [f"MemoryHigh={high}"] if high else []
        lines += [f"MemoryMax={cap}"] + ([f"MemorySwapMax={swap}"] if swap else [])
    return "\n".join(lines) + "\n"


def timer(job: Job) -> str:
    if job.calendars:
        assert job.interval_s, f"{job.name}: a calendar job also states its interval"
        when = [f"OnCalendar={c}" for c in job.calendars]
    elif job.calendar:
        assert job.interval_s, f"{job.name}: a calendar job also states its interval"
        when = [f"OnCalendar={job.calendar} UTC"]
    elif job.interval_s:
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


def installed_files(root: Path, install_root: Path | None = None) -> dict[str, bytes]:
    """Everything wt-install-units puts outside the repo, by install path: the rendered job units, the static units
    and the helpers, read from the checkout at `root`. Their fingerprint tells an unattended deploy whether a release
    needs the owner (the units or a helper changed) or can go in as code only. `install_root`: the checkout path the
    units point at (default `root`); a candidate commit checked out elsewhere is rendered for the live checkout."""
    out = {f"/etc/systemd/system/{n}": t.encode() for n, t in render_all(install_root or root).items()}
    for f in sorted((root / STATIC_DIR).iterdir()):
        if f.is_file():
            out[f"/etc/systemd/system/{f.name}"] = f.read_bytes()
    for f in sorted((root / HELPER_DIR).iterdir()):
        if f.is_file():
            out[f"/usr/local/bin/{f.name}"] = f.read_bytes()
    return out


def fingerprint(root: Path, install_root: Path | None = None) -> str:
    """One line per installed file ("<sha256>  <path>"), sorted: the same text for the same install."""
    return "".join(f"{hashlib.sha256(b).hexdigest()}  {p}\n"
                   for p, b in sorted(installed_files(root, install_root).items()))


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
    f = sub.add_parser("fingerprint", help="print what wt-install-units would install, hashed")
    f.add_argument("--root", type=Path, default=Path.cwd())
    f.add_argument("--install-root", type=Path, help="the checkout the units run from (default: --root)")
    a = ap.parse_args(argv)
    root = a.root if a.root.is_absolute() else a.root.resolve()               # keep /home as given
    if a.cmd == "fingerprint":
        sys.stdout.write(fingerprint(root, a.install_root))
        return 0
    units = render_all(root)
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
