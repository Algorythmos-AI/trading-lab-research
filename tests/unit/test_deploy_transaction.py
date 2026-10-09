"""A deploy is one transaction on one exact commit (plan v7 B7): on main, green, a fast-forward; staged tests before
the switch; the switch under the deploy lock; a failed smoke test rolls back even if the gate has closed since.
Real git repositories in a temp dir; the gate, CI, dashboard guard, venv and smoke test are stubbed."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from wt.ops import ci, deploy, locks


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


def commit(repo: Path, name: str) -> str:
    (repo / name).write_text(name)
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", name)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def world(tmp_path, monkeypatch):
    origin, dev, live = tmp_path / "origin.git", tmp_path / "dev", tmp_path / "live"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(dev)], check=True, capture_output=True)
    git(dev, "checkout", "-q", "-b", "main")
    first = commit(dev, "a")
    git(dev, "push", "-q", "origin", "main")
    subprocess.run(["git", "clone", "-q", "-b", "main", str(origin), str(live)], check=True, capture_output=True)
    monkeypatch.setattr(deploy, "ROOT", live)
    monkeypatch.setattr(deploy, "DEPLOY_DIR", tmp_path / "records")
    monkeypatch.setattr(deploy, "STAGE_DIR", tmp_path / "stage")
    monkeypatch.setattr(locks, "LOCK_DIR", tmp_path / "locks")
    state = {"gate": [[]], "green": True, "smoke": True, "stage": (True, "ok"), "synced": 0, "alerts": []}

    def gate():
        return state["gate"].pop(0) if len(state["gate"]) > 1 else state["gate"][0]
    monkeypatch.setattr(deploy, "gate_blockers", lambda now=None: gate())
    monkeypatch.setattr(deploy.preflight, "check_git", lambda root: [])
    monkeypatch.setattr(deploy.preflight, "lock_hash", lambda root: "h")
    monkeypatch.setattr(deploy.ci, "check", lambda sha: ci.Verdict(state["green"], "stub", {"test": "success"}))
    monkeypatch.setattr(deploy.dashguard, "guard", lambda root, target: (True, "", ""))
    monkeypatch.setattr(deploy.migrate, "migrate", lambda: type("R", (), {"moved": [], "conflicts": []})())
    monkeypatch.setattr(deploy, "sync_venv", lambda: state.__setitem__("synced", state["synced"] + 1))
    monkeypatch.setattr(deploy, "smoke", lambda: (state["smoke"], "smoke output"))
    monkeypatch.setattr(deploy, "stage_tests", lambda target: state["stage"])

    class A:
        def fire(self, key, title, msg, prio=4):
            state["alerts"].append(title)

        def resolve(self, *a, **k):
            pass
    monkeypatch.setattr(deploy, "Alerts", A)
    return dev, live, first, state


def head(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD")


def test_deploys_exactly_the_checked_commit_not_the_newer_tip(world):
    dev, live, first, st = world
    second = commit(dev, "b")
    commit(dev, "c")                                            # main moves on after the check
    git(dev, "push", "-q", "origin", "main")
    assert deploy.deploy(second) == 0
    assert head(live) == second
    assert any(t.startswith("runtime-") for t in git(live, "tag").split())


def test_refuses_a_red_commit_a_branch_commit_and_going_backwards(world, capsys):
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    st["green"] = False
    assert deploy.deploy(second) == 2 and head(live) == first
    st["green"] = True
    git(dev, "checkout", "-q", "-b", "side")
    side = commit(dev, "s")
    git(dev, "push", "-q", "origin", "side")
    git(live, "fetch", "-q", "origin", "side")
    assert deploy.deploy(side) == 2 and head(live) == first
    assert "not on main" in capsys.readouterr().out
    assert deploy.deploy(second) == 0 and head(live) == second
    assert deploy.deploy(first) == 2 and head(live) == second      # backwards is rollback's job
    assert deploy.deploy(second) == 0                               # already there: nothing to do


def test_a_red_staged_suite_changes_nothing(world):
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    st["stage"] = (False, "1 failed")
    assert deploy.deploy(second, stage=True) == 1
    assert head(live) == first and st["synced"] == 0
    assert "Deploy refused: tests failed" in st["alerts"]


def test_a_failed_smoke_test_rolls_back_even_when_the_gate_has_closed(world):
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    st["smoke"] = False
    st["gate"] = [[], [], ["a job starts soon"]]                  # open, open (under the lock), then closed
    assert deploy.deploy(second) == 1
    assert head(live) == first and st["synced"] == 2              # synced forward, then back
    assert "Deploy rolled back" in st["alerts"]


def test_the_gate_is_asked_again_under_the_lock(world):
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    st["gate"] = [[], ["routine starts in 40 min"]]               # closed while staging ran
    assert deploy.deploy(second, stage=True) == 2 and head(live) == first


def test_a_second_deploy_does_not_stage_while_the_first_is_staging(world, capsys):
    """Staging clears its worktree before it starts: a second deploy of the same commit must not get that far while
    the first one's tests run in it. It is refused as busy, not as a failed suite: no alert, nothing changed."""
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    staged = []
    deploy_stage = deploy.stage_tests

    def never(target):
        staged.append(target)
        return deploy_stage(target)
    deploy.stage_tests = never
    try:
        with locks.job_lock(deploy.STAGE_LOCK):
            assert deploy.deploy(second, stage=True) == 2
        assert staged == [] and head(live) == first and st["alerts"] == [] and st["synced"] == 0
        assert "another deploy is testing" in capsys.readouterr().out
        assert not (deploy.DEPLOY_DIR).exists() or not list(deploy.DEPLOY_DIR.glob("*.json"))
        # the first one is done: the same command now goes through, and staging ran once
        assert deploy.deploy(second, stage=True) == 0 and head(live) == second and staged == [second]
    finally:
        deploy.stage_tests = deploy_stage


def test_the_staging_lock_is_released_before_the_switch_and_is_not_a_job_lock(world):
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    seen = {}
    real = deploy._switch

    def switch(*a, **k):
        seen["staging_held"] = locks.is_held(deploy.STAGE_LOCK)
        return real(*a, **k)
    deploy._switch = switch
    try:
        assert deploy.deploy(second, stage=True) == 0
    finally:
        deploy._switch = real
    assert seen == {"staging_held": False}
    from wt.ops.schedule import JOBS
    assert deploy.STAGE_LOCK not in JOBS and deploy.STAGE_LOCK not in (locks.DEPLOY_LOCK, deploy.ML_ENV_LOCK)


def test_one_deploy_at_a_time(world):
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    with locks.job_lock(locks.DEPLOY_LOCK):
        assert deploy.deploy(second) == 2
    assert head(live) == first


def test_stage_tests_runs_the_suite_in_a_throwaway_worktree(world, monkeypatch, tmp_path):
    dev, live, first, st = world
    monkeypatch.undo()                                          # only what stage_tests needs, below
    monkeypatch.setattr(deploy, "ROOT", live)
    monkeypatch.setattr(deploy, "STAGE_DIR", tmp_path / "stage")
    calls = []
    real_run = deploy._run

    def fake_run(*cmd, check=True, timeout=600):
        if cmd[0].endswith("uv") or "uv" == Path(cmd[0]).name:
            calls.append(cmd[:2])
            if cmd[1] == "venv":
                (Path(cmd[-1]) / "bin").mkdir(parents=True, exist_ok=True)
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return real_run(*cmd, check=check, timeout=timeout)
    monkeypatch.setattr(deploy, "_run", fake_run)
    seen = {}
    real_sub = subprocess.run

    def fake_sub(argv, **kw):
        if not str(argv[0]).endswith("/.venv/bin/python"):
            return real_sub(argv, **kw)                               # git
        seen.update(cwd=kw["cwd"], env=kw["env"], argv=argv)
        assert (Path(kw["cwd"]) / "a").exists()                       # the target's tree
        return subprocess.CompletedProcess(argv, 0, "3 passed", "")
    monkeypatch.setattr(deploy.subprocess, "run", fake_sub)
    monkeypatch.setenv("APCA_API_SECRET_KEY", "never-passed")
    ok, out = deploy.stage_tests(first)
    assert ok and "3 passed" in out
    assert "APCA_API_SECRET_KEY" not in seen["env"] and seen["env"]["PYTHONPATH"] == "src"
    assert not Path(seen["cwd"]).exists()                          # removed afterwards
    assert ("venv" in [c[1] for c in calls]) and ("pip" in [c[1] for c in calls])


def test_jobs_wait_for_a_running_deploy(monkeypatch, tmp_path):
    from wt.ops import jobs
    monkeypatch.setattr(locks, "LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr(jobs, "DEPLOY_WAIT_S", 0.0)
    refused = []
    monkeypatch.setattr(jobs, "refuse", lambda job, reason, alerts, log, hb=None, ping=True: refused.append(reason) or 0)
    monkeypatch.setattr(jobs, "Log", lambda root, job: (lambda msg: None))
    with locks.job_lock(locks.DEPLOY_LOCK):
        assert jobs.run_job(jobs.JOBS["weekly"], tmp_path, alerts=object()) == 0
    assert refused and "deploy" in refused[0]


def test_the_ml_environment_is_built_after_every_lock_a_job_waits_on_is_released_and_recorded(world, monkeypatch, tmp_path):
    dev, live, first, st = world
    second = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    seen = {}

    def sync_ml():
        seen["jobs"] = locks.held([j.name for j in deploy.JOBS.values()])
        seen["deploy"] = locks.is_held(locks.DEPLOY_LOCK)
        seen["head"] = head(live)
        return "synced"
    monkeypatch.setattr(deploy, "sync_ml", sync_ml)
    assert deploy.deploy(second) == 0
    # A long install holds nothing a job waits on: not a job's own lock, and not the deploy lock, which every
    # job waits for before it starts (wt.ops.jobs.run_job).
    assert seen == {"jobs": [], "deploy": False, "head": second}
    import json
    rec = sorted((tmp_path / "records").glob("*.json"))[-1]
    assert json.loads(rec.read_text())["ml_env"] == "synced"
    st["smoke"] = False
    seen.clear()
    third = commit(dev, "c")
    git(dev, "push", "-q", "origin", "main")
    assert deploy.deploy(third) == 1 and seen == {}             # rolled back: the ML environment is left alone
