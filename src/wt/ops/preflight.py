"""Checks every nightly job runs before it does anything ("deploy what's reviewed", plan PR 2).

A failed check is a *refusal*: the job alerts once and exits 0. launchd must not treat a refusal as a crash, and
KeepAlive must not turn it into a restart loop.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from wt.core.config import ROOT

CODE_PATHS = ("src", "scripts", "deploy", "config", "requirements.lock.txt", "pyproject.toml", "Makefile")
LEGACY_RUNTIME = ("research/forward/forward_trades.jsonl", "research/forward/routine")
MIN_FREE_GB = 3.0
LOCK_STAMP = ".venv/.wt-lock.sha256"


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str = ""


def _git(root: Path, *args: str, timeout: float = 20.0) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=timeout, env=env,
                          stdin=subprocess.DEVNULL)


def lock_hash(root: Path) -> str:
    return hashlib.sha256((root / "requirements.lock.txt").read_bytes()).hexdigest()


def check_git(root: Path) -> list[Check]:
    out = []
    try:
        branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        out.append(Check("on main", branch == "main", f"HEAD is on {branch!r}"))
        anc = _git(root, "merge-base", "--is-ancestor", "HEAD", "origin/main").returncode
        out.append(Check("reviewed commit", anc == 0,
                         "HEAD is in origin/main" if anc == 0 else "HEAD has commits that are not on origin/main"))
        dirty = _git(root, "status", "--porcelain", "--untracked-files=all", "--", *CODE_PATHS).stdout.strip()
        n = len(dirty.splitlines()) if dirty else 0
        out.append(Check("clean code", n == 0, "no changes under code paths" if n == 0 else
                         f"{n} modified or untracked file(s) under {', '.join(CODE_PATHS[:4])}, …"))
    except (OSError, subprocess.SubprocessError) as e:
        out.append(Check("git", False, f"git unavailable: {e.__class__.__name__}"))
    return out


def check_legacy_state(root: Path) -> Check:
    left = [p for p in LEGACY_RUNTIME if (root / p).exists()]
    return Check("runtime state migrated", not left,
                 "no runtime files in tracked paths" if not left else f"run `make migrate-state` ({', '.join(left)})")


def check_venv(root: Path) -> Check:
    stamp = root / LOCK_STAMP
    try:
        ok = stamp.read_text().strip() == lock_hash(root)
    except OSError:
        return Check("venv matches lockfile", False, "no sync stamp; run `make deploy`")
    return Check("venv matches lockfile", ok, "synced" if ok else "requirements.lock.txt changed since the last sync")


def check_disk(root: Path, min_free_gb: float = MIN_FREE_GB) -> Check:
    free = shutil.disk_usage(root).free / 1e9
    return Check("free disk", free >= min_free_gb, f"{free:.1f} GB free (floor {min_free_gb:.0f} GB)")


def check_env_mode(root: Path) -> Check:
    p = root / ".env"
    if not p.exists():
        return Check(".env private", False, ".env missing")
    mode = p.stat().st_mode & 0o777
    return Check(".env private", mode & 0o077 == 0, f"mode {mode:o}")


def run_checks(root: Path | None = None, min_free_gb: float = MIN_FREE_GB) -> list[Check]:
    root = root or ROOT
    return [*check_git(root), check_legacy_state(root), check_venv(root), check_disk(root, min_free_gb),
            check_env_mode(root)]


def failures(checks: list[Check]) -> list[Check]:
    return [c for c in checks if not c.ok]
