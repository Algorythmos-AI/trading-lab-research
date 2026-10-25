"""Is a commit green? The required GitHub checks of one commit, read from the public API (plan v7 B2).

    python -m wt.ops.ci <sha>          # prints each required check's conclusion; exit 0 only when all succeeded

A deploy (wt.ops.deploy) takes only a commit on main whose required checks all concluded "success" on that exact
commit. Pending, cancelled, skipped, failed or missing count as not green. When a check was re-run, its newest run
decides. Required names come from WT_REQUIRED_CHECKS (comma-separated; default "test").

Auth: GH_TOKEN or GITHUB_TOKEN when set (a read-only token; the repository may be private), else the `gh` CLI's
token when it is logged in (the Mac), else unauthenticated (a public repository, 60 requests an hour per IP).

A fine-grained personal access token cannot be given the "Checks" permission (GitHub keeps it for GitHub Apps), so
on a private repository the check-runs endpoint answers 403 to it. The same results are then read from the Actions
API (`Actions: read`): the commit's workflow runs and their jobs, whose names are the check names. Fails closed.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

import requests

from wt.core.config import ROOT

API = "https://api.github.com"
DEFAULT_REQUIRED = ("test",)         # the ml job left with the crypto desk's code (DEC-0036)


@dataclass(frozen=True)
class Verdict:
    green: bool
    detail: str
    checks: dict[str, str]


def required_names() -> tuple[str, ...]:
    raw = os.environ.get("WT_REQUIRED_CHECKS", "")
    names = tuple(n.strip() for n in raw.split(",") if n.strip())
    return names or DEFAULT_REQUIRED


def repo_slug(remote_url: str | None = None) -> str:
    """owner/name of origin, from an https or ssh remote URL."""
    url = remote_url
    if url is None:
        url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True,
                             timeout=10).stdout.strip()
    m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", url)
    if not m:
        raise ValueError(f"origin is not a GitHub repository: {url!r}")
    return m.group(1)


def token() -> str | None:
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        if v := os.environ.get(name, "").strip():
            return v
    gh = shutil.which("gh")
    if gh:
        try:
            r = subprocess.run([gh, "auth", "token"], capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


def conclusions(runs: list[dict[str, Any]]) -> dict[str, str]:
    """Check name -> the newest run's conclusion ("pending" while it hasn't completed)."""
    newest: dict[str, dict[str, Any]] = {}
    for r in runs:
        name = str(r.get("name", ""))
        if name not in newest or int(r.get("id", 0)) > int(newest[name].get("id", 0)):
            newest[name] = r
    return {n: (str(r.get("conclusion")) if r.get("status") == "completed" else "pending") for n, r in newest.items()}


def verdict(runs: list[dict[str, Any]], required: tuple[str, ...]) -> Verdict:
    got = conclusions(runs)
    per = {n: got.get(n, "missing") for n in required}
    bad = {n: c for n, c in per.items() if c != "success"}
    detail = "all required checks succeeded" if not bad else "; ".join(f"{n}: {c}" for n, c in bad.items())
    return Verdict(not bad, detail, per)


def _pages(session: Any, url: str | None, headers: dict[str, str], key: str) -> tuple[int, list[dict[str, Any]]]:
    """Every item of a paged list endpoint, or (the first non-200 status, [])."""
    out: list[dict[str, Any]] = []
    while url:
        r = session.get(url, headers=headers, timeout=20)
        if r.status_code != 200:
            return r.status_code, []
        out += list(r.json().get(key, []))
        url = r.links.get("next", {}).get("url") if hasattr(r, "links") else None
    return 200, out


def _jobs_of_runs(sha: str, slug: str, headers: dict[str, str], session: Any) -> tuple[int, list[dict[str, Any]]]:
    """The jobs of every workflow run on `sha`, shaped like check runs (id, name, status, conclusion)."""
    code, runs = _pages(session, f"{API}/repos/{slug}/actions/runs?head_sha={sha}&per_page=100", headers,
                        "workflow_runs")
    if code != 200:
        return code, []
    jobs: list[dict[str, Any]] = []
    for run in runs:
        code, got = _pages(session, f"{API}/repos/{slug}/actions/runs/{run.get('id')}/jobs?filter=latest&per_page=100",
                           headers, "jobs")
        if code != 200:
            return code, []
        jobs += got
    return 200, jobs


def check(sha: str, required: tuple[str, ...] | None = None, slug: str | None = None,
          session: Any = requests) -> Verdict:
    """The required checks of `sha`. Any API failure is "not green" (fails closed)."""
    required = required or required_names()
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if tok := token():
        headers["Authorization"] = f"Bearer {tok}"
    slug = slug or repo_slug()
    try:
        code, runs = _pages(session, f"{API}/repos/{slug}/commits/{sha}/check-runs?per_page=100", headers,
                            "check_runs")
        if code in (403, 404) and "Authorization" in headers:
            # a fine-grained token cannot hold "Checks": read the same jobs through the Actions API
            code2, runs = _jobs_of_runs(sha, slug, headers, session)
            if code2 != 200:
                return Verdict(False, f"GitHub API answered HTTP {code} (checks) and {code2} (actions)", {})
        elif code != 200:
            return Verdict(False, f"GitHub API answered HTTP {code}", {})
    except (requests.RequestException, ValueError) as e:
        return Verdict(False, f"GitHub API unreachable ({e.__class__.__name__})", {})
    return verdict(runs, required)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m wt.ops.ci <sha>", file=sys.stderr)
        return 2
    v = check(args[0])
    for n, c in v.checks.items():
        print(f"  {n}: {c}")
    print(("GREEN: " if v.green else "NOT GREEN: ") + v.detail)
    return 0 if v.green else 1


if __name__ == "__main__":
    sys.exit(main())
