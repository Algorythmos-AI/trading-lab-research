"""Checks every nightly job runs before it does anything ("deploy what's reviewed", plan PR 2).

A failed check is a *refusal*: the job alerts once and exits 0. launchd must not treat a refusal as a crash, and
KeepAlive must not turn it into a restart loop.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from wt.core.config import ROOT
from wt.ops import thresholds

CODE_PATHS = ("src", "scripts", "deploy", "config", "requirements.lock.txt", "pyproject.toml", "Makefile")
LEGACY_RUNTIME = ("research/forward/forward_trades.jsonl", "research/forward/routine")
MIN_FREE_GB = thresholds.DISK_FLOOR_GB
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
    free = thresholds.disk_free_gb(root)
    return Check("free disk", free >= min_free_gb, f"{free:.1f} GB free (floor {min_free_gb:.0f} GB)")


def check_env_mode(root: Path) -> Check:
    """The secrets file is private: ~/trading/.env on the Mac, WT_ENV_FILE (tmpfs, written at boot) on the VM."""
    env_file = os.environ.get("WT_ENV_FILE")
    p = Path(env_file) if env_file else root / ".env"
    if not p.exists():
        return Check(".env private", False, f"{p.name} missing")
    mode = p.stat().st_mode & 0o777
    if env_file and p.stat().st_size == 0:
        return Check(".env private", False, f"{p.name} is empty (secrets not fetched yet?)")
    return Check(".env private", mode & 0o077 == 0, f"mode {mode:o}")


def check_remote(root: Path) -> Check:
    """Every deploy starts with `git fetch origin main`. While the repository is public an anonymous HTTPS remote
    answers; once it is private only a registered deploy key (SSH remote) or a token can. Checked before it matters."""
    try:
        r = _git(root, "ls-remote", "--exit-code", "--heads", "origin", "main", timeout=30.0)
    except (OSError, subprocess.SubprocessError) as e:
        return Check("origin reachable", False, f"git ls-remote failed: {e.__class__.__name__}")
    if r.returncode == 0:
        return Check("origin reachable", True, "origin answers for main")
    why = ((r.stderr or r.stdout).strip().splitlines() or ["no answer"])[-1][:120]
    return Check("origin reachable", False, f"origin did not answer for main ({why}); register the deploy key and "
                                            "set origin to the SSH URL (docs/runbooks/gcp-host.md, going private)")


def check_paging(root: Path) -> Check:
    """On the VM nothing else would tell the owner a job failed: the ntfy topic must be configured."""
    ok = bool(os.environ.get("NTFY_TOPIC"))
    return Check("paging configured", ok, "ntfy topic set" if ok else "NTFY_TOPIC is empty: alerts would be silent")


def current_kind() -> str:
    from wt.ops.host import current
    return current().kind


def run_checks(root: Path | None = None, min_free_gb: float = MIN_FREE_GB, remote: bool = False) -> list[Check]:
    """`remote` adds the origin check. It is off for a job's own preflight on purpose: a trading job needs no
    GitHub, and an outage or a slow SSH handshake at 09:25 ET must not refuse the paper runner."""
    root = root or ROOT
    checks = [*check_git(root), check_legacy_state(root), check_venv(root), check_disk(root, min_free_gb),
              check_env_mode(root)]
    if current_kind() == "systemd":
        checks.append(check_paging(root))
        if remote:
            checks.append(check_remote(root))
    return checks


# Every check's name: the only words of a check a page may carry (a detail can hold a branch name, a path or an
# error's text). tests/unit/test_alert_allowlist.py keeps every Check(...) above inside it.
CHECK_NAMES = frozenset({"on main", "reviewed commit", "clean code", "git", "runtime state migrated",
                         "venv matches lockfile", "free disk", ".env private", "origin reachable", "paging configured"})


def page_reason(fails: list[Check]) -> str:
    """A refusal's page: the failed checks by name. The details stay in the job's log."""
    names = sorted({c.name if c.name in CHECK_NAMES else "a check" for c in fails})
    return f"Preflight failed: {', '.join(names) or 'a check'}. The job's log has the detail."


def failures(checks: list[Check]) -> list[Check]:
    return [c for c in checks if not c.ok]


def main(argv: list[str] | None = None) -> int:
    """`python -m wt.ops.preflight`: the host's checks, with the origin check (`make preflight`, `wt-deploy preflight`)."""
    checks = run_checks(remote=True)
    for c in checks:
        print(f"  [{'ok' if c.ok else 'FAIL'}] {c.name}: {c.detail}")
    return 0 if not failures(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
