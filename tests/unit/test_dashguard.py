"""Dashboard before publisher (wt.ops.dashguard): a deploy needs a live dashboard at least as new as the
dashboard/contract code it brings. Ancestry, not equality, so later workflow-only commits and redeploys pass."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from wt.ops import dashguard

WORKFLOW = """name: dashboard
on:
  push:
    branches: [main]
    paths: ["dashboard/**", ".github/workflows/dashboard.yml", "src/wt/ops/publish.py"]
"""


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()


def commit(root: Path, path: str, text: str) -> str:
    f = root / path
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)
    git(root, "add", "-A")
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", path)
    return git(root, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    c = {"wf": commit(tmp_path, ".github/workflows/dashboard.yml", WORKFLOW)}
    c["dash1"] = commit(tmp_path, "dashboard/a.ts", "1")
    c["py"] = commit(tmp_path, "src/wt/ops/other.py", "x")           # not a dashboard path
    c["pub"] = commit(tmp_path, "src/wt/ops/publish.py", "v2")        # the contract changes here
    c["wf2"] = commit(tmp_path, ".github/workflows/dashboard.yml", WORKFLOW + "# tweak\n")  # workflow only
    c["py2"] = commit(tmp_path, "src/wt/ops/other.py", "y")
    git(tmp_path, "update-ref", "refs/remotes/origin/main", c["py2"])
    return tmp_path, c


def test_workflow_paths_parse_the_real_workflow():
    real = (Path(__file__).resolve().parents[2] / dashguard.WORKFLOW).read_text()
    paths = dashguard.workflow_paths(real)
    assert "dashboard/**" in paths and "src/wt/ops/publish.py" in paths


def test_a_current_dashboard_passes(repo):
    root, c = repo
    assert dashguard.check(root, c["py2"], c["wf2"][:12]) is None
    assert dashguard.check(root, c["py2"], c["py2"][:12]) is None     # a newer redeploy is still fine


def test_a_dashboard_behind_the_contract_refuses(repo):
    root, c = repo
    why = dashguard.check(root, c["py2"], c["py"][:12])               # live predates the publish.py change
    assert why and "dashboard is behind" in why and c["wf2"][:12] in why


def test_a_workflow_only_commit_counts_as_dashboard_code(repo):
    root, c = repo
    assert dashguard.check(root, c["py2"], c["pub"][:12])              # wf2 (workflow only) isn't live yet
    assert dashguard.check(root, c["pub"], c["pub"][:12]) is None      # target before wf2: current


@pytest.mark.parametrize("live", [None, "dev", "", "not-a-sha"])
def test_an_unknown_version_refuses(repo, live):
    root, c = repo
    assert "can't be shown to be current" in (dashguard.check(root, c["py2"], live) or "")


def test_a_live_version_off_main_refuses(repo):
    root, c = repo
    git(root, "checkout", "-q", "-b", "side", c["dash1"])
    side = commit(root, "dashboard/b.ts", "side")
    assert "not on origin/main" in (dashguard.check(root, c["py2"], side[:12]) or "")


def test_the_owner_override_is_recorded(repo, monkeypatch):
    root, c = repo
    monkeypatch.setattr(dashguard, "live_version", lambda url, bypass: "dev")
    assert dashguard.guard(root, c["py2"])[0] is False
    monkeypatch.setenv(dashguard.OVERRIDE_ENV, "dashboard deploy pending; publisher change is additive only")
    ok, why, override = dashguard.guard(root, c["py2"])
    assert ok and why and override.startswith("dashboard deploy pending")


def test_live_version_reads_health_with_the_bypass_header(monkeypatch):
    seen = {}

    class R:
        ok = True

        def json(self):
            return {"version": "abc123def456"}

    def get(url, headers, timeout):
        seen.update(url=url, headers=headers)
        return R()
    monkeypatch.setattr(dashguard.requests, "get", get)
    assert dashguard.live_version("https://lab.example/api/ingest", "b") == "abc123def456"
    assert seen == {"url": "https://lab.example/api/health", "headers": {"x-vercel-protection-bypass": "b"}}
    assert dashguard.live_version(None, "b") is None
