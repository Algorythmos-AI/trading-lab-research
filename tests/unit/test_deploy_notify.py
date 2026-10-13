"""ADR 0007: the host says when a deploy would be accepted, and deploys nothing. Real git repositories in a temp
dir (the fixture of test_deploy_transaction); the gate, CI and the dashboard guard are stubbed."""
from __future__ import annotations

import datetime as dt
from types import SimpleNamespace

import pytest
from test_deploy_transaction import commit, git, world  # noqa: F401 — the fixture

from wt.ops import ci, deploy, units
from wt.ops.schedule import JOBS

LATER = dt.datetime.now(dt.UTC) + dt.timedelta(hours=2)          # the test commits are older than the settle time


class Recorder:
    """Stands in for Alerts: what would have been sent, and which keys are firing."""

    def __init__(self):
        self.sent, self.firing = [], set()

    def once_per_day(self, key, title, message, priority=3, day=None):
        k = f"{key}:{LATER.astimezone().date().isoformat()}"
        if k in self.firing:
            return False
        self.firing.add(k)
        self.sent.append((title, message, priority))
        return True

    def resolve(self, key, title, message, priority=2):
        if key in self.firing:
            self.firing.discard(key)
            self.sent.append((title, message, priority))
            return True
        return False


@pytest.fixture
def notice(world, monkeypatch):  # noqa: F811
    dev, live, _, state = world
    rec = Recorder()
    monkeypatch.setattr(deploy, "Alerts", lambda: rec)
    new = commit(dev, "b")
    git(dev, "push", "-q", "origin", "main")
    return SimpleNamespace(dev=dev, live=live, state=state, rec=rec, new=new)


def test_a_ready_deploy_is_said_once_a_day_and_nothing_is_changed(notice, capsys):
    before = git(notice.live, "rev-parse", "HEAD")
    assert deploy.ready(LATER) == 0 and deploy.ready(LATER) == 0
    assert len(notice.rec.sent) == 1                                          # the second run says nothing
    title, message, priority = notice.rec.sent[0]
    assert title == "A deploy is ready" and priority == 3
    assert f"1 commit ahead of the host ({before[:8]} -> {notice.new[:8]})" in message and "wt-deploy deploy" in message
    assert git(notice.live, "rev-parse", "HEAD") == before                    # the live checkout did not move
    assert git(notice.live, "tag") == "" and not (deploy.DEPLOY_DIR).exists()  # no tag, no deploy record
    out = capsys.readouterr().out
    assert "is ready, 1 ahead (sent)" in out and "already said today" in out


@pytest.mark.parametrize("case,words", [("gate", "the gate is closed"), ("red", "is not green"),
                                        ("dash", "waits for the dashboard"), ("young", "waiting for main to settle"),
                                        ("off", "deploy notice: off")])
def test_it_stays_silent_whenever_a_deploy_would_be_refused(notice, monkeypatch, capsys, case, words):
    now = LATER
    if case == "gate":
        notice.state["gate"] = [["inside the trading night"]]
    elif case == "red":
        notice.state["green"] = False
    elif case == "dash":
        monkeypatch.setattr(deploy.dashguard, "guard", lambda root, target: (False, "the dashboard is older", ""))
    elif case == "young":
        now = dt.datetime.now(dt.UTC) + dt.timedelta(minutes=5)
    else:
        deploy.DEPLOY_DIR.mkdir(parents=True)
        (deploy.DEPLOY_DIR / deploy.NOTIFY_OFF).write_text("")
    fetched = git(notice.live, "rev-parse", "origin/main")
    assert deploy.ready(now) == 0
    assert notice.rec.sent == [] and words in capsys.readouterr().out
    if case in ("gate", "off"):                                              # not even a fetch
        assert git(notice.live, "rev-parse", "origin/main") == fetched != notice.new


def test_once_the_host_is_up_to_date_the_notice_clears(notice, capsys):
    deploy.ready(LATER)
    git(notice.live, "pull", "-q", "--ff-only", "origin", "main")             # the owner deployed
    assert deploy.ready(LATER) == 0
    assert [t for t, _, _ in notice.rec.sent] == ["A deploy is ready", "Host is up to date"]
    assert notice.rec.firing == set() and "nothing to deploy (already at" in capsys.readouterr().out
    deploy.ready(LATER)
    assert len(notice.rec.sent) == 2                                          # and it is not said again


def test_a_notice_that_cannot_be_worked_out_never_fails_its_job(notice, monkeypatch, capsys):
    def boom(sha):
        raise ConnectionError("GitHub is away")
    monkeypatch.setattr(deploy.ci, "check", boom)
    assert deploy.ready(LATER) == 0
    assert notice.rec.sent == [] and "could not be worked out (ConnectionError" in capsys.readouterr().out
    monkeypatch.setattr(deploy.ci, "check", lambda sha, required=None: ci.Verdict(True, "stub", {}))
    assert deploy.main(["ready"]) == 0                                        # the command line reaches it


def test_the_job_is_not_a_trading_job_and_runs_twice_an_hour_on_the_clock():
    j = JOBS["deploy-notify"]
    assert not j.trading and not j.preflight and j.interval_s == 1800 and j.command == ("-m", "wt.ops.deploy", "ready")
    assert "OnCalendar=*:20/30:00 UTC" in units.timer(j)
    assert j.runtime_max_h * 60 > (j.deadline_min or 0)
