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
def auto(world, monkeypatch):  # noqa: F811
    dev, live, first, state = world
    phone = Phone()
    monkeypatch.setattr(deploy, "Alerts", lambda: phone)
    monkeypatch.setattr(deploy, "auto_enabled", lambda: not (deploy.DEPLOY_DIR / deploy.AUTO_OFF).exists())
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
    assert "rollback" in message and deploy.AUTO_OFF in message and "1 commit)" in message
    rec, = [json.loads(p.read_text()) for p in deploy.DEPLOY_DIR.glob("2*.json")]
    assert rec["by"] == "auto" and rec["staged"] is True and rec["to"] == auto.new       # the tests ran before the switch
    assert json.loads((deploy.DEPLOY_DIR / deploy.AUTO_STATE).read_text())["code"] == 0
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


@pytest.mark.parametrize("why", ["off", "gate", "closing", "young", "red", "dashboard", "dirty"])
def test_what_would_stop_the_owner_stops_it_and_so_does_a_gate_about_to_close(auto, monkeypatch, capsys, why):
    now = LATER
    if why == "off":
        deploy.DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
        (deploy.DEPLOY_DIR / deploy.AUTO_OFF).touch()
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
    assert out.startswith("auto deploy:") or "Refusing" in out


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
    assert "wt-install-units" in auto.phone.daily[0][2] and "changes what wt-install-units installs (1 file)" in auto.phone.daily[0][2]
    assert "already said today" in capsys.readouterr().out
    # A host whose installed units already differ from its code is not moved further either.
    git(auto.dev, "revert", "--no-edit", "HEAD")
    git(auto.dev, "push", "-q", "origin", "main")
    git(auto.live, "fetch", "-q", "origin", "main")
    assert deploy.needs_owner(auto.first, head(auto.dev)) is None            # the path is back as it was: nothing to install
    monkeypatch.setattr(deploy.units, "diff", lambda rendered: ["wt-x.timer: not installed"])
    monkeypatch.setattr(deploy.host, "current", lambda: SimpleNamespace(kind="systemd"))
    assert "installed units differ" in deploy.needs_owner(auto.first, head(auto.dev))


def test_a_target_whose_tests_failed_here_is_not_tried_again_but_a_newer_one_is(auto, capsys):
    auto.state["stage"] = (False, "1 failed")
    assert deploy.auto(LATER) == 0
    assert head(auto.live) == auto.first and auto.state["alerts"] == [] and auto.phone.said[0][0] == "Deploy refused: tests failed"
    assert json.loads((deploy.DEPLOY_DIR / deploy.AUTO_STATE).read_text())["failed"] == auto.new
    assert deploy.auto(LATER) == 0 and len(auto.phone.said) == 1               # not run, not paged, a second time
    assert "failed its tests here before" in capsys.readouterr().out
    auto.state["stage"] = (True, "ok")
    newer = commit(auto.dev, "c")
    git(auto.dev, "push", "-q", "origin", "main")
    assert deploy.auto(LATER) == 0 and head(auto.live) == newer
    assert auto.phone.said[-1][0] == "Deployed automatically" and "2 commits" in auto.phone.said[-1][1]


def test_a_smoke_failure_rolls_back_and_nothing_says_it_deployed(auto):
    auto.state["smoke"] = False
    assert deploy.auto(LATER) == 0
    assert head(auto.live) == auto.first
    assert [t for t, _ in auto.phone.said] == ["Deploy rolled back"]


def test_a_fault_while_deciding_never_fails_the_job(auto, monkeypatch, capsys):
    monkeypatch.setattr(deploy.ci, "check", lambda sha: (_ for _ in ()).throw(RuntimeError("github is down")))
    assert deploy.auto(LATER) == 0 and head(auto.live) == auto.first
    assert "auto deploy: stopped (RuntimeError" in capsys.readouterr().out


def test_with_automatic_deploys_on_the_ready_notice_is_not_sent(auto, monkeypatch, capsys):
    assert deploy.ready(LATER) == 0
    assert auto.phone.daily == [] and "the automatic deploy takes it from here" in capsys.readouterr().out
    monkeypatch.setattr(deploy, "auto_enabled", lambda: False)                  # switched off: the notice is back
    assert deploy.ready(LATER) == 0 and [t for _, t, _ in auto.phone.daily] == ["A deploy is ready"]


def test_the_job_is_hourly_never_gates_a_deploy_and_does_not_wait_for_itself(auto):
    j = JOBS[deploy.AUTO_JOB]
    assert not j.trading and not j.preflight and j.interval_s == 3600 and j.command == ("-m", "wt.ops.deploy", "auto")
    assert (j.deadline_min or 0) * 60 > deploy.STAGE_TIMEOUT_S                  # the tests' own limit fits inside the job's
    from wt.ops.locks import job_lock
    with job_lock(deploy.AUTO_JOB) as mine:                                     # as the job runner holds it around the job
        assert mine
        with deploy.quiesced(wait_s=0.0) as busy:
            assert deploy.AUTO_JOB in busy                                      # a deploy typed by the owner waits for it
        with deploy.quiesced(wait_s=0.0, own=deploy.AUTO_JOB) as busy:
            assert busy == []                                                   # the job itself does not
        assert deploy.auto(LATER) == 0 and head(auto.live) == auto.new
    assert isinstance(ci.Verdict(True, "x", {}), ci.Verdict)
