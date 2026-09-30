"""Dashboard before publisher: refuse to deploy a publisher the live dashboard may not accept.

The publisher (this repo's src/wt/ops/publish.py) and the dashboard (dashboard/, deployed to Vercel by
.github/workflows/dashboard.yml on every push to main) change together. The dashboard's ingest rejects snapshot
fields it doesn't know, so the dashboard must be at least as new as the publisher being deployed.

The rule, for a deploy of `target` (a commit on origin/main):
  * the live dashboard reports its build commit at /api/health (`version`, the first 12 hex digits);
  * that commit must be on origin/main (nothing unreviewed is live);
  * the last commit at or before `target` that touched any contract path (deploy/contract-paths.txt at the target;
    older commits without it: the workflow's `on.push.paths`) must be an ancestor of (or equal to) the live commit.
Ancestry, not equality: a later commit that only touched the workflow, a manual redeploy or a redeploy after an
env change all leave a newer, still-valid version live.

An owner override (WT_DASHBOARD_GUARD_OVERRIDE="reason") lets a deploy through; the reason is recorded.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

import requests
import yaml

from wt.core.config import ROOT

WORKFLOW = ".github/workflows/dashboard.yml"
CONTRACT_PATHS = "deploy/contract-paths.txt"
OVERRIDE_ENV = "WT_DASHBOARD_GUARD_OVERRIDE"


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=60)


def workflow_paths(text: str) -> list[str]:
    """The `on.push.paths` of the dashboard workflow (YAML 1.1 reads the `on:` key as True)."""
    data: Any = yaml.safe_load(text) or {}
    on = data.get("on", data.get(True)) or {}
    paths = ((on.get("push") or {}).get("paths")) or []
    return [str(p) for p in paths]


def contract_paths(text: str) -> list[str]:
    """deploy/contract-paths.txt: one glob per line; blank lines and # comments ignored."""
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def paths_at(root: Path, target: str) -> list[str]:
    """The contract paths as of `target` (the shared file, else the older workflow's push filter)."""
    shown = _git(root, "show", f"{target}:{CONTRACT_PATHS}")
    if shown.returncode == 0:
        return contract_paths(shown.stdout)
    shown = _git(root, "show", f"{target}:{WORKFLOW}")
    return workflow_paths(shown.stdout) if shown.returncode == 0 else []


def last_dashboard_commit(root: Path, target: str) -> str | None:
    """The newest commit at or before `target` that touched a contract path (as of the target)."""
    paths = paths_at(root, target)
    if not paths:
        return None
    r = _git(root, "log", "-1", "--format=%H", target, "--", *[f":(glob){p}" for p in paths])
    return r.stdout.strip() or None


def _is_ancestor(root: Path, a: str, b: str) -> bool:
    return _git(root, "merge-base", "--is-ancestor", a, b).returncode == 0


def check(root: Path, target: str, live_version: str | None) -> str | None:
    """None when the deploy may proceed, else the reason it may not."""
    if not live_version or not re.fullmatch(r"[0-9a-f]{7,40}", live_version):
        return (f"the live dashboard reports version {live_version!r}, not a commit: it can't be shown to be "
                "current (deploy it from main first)")
    full = _git(root, "rev-parse", "--verify", "--quiet", f"{live_version}^{{commit}}").stdout.strip()
    if not full:
        return f"the live dashboard version {live_version} is not a commit in this repository (fetch first?)"
    if not _is_ancestor(root, full, "origin/main"):
        return f"the live dashboard version {live_version} is not on origin/main"
    last = last_dashboard_commit(root, target)
    if last and not _is_ancestor(root, last, full):
        return (f"the dashboard is behind: commit {last[:12]} (dashboard/contract change at or before the deploy "
                f"target) is not live yet; live is {full[:12]}")
    return None


def live_version(ingest_url: str | None, bypass: str | None, timeout: float = 15.0) -> str | None:
    """`version` from the live dashboard's /api/health (behind Vercel Authentication: needs the bypass secret)."""
    if not ingest_url:
        return None
    url = re.sub(r"/api/ingest/?$", "/api/health", ingest_url)
    headers = {"x-vercel-protection-bypass": bypass} if bypass else {}
    try:
        r = requests.get(url, headers=headers, timeout=timeout)
        v = r.json().get("version") if r.ok else None
    except (requests.RequestException, ValueError, AttributeError):
        return None
    return str(v) if v else None


def guard(root: Path = ROOT, target: str = "origin/main") -> tuple[bool, str | None, str | None]:
    """(ok, reason, override). ok is True when the check passes, or fails but the owner overrode it."""
    why = check(root, target, live_version(os.environ.get("DASHBOARD_INGEST_URL"),
                                           os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")))
    if why is None:
        return True, None, None
    override = (os.environ.get(OVERRIDE_ENV) or "").strip()
    return (bool(override), why, override or None)
