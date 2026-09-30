"""Rules for .github/workflows that actionlint does not check, learned the hard way.

A workflow path that has never run is untested code. The dashboard deploy job failed the first time it ran
(2026-09-29) because its first step ran before checkout inside the `dashboard/` default working directory,
which does not exist until the checkout. These tests keep that class of failure out of every workflow:

  * no `run` step before the first checkout runs in a repository subdirectory;
  * every action is pinned to a full commit SHA;
  * every repository path a workflow names exists;
  * every job has a timeout;
  * the required `test` check never gets path filters (a required check that doesn't run blocks merges).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
SHA = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
PATH_KEYS = ("working-directory", "package_json_file", "cache-dependency-path")


def load(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load(path.read_text())
    if True in data:                          # YAML 1.1 reads the `on:` key as boolean True
        data["on"] = data.pop(True)
    return data


def jobs(wf: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    return list((wf.get("jobs") or {}).items())


def default_wd(wf: dict[str, Any], job: dict[str, Any]) -> str | None:
    for scope in (job, wf):
        wd = ((scope.get("defaults") or {}).get("run") or {}).get("working-directory")
        if wd:
            return str(wd)
    return None


def is_checkout(step: dict[str, Any]) -> bool:
    return str(step.get("uses", "")).startswith("actions/checkout@")


def test_there_are_workflows():
    assert WORKFLOWS, "no workflows found"


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_no_step_runs_in_a_repo_directory_before_checkout(path):
    wf = load(path)
    for name, job in jobs(wf):
        if "uses" in job:                     # a reusable workflow call has no steps here
            continue
        default = default_wd(wf, job)
        for i, step in enumerate(job.get("steps") or []):
            if is_checkout(step):
                break
            if "run" not in step:
                continue
            wd = str(step.get("working-directory", default) or ".")
            assert wd in (".", "./", "${{ github.workspace }}"), (
                f"{path.name}: job {name!r} step {i} ({step.get('name', 'unnamed')!r}) runs in {wd!r} before "
                "actions/checkout, where that directory does not exist yet: set `working-directory: .`")


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_every_action_is_pinned_to_a_commit_sha(path):
    wf = load(path)
    for name, job in jobs(wf):
        refs = [job["uses"]] if "uses" in job else [s["uses"] for s in job.get("steps") or [] if "uses" in s]
        for ref in refs:
            if str(ref).startswith("./"):
                continue                      # a local action or workflow in this repository
            assert SHA.match(str(ref)), f"{path.name}: job {name!r} uses {ref!r}, not pinned to a full SHA"


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_every_repository_path_a_workflow_names_exists(path):
    wf = load(path)
    named: list[str] = []
    for _, job in jobs(wf):
        if d := default_wd(wf, job):
            named.append(d)
        for step in job.get("steps") or []:
            named += [str(step[k]) for k in PATH_KEYS if k in step]
            named += [str(v) for k, v in (step.get("with") or {}).items() if k in PATH_KEYS]
    for p in named:
        if "${{" in p or p in (".", "./"):
            continue
        assert (ROOT / p).exists(), f"{path.name} names {p!r}, which does not exist in the repository"


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_every_job_has_a_timeout(path):
    for name, job in jobs(load(path)):
        if "uses" in job:
            continue
        assert "timeout-minutes" in job, f"{path.name}: job {name!r} has no timeout-minutes"


def test_the_required_check_always_runs():
    wf = load(ROOT / ".github" / "workflows" / "ci.yml")
    on = wf["on"]
    for event in ("pull_request", "push"):
        cfg = on.get(event) or {}
        assert not {"paths", "paths-ignore"} & set(cfg), f"ci.yml {event} must not be path-filtered"
    assert (wf["jobs"].get("test") or {}).get("name") == "test", "the required check's job name must stay `test`"


def test_the_guard_catches_the_bug_it_was_written_for(tmp_path):
    """The exact shape that failed on 2026-09-29 must fail this check."""
    bad = {"defaults": {"run": {"working-directory": "dashboard"}},
           "jobs": {"deploy": {"steps": [{"name": "gate", "run": "true"}, {"uses": "actions/checkout@" + "a" * 40}]}}}
    wf = tmp_path / "bad.yml"
    wf.write_text(yaml.safe_dump(bad))
    with pytest.raises(AssertionError, match="before actions/checkout"):
        test_no_step_runs_in_a_repo_directory_before_checkout(wf)


# ---- secrets in a public repository (2026-09-29: the repo is public by owner decision; see SECURITY.md) ----------

SECRET_REF = re.compile(r"\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]+")


def _secret_refs(obj: Any) -> bool:
    return bool(SECRET_REF.search(yaml.safe_dump(obj))) if obj is not None else False


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_secrets_are_only_read_behind_an_environment_and_only_at_step_level(path):
    wf = load(path)
    assert not _secret_refs(wf.get("env")), f"{path.name}: workflow-level env must not read secrets"
    for name, job in jobs(wf):
        if "uses" in job:
            continue
        steps = job.get("steps") or []
        reads = any(_secret_refs(s) for s in steps) or _secret_refs(job.get("env"))
        if not reads:
            continue
        assert job.get("environment"), f"{path.name}: job {name!r} reads secrets without an Environment"
        assert not _secret_refs(job.get("env")), f"{path.name}: job {name!r} exposes secrets job-wide"


def test_the_production_deploy_runs_only_from_main_and_never_for_pull_requests():
    wf = load(ROOT / ".github" / "workflows" / "dashboard.yml")
    deploy = wf["jobs"]["deploy"]
    assert deploy.get("environment") == "production"
    cond = str(deploy.get("if", ""))
    assert "github.ref == 'refs/heads/main'" in cond and "pull_request" not in cond
    checkout = next(s for s in deploy["steps"] if is_checkout(s))
    assert (checkout.get("with") or {}).get("persist-credentials") is False
    names = [s.get("name", "") for s in deploy["steps"]]
    assert names[0] == "Require the deploy secrets"            # a missing token fails the job, never skips it
    assert names[-1] == "The live dashboard reports this commit"
    build = next(s for s in deploy["steps"] if str(s.get("name", "")).startswith("Build"))
    assert "VERCEL_TOKEN" not in yaml.safe_dump(build), "the build must run without the Vercel token"
    assert (build.get("env") or {}).get("BUILD_SHA") == "${{ github.sha }}"


def test_production_deploys_are_never_cancelled_half_way():
    wf = load(ROOT / ".github" / "workflows" / "dashboard.yml")
    assert wf["concurrency"]["cancel-in-progress"] == "${{ github.event_name == 'pull_request' }}"
