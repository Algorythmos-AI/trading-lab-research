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
