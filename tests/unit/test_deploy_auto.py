"""The host deploys itself (ADR 0008): `wt.ops.deploy auto` on a real pair of git repositories, with the gate, CI,
the dashboard check, the tests and the smoke test stubbed as in test_deploy_transaction."""
from __future__ import annotations

import datetime as dt
import json
from types import SimpleNamespace

import pytest
from test_deploy_transaction import commit, git, head, world  # noqa: F401  (world is a fixture)

from wt.ops import ci, deploy
from wt.ops.schedule import JOBS

LATER = dt.datetime.now(dt.UTC) + dt.timedelta(hours=2)        # the test's commits are older than the settle time


class Phone:
    def __init__(self):
        self.said, self.daily = [], []

    def notify(self, title, message, priority=3, tags=()):
        self.said.append((title, message))
        return True

    def once_per_day(self, key, title, message, priority=3, day=None):
        first = (key, title) not in [(k, t) for k, t, _ in self.daily]
        self.daily.append((key, title, message))
        return first

    def fire(self, key, title, message, priority=4, tags=()):
        self.said.append((title, message))
        return True

    def resolve(self, *a, **k):
        return False


@pytest.fixture
def auto(world, monkeypatch, tmp_path):  # noqa: F811
    dev, live, first, state = world
    phone = Phone()
    monkeypatch.setattr(deploy, "Alerts", lambda: phone)
    monkeypatch.setattr(deploy.host, "current", lambda: SimpleNamespace(kind="systemd"))
    monkeypatch.setattr(deploy, "AUTO_STATE", tmp_path / "deploy-auto.json")
    monkeypatch.setattr(deploy, "held", lambda names: [])
    monkeypatch.setattr(deploy, "_note_ml", lambda rec: None)
    deploy.DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
    (deploy.DEPLOY_DIR / deploy.AUTO_ON).touch()                # the owner has switched it on
    monkeypatch.setattr(deploy.units, "diff", lambda rendered: [])
    monkeypatch.setattr(deploy.units, "render_all", lambda root: {})
    new = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    return SimpleNamespace(dev=dev, live=live, first=first, new=new, state=state, phone=phone)


def test_a_release_the_owner_could_deploy_goes_in_by_itself_and_the_owner_is_told(auto, capsys):
    assert deploy.auto(LATER) == 0
    assert head(auto.live) == auto.new
    (title, message), = auto.phone.said
    assert title == "Deployed automatically" and auto.first[:8] in message and auto.new[:8] in message
    assert "rollback" in message and deploy.AUTO_ON in message and "1 commit)" in message
    rec, = [json.loads(p.read_text()) for p in deploy.DEPLOY_DIR.glob("2*.json")]
    assert rec["by"] == "auto" and rec["staged"] is True and rec["to"] == auto.new       # the tests ran before the switch
    assert not deploy.AUTO_STATE.exists()                       # nothing to remember about a deploy that worked
    assert [p.name for p in deploy.DEPLOY_DIR.glob("*.json")] == [p.name for p in deploy.DEPLOY_DIR.glob("2*.json")]
    # Nothing left: the next run does nothing and says nothing.
    assert deploy.auto(LATER) == 0 and len(auto.phone.said) == 1
    assert "nothing to deploy (already at" in capsys.readouterr().out
    # The owner's own deploy is recorded as the owner's.
    commit(auto.dev, "c")
    git(auto.dev, "push", "-q", "origin", "main")
    for p in deploy.DEPLOY_DIR.glob("2*.json"):
        p.unlink()                                       # records are named to the second: keep the two apart
    assert deploy.deploy(None, stage=True) == 0
    assert [json.loads(p.read_text())["by"] for p in deploy.DEPLOY_DIR.glob("2*.json")] == ["owner"]


@pytest.mark.parametrize("why", ["off", "busy", "gate", "closing", "young", "red", "dashboard", "dirty"])
def test_what_would_stop_the_owner_stops_it_and_so_does_a_gate_about_to_close(auto, monkeypatch, capsys, why):
    now = LATER
    if why == "off":
        (deploy.DEPLOY_DIR / deploy.AUTO_ON).unlink()
    elif why == "busy":
        monkeypatch.setattr(deploy, "held", lambda names: ["crypto-learn"])
    elif why == "gate":
        auto.state["gate"] = [["wt-paper-b is running"]]
    elif why == "closing":                              # open now, closed within the hour: the tests could outlast it
        monkeypatch.setattr(deploy, "gate_blockers", lambda now=None: [] if now == LATER else ["com.wt.routine starts at 07:30 ET"])
    elif why == "young":
        now = dt.datetime.now(dt.UTC)
    elif why == "red":
        auto.state["green"] = False
    elif why == "dashboard":
        monkeypatch.setattr(deploy.dashguard, "guard", lambda root, target: (False, "the dashboard is older", ""))
    elif why == "dirty":
        monkeypatch.setattr(deploy.preflight, "check_git", lambda root: [SimpleNamespace(name="clean code", ok=False, detail="1 file changed")])
    assert deploy.auto(now) == 0
    assert head(auto.live) == auto.first and auto.phone.said == []
    assert not list(deploy.DEPLOY_DIR.glob("2*.json")) if deploy.DEPLOY_DIR.exists() else True
    out = capsys.readouterr().out
    assert out.startswith("auto deploy:")
    if why == "off":                                    # switched off is a dry run: it says what it would have done
        assert f"would deploy {auto.first[:12]} -> {auto.new[:12]}, 1 commit (dry" in out


def test_the_owners_overrides_are_never_read(auto, monkeypatch):
    auto.state["green"] = False
    monkeypatch.setenv(deploy.CI_OVERRIDE_ENV, "left in the shell by an earlier deploy")
    assert deploy.auto(LATER) == 0 and head(auto.live) == auto.first
    auto.state["green"] = True
    monkeypatch.setattr(deploy.dashguard, "guard", lambda root, target: (True, "the dashboard is older", "an override"))
    assert deploy.auto(LATER) == 0 and head(auto.live) == auto.first and auto.phone.said == []
    # The same environment, typed by the owner, deploys.
    auto.state["green"] = False
    assert deploy.deploy(None, stage=True) == 0 and head(auto.live) == auto.new


def test_a_release_that_needs_sudo_is_left_to_the_owner_who_is_told_once_a_day(auto, monkeypatch, capsys):
    (auto.dev / "src" / "wt" / "ops").mkdir(parents=True)
    (auto.dev / "src" / "wt" / "ops" / "schedule.py").write_text("# a new job\n")
    git(auto.dev, "add", "-A")
    git(auto.dev, "commit", "-q", "-m", "schedule")
    git(auto.dev, "push", "-q", "origin", "main")
    assert deploy.auto(LATER) == 0 and deploy.auto(LATER) == 0
    assert head(auto.live) == auto.first and auto.phone.said == []
    assert [t for _, t, _ in auto.phone.daily] == ["A deploy needs you"] * 2
    assert "wt-install-units" in auto.phone.daily[0][2] and "(1 file)" in auto.phone.daily[0][2]
    assert "already said today" in capsys.readouterr().out
    # A host whose installed units already differ from its code is not moved further either.
    git(auto.dev, "revert", "--no-edit", "HEAD")
    git(auto.dev, "push", "-q", "origin", "main")
    git(auto.live, "fetch", "-q", "origin", "main")
    assert deploy.needs_owner(auto.first, head(auto.dev)) is None            # the path is back as it was: nothing to install
    monkeypatch.setattr(deploy.units, "diff", lambda rendered: ["wt-x.timer: not installed"])
    assert "installed units differ" in deploy.needs_owner(auto.first, head(auto.dev))


def test_a_target_that_failed_here_is_tried_once_more_later_then_left_and_a_newer_one_is_taken(auto, capsys):
    auto.state["stage"] = (False, "1 failed")
    assert deploy.auto(LATER) == 0
    assert head(auto.live) == auto.first and auto.phone.said[0][0] == "Deploy refused: tests failed"
    assert json.loads(deploy.AUTO_STATE.read_text())["failed"] == auto.new
    assert deploy.auto(LATER + dt.timedelta(hours=1)) == 0 and len(auto.phone.said) == 1     # not run again within hours
    assert "one more try after 6 h" in capsys.readouterr().out
    assert deploy.auto(LATER + dt.timedelta(hours=7)) == 0 and len(auto.phone.said) == 2     # once more
    assert deploy.auto(LATER + dt.timedelta(hours=14)) == 0 and len(auto.phone.said) == 2    # then left alone
    assert "failed here 2 times" in capsys.readouterr().out
    # By then the release has waited: the owner is told, once a day, why.
    assert ("deploy-stuck", "A release has waited for hours") in [(k, title) for k, title, _ in auto.phone.daily]
    auto.state["stage"] = (True, "ok")
    newer = commit(auto.dev, "c")
    git(auto.dev, "push", "-q", "origin", "main")
    assert deploy.auto(LATER + dt.timedelta(hours=15)) == 0 and head(auto.live) == newer
    assert auto.phone.said[-1][0] == "Deployed automatically" and "2 commits" in auto.phone.said[-1][1]


def test_a_fault_after_the_fast_forward_takes_the_way_back_and_pages(auto, monkeypatch):
    def broken():
        raise RuntimeError("uv pip sync failed: network")
    calls = []
    monkeypatch.setattr(deploy, "sync_venv", lambda: (calls.append(1), broken())[1] if len(calls) == 0 else None)
    assert deploy.auto(LATER) == 0
    assert head(auto.live) == auto.first                         # back where it was, with its environment synced again
    assert [title for title, _ in auto.phone.said] == ["Deploy rolled back"]
    rec, = [json.loads(p.read_text()) for p in deploy.DEPLOY_DIR.glob("2*.json")]
    assert rec["rolled_back"] is True and rec["smoke_ok"] is False and rec["by"] == "auto"
    assert json.loads(deploy.AUTO_STATE.read_text())["failed"] == auto.new
    # The way back fails too: that is said at the highest priority, and nothing claims a deploy.
    deploy.AUTO_STATE.unlink()
    monkeypatch.setattr(deploy, "sync_venv", broken)
    assert deploy.auto(LATER) == 0
    assert auto.phone.said[-1][0] == "Host left between two releases" and "rollback runtime-" in auto.phone.said[-1][1]


def test_switching_it_off_or_slow_tests_stop_a_run_before_the_switch(auto, monkeypatch, capsys):
    def off_meanwhile(target, timeout_s=None):
        (deploy.DEPLOY_DIR / deploy.AUTO_ON).unlink()
        return True, "ok"
    monkeypatch.setattr(deploy, "stage_tests", off_meanwhile)
    assert deploy.auto(LATER) == 0 and head(auto.live) == auto.first and auto.phone.said == []
    assert "switched off while the tests ran" in capsys.readouterr().out
    (deploy.DEPLOY_DIR / deploy.AUTO_ON).touch()
    monkeypatch.setattr(deploy, "stage_tests", lambda target, timeout_s=None: (True, "ok"))
    monkeypatch.setattr(deploy, "AUTO_SWITCH_BY_S", -1.0)
    assert deploy.auto(LATER) == 0 and head(auto.live) == auto.first
    assert "took too long" in capsys.readouterr().out and not deploy.AUTO_STATE.exists()   # not a failure of the commit


def test_what_the_owner_rolled_back_is_not_put_back(auto, monkeypatch):
    assert deploy.auto(LATER) == 0 and head(auto.live) == auto.new
    tag = json.loads(next(deploy.DEPLOY_DIR.glob("2*.json")).read_text())["rollback_tag"]
    monkeypatch.setattr(deploy, "broker_cleanup_before_rollback", lambda: None)
    assert deploy.rollback(tag) == 0 and head(auto.live) == auto.first
    said = len(auto.phone.said)
    assert deploy.auto(LATER + dt.timedelta(hours=9)) == 0 and head(auto.live) == auto.first and len(auto.phone.said) == said
    newer = commit(auto.dev, "c")
    git(auto.dev, "push", "-q", "origin", "main")
    assert deploy.auto(LATER + dt.timedelta(hours=10)) == 0 and head(auto.live) == newer


def test_a_smoke_failure_rolls_back_and_nothing_says_it_deployed(auto):
    auto.state["smoke"] = False
    assert deploy.auto(LATER) == 0
    assert head(auto.live) == auto.first
    assert [t for t, _ in auto.phone.said] == ["Deploy rolled back"]


def test_a_fault_while_deciding_never_fails_the_job(auto, monkeypatch, capsys):
    monkeypatch.setattr(deploy.ci, "check", lambda sha, required=None: (_ for _ in ()).throw(RuntimeError("github is down")))
    assert deploy.auto(LATER) == 0 and head(auto.live) == auto.first
    assert "auto deploy: stopped (RuntimeError" in capsys.readouterr().out


def test_the_ready_notice_steps_aside_only_for_an_automatic_deploy_that_is_on_and_seen_running(auto, monkeypatch, capsys):
    monkeypatch.setattr(deploy, "ok_runs_since", lambda job, since: 1)
    assert deploy.ready(LATER) == 0
    assert auto.phone.daily == [] and "the automatic deploy takes it from here" in capsys.readouterr().out
    # On, but its timer was never installed (no run in three hours): the owner still hears that a deploy is ready.
    monkeypatch.setattr(deploy, "ok_runs_since", lambda job, since: 0)
    assert deploy.ready(LATER) == 0 and [t for _, t, _ in auto.phone.daily] == ["A deploy is ready"]
    # Switched off (dry): the same.
    auto.phone.daily.clear()
    monkeypatch.setattr(deploy, "ok_runs_since", lambda job, since: 1)
    (deploy.DEPLOY_DIR / deploy.AUTO_ON).unlink()
    assert deploy.ready(LATER) == 0 and [t for _, t, _ in auto.phone.daily] == ["A deploy is ready"]


def test_the_job_is_hourly_never_gates_a_deploy_and_does_not_wait_for_itself(auto):
    j = JOBS[deploy.AUTO_JOB]
    assert not j.trading and not j.preflight and j.interval_s == 3600 and j.command == ("-m", "wt.ops.deploy", "auto")
    # No switch starts later than 25 minutes in, and the tests' own limit here ends before that margin is spent.
    assert deploy.AUTO_SWITCH_BY_S + 20 * 60 < (j.deadline_min or 0) * 60 and deploy.AUTO_STAGE_S <= deploy.AUTO_SWITCH_BY_S
    assert j.runtime_max_h * 3600 > (j.deadline_min or 0) * 60 + 30 * 60        # systemd's limit covers the wait for a deploy too
    from wt.ops.locks import job_lock
    with job_lock(deploy.AUTO_JOB) as mine:                                     # as the job runner holds it around the job
        assert mine
        with deploy.quiesced(wait_s=0.0) as busy:
            assert deploy.AUTO_JOB in busy                                      # a deploy typed by the owner waits for it
        with deploy.quiesced(wait_s=0.0, own=deploy.AUTO_JOB) as busy:
            assert busy == []                                                   # the job itself does not
        assert deploy.auto(LATER) == 0 and head(auto.live) == auto.new
    assert isinstance(ci.Verdict(True, "x", {}), ci.Verdict)
