"""Weekly evidence PR (wt.ops.evidence): only new, immutable copies; never a path the runtime writes."""
from __future__ import annotations

import datetime as dt
import re
import subprocess

import pytest

from wt.ops import evidence
from wt.ops.visibility import Probe

_REAL_OPEN_PRS = evidence.open_evidence_prs


class FakeAlerts:
    """Records what would be paged; sends nothing."""

    def __init__(self):
        self.fired: list[tuple[str, str, str]] = []
        self.resolved: list[str] = []
        self.firing: set[str] = set()

    def fire(self, key, title, message, priority=4, tags=()):
        self.fired.append((key, title, message))
        new = key not in self.firing
        self.firing.add(key)
        return new

    def resolve(self, key, title, message, priority=2):
        if key in self.firing:
            self.firing.discard(key)
            self.resolved.append(key)
            return True
        return False


def test_iso_week():
    assert evidence.iso_week(dt.date(2026, 10, 3)) == "2026-W40"


def test_plan_copies_only_new_files_and_never_overwrites(tmp_path):
    wt, var = tmp_path / "wt", tmp_path / "var"
    (var / "forward").mkdir(parents=True)
    (var / "forward" / "forward_trades.jsonl").write_text('{"session": "2026-10-02"}\n')
    (var / "watchlist").mkdir()
    (var / "watchlist" / "2026-10-01.json").write_text("{}")
    (var / "watchlist" / "2026-10-02.json").write_text("{}")
    (var / "scorecards").mkdir()
    (var / "scorecards" / "scorecard_2026-10-03.md").write_text("# card")
    (wt / "watchlist").mkdir(parents=True)
    (wt / "watchlist" / "2026-10-01.json").write_text("{}")                 # already tracked
    pairs = evidence.plan_copies(wt, "2026-W40", var / "forward" / "forward_trades.jsonl", var / "watchlist",
                                 var / "scorecards")
    dsts = sorted(str(d.relative_to(wt)) for _, d in pairs)
    assert dsts == ["research/forward/archive/2026-W40/forward_trades.jsonl",
                    "research/forward/archive/2026-W40/scorecard_2026-10-03.md", "watchlist/2026-10-02.json"]
    assert evidence.scorecard_week("scorecard_2026-10-03.md") == "2026-W40"
    assert evidence.scorecard_week("scorecard_2026-13-01.md") is None and evidence.scorecard_week("notes.md") is None
    for _, d in pairs:                                                      # once archived, nothing is re-copied
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_text("x")
    assert evidence.plan_copies(wt, "2026-W40", var / "forward" / "forward_trades.jsonl", var / "watchlist",
                                var / "scorecards") == []


def test_run_is_skipped_without_a_token(monkeypatch, capsys):
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert evidence.run() == 0 and "skipped" in capsys.readouterr().out


def test_evidence_never_pushes_unless_the_repo_is_confirmed_private(monkeypatch, capsys, tmp_path):
    calls = []
    monkeypatch.setattr(evidence, "_git", lambda *a, **k: calls.append(a) or "")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [])
    for vis in ("public", "unknown", "internal"):
        monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0, v=vis: Probe(v, "ok" if v != "unknown" else "error"))
        monkeypatch.setenv("GH_TOKEN", "t")
        assert evidence.run(alerts=FakeAlerts(), vis_state=tmp_path / f"{vis}.json") == 0
        out = capsys.readouterr().out
        assert "evidence PR parked" in out and out.strip().splitlines()[-1].endswith("not private; nothing pushed")
    assert not [a for a in calls if "push" in a]


def test_evidence_pushes_over_https_with_the_token_never_through_origin(monkeypatch, tmp_path, capsys):
    """On the host `origin` is a read-only deploy key once the repository is private; the push must not use it."""
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(evidence, "_git", lambda *a, **k: calls.append(a) or "")
    src = tmp_path / "scorecard_2026-10-23.md"
    src.write_text("# card")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(src, wt / "research/forward/archive/x/scorecard_2026-10-23.md")])
    monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0: Probe("private", "ok"))
    monkeypatch.setattr(evidence, "WT_ROOT", tmp_path / "wt")
    monkeypatch.setenv("GH_TOKEN", "ghp-distinctive-token")
    done: list[list[str]] = []

    class R:
        returncode = 0
        stderr = stdout = ""

    monkeypatch.setattr(evidence.subprocess, "run", lambda cmd, **k: done.append(cmd) or R())
    monkeypatch.setattr(evidence, "open_evidence_prs", lambda token, timeout=60.0: [])
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=FakeAlerts(), vis_state=tmp_path / "vis.json") == 0
    assert any("fetch" in a and "integration" in a for a in calls)             # work lands on integration (ADR 0009)
    assert any("worktree" in a and "origin/integration" in a for a in calls)
    create = next(c for c in done if c[:3] == ["gh", "pr", "create"])
    assert create[create.index("--base") + 1] == "integration"
    pushes = [a for a in calls if "push" in a]
    assert len(pushes) == 1
    push = pushes[0]
    assert f"remote.origin.pushurl={evidence.PUSH_URL}" in push              # the token URL takes the push ...
    assert push.index("-c") < push.index("push") and "--force-with-lease" in push
    assert evidence.PUSH_URL not in [a for a in push if not a.startswith("remote.origin.pushurl=")]   # ... as pushurl, not a bare URL
    assert evidence.PUSH_URL.startswith("https://github.com/")
    assert "ghp-distinctive-token" not in capsys.readouterr().out            # the token is never printed


def test_git_errors_never_carry_the_token(monkeypatch, tmp_path):
    """git echoes the remote it could not reach; a token inside that text must be gone before it is raised."""
    import subprocess

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    monkeypatch.setenv("GH_TOKEN", "sekrit-token-value")
    with pytest.raises(RuntimeError) as e:
        evidence._git("-c", "push.default=simple", "push", str(tmp_path / "no-such-sekrit-token-value.git"), "main", cwd=repo)
    assert "sekrit-token-value" not in str(e.value) and "***" in str(e.value) and "git push failed" in str(e.value)


def _evidence_tree(tmp_path):
    wt, var = tmp_path / "wt", tmp_path / "var"
    (var / "forward").mkdir(parents=True)
    (var / "forward" / "forward_trades.jsonl").write_text('{"session": "2026-10-23"}\n')
    (var / "watchlist").mkdir()
    (var / "watchlist" / "2026-10-23.json").write_text('{"names": [{"sym": "X", "headlines": ["secret"]}]}')
    (var / "scorecards").mkdir()
    for d in ("2026-10-09", "2026-10-16", "2026-10-23"):
        (var / "scorecards" / f"scorecard_{d}.md").write_text("# card")
    wt.mkdir()
    return wt, var


def test_every_scorecard_lands_under_its_own_week_and_a_catch_up_takes_one_week(tmp_path):
    wt, var = _evidence_tree(tmp_path)
    args = (var / "forward" / "forward_trades.jsonl", var / "watchlist", var / "scorecards")
    w41 = sorted(str(d.relative_to(wt)) for _, d in evidence.plan_copies(wt, "2026-W41", *args, catch_up=True))
    assert w41 == ["research/forward/archive/2026-W41/scorecard_2026-10-09.md"]      # no ledger, no watchlist
    now = sorted(str(d.relative_to(wt)) for _, d in evidence.plan_copies(wt, "2026-W43", *args))
    assert now == ["research/forward/archive/2026-W41/scorecard_2026-10-09.md",
                   "research/forward/archive/2026-W42/scorecard_2026-10-16.md",
                   "research/forward/archive/2026-W43/forward_trades.jsonl",
                   "research/forward/archive/2026-W43/scorecard_2026-10-23.md", "watchlist/2026-10-23.json"]
    # a scorecard git already holds anywhere under research/forward is never copied again
    (wt / "research" / "forward").mkdir(parents=True)
    (wt / "research" / "forward" / "scorecard_2026-10-09.md").write_text("old")
    again = [str(d.relative_to(wt)) for _, d in evidence.plan_copies(wt, "2026-W41", *args, catch_up=True)]
    assert again == []


def test_week_date_and_week_argument_validation():
    assert evidence.iso_week(evidence.week_date("2026-W41")) == "2026-W41"
    with pytest.raises(ValueError):
        evidence.week_date("2026-10-09")


def test_json_copies_lose_the_keys_the_dashboard_refuses(tmp_path):
    src, dst = tmp_path / "w.json", tmp_path / "out" / "w.json"
    src.write_text('{"names": [{"sym": "X", "headlines": ["h"], "features": {"catalyst_type": "t", "catalyst_headline": "c", "ok": 1}}], "setup": "s"}')
    assert evidence.copy_clean(src, dst) == 4
    text = dst.read_text()
    assert "headlines" not in text and "catalyst_headline" not in text and "catalyst_type" not in text
    assert '"setup"' not in text and '"ok": 1' in text and text.endswith("\n")
    md = tmp_path / "scorecard_2026-10-23.md"
    md.write_text("# card")
    assert evidence.copy_clean(md, tmp_path / "out" / md.name) == 0 and (tmp_path / "out" / md.name).read_text() == "# card"


def _stubbed_run(monkeypatch, tmp_path, prs):
    calls: list[tuple[str, ...]] = []
    done: list[list[str]] = []
    monkeypatch.setattr(evidence, "_git", lambda *a, **k: calls.append(a) or "")
    monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0: Probe("private", "ok"))
    monkeypatch.setattr(evidence, "open_evidence_prs", lambda token, timeout=60.0: prs)
    monkeypatch.setattr(evidence, "WT_ROOT", tmp_path / "wt")
    monkeypatch.setenv("GH_TOKEN", "ghp-distinctive-token")

    class R:
        returncode = 0
        stderr = stdout = ""

    monkeypatch.setattr(evidence.subprocess, "run", lambda cmd, **k: done.append(cmd) or R())
    return calls, done


def test_a_run_stops_and_alerts_while_an_evidence_pull_request_is_open_or_unlistable(monkeypatch, tmp_path, capsys):
    calls, _ = _stubbed_run(monkeypatch, tmp_path, ["evidence/2026-W42"])
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json") == 0   # a check, not a crash
    assert "needs the owner's merge" in capsys.readouterr().out and calls == []
    assert [k for k, _, _ in a.fired] == ["evidence-pr:pr-open"]
    assert "still open and needs your merge" in a.fired[0][2] and "evidence/2026-W42" not in a.fired[0][2]
    calls, _ = _stubbed_run(monkeypatch, tmp_path, None)                    # gh failed: never "none open"
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert "could not be listed" in capsys.readouterr().out and calls == []
    assert [k for k, _, _ in a.fired] == ["evidence-pr:pr-list"] and "the pr-list step failed" in a.fired[0][2]


def test_a_catch_up_run_stages_that_weeks_scorecards_and_nothing_else(monkeypatch, tmp_path, capsys):
    calls, done = _stubbed_run(monkeypatch, tmp_path, [])
    _, var = _evidence_tree(tmp_path)
    monkeypatch.setattr(evidence, "FORWARD_LEDGER", var / "forward" / "forward_trades.jsonl")
    monkeypatch.setattr(evidence, "FORWARD_WATCHLIST_DIR", var / "watchlist")
    monkeypatch.setattr(evidence, "SCORECARD_DIR", var / "scorecards")
    assert evidence.run(today=dt.date(2026, 10, 23), week="2026-W41", alerts=FakeAlerts(),
                        vis_state=tmp_path / "v.json") == 0
    added = next(a for a in calls if a[0] == "add")
    assert list(added[2:]) == ["research/forward/archive/2026-W41/scorecard_2026-10-09.md"]
    assert any("fetch" in a and "--prune" in a and "+refs/heads/evidence/*:refs/remotes/origin/evidence/*" in a
               for a in calls)
    commit = next(a for a in calls if "commit" in a)
    assert "catch-up: the scorecards of 2026-W41" in " ".join(commit)
    assert "2026-W41" in " ".join(next(c for c in done if c[:3] == ["gh", "pr", "create"]))
    assert "ghp-distinctive-token" not in capsys.readouterr().out


def test_a_future_week_is_refused(monkeypatch, tmp_path, capsys):
    calls, _ = _stubbed_run(monkeypatch, tmp_path, [])
    assert evidence.run(today=dt.date(2026, 10, 23), week="2026-W50", alerts=FakeAlerts(),
                        vis_state=tmp_path / "v.json") == 1
    assert "has not happened yet" in capsys.readouterr().out and calls == []


def test_the_catch_up_flag_is_a_week():
    with pytest.raises(ValueError):
        evidence.main(["--week", "last"])


# ---- every way a publishing run can stop: one alert each, allowlist-clean, exit 0 ---------------------------------

PAGE = re.compile(r"[A-Za-z0-9 .,:;()'+%/_>?-]*")


def _failing_git(fail_on: str, exc: Exception):
    calls: list[tuple[str, ...]] = []

    def git(*a, **k):
        calls.append(a)
        if fail_on in a:
            raise exc
        return ""
    return git, calls


@pytest.mark.parametrize(("fail_on", "exc", "step", "outcome"), [
    ("fetch", RuntimeError("git fetch failed: fatal: unable to access 'https://x-access-token:ghp-distinctive-token@github.com/' /home/wt/trading/var/x"), "fetch", "failed"),
    ("commit", RuntimeError("git commit failed: error: /home/wt/trading/knowledge/a.md"), "commit", "failed"),
    ("push", RuntimeError("git push failed: remote: Permission to Algorythmos-AI/trading-lab-research.git denied to ***. https://github.com/"), "push", "failed"),
    ("push", subprocess.TimeoutExpired(["git", "push"], 120), "push", "timed out"),
])
def test_a_failed_step_alerts_once_with_clean_text_and_exits_zero(monkeypatch, tmp_path, capsys, fail_on, exc, step,
                                                                  outcome):
    _stubbed_run(monkeypatch, tmp_path, [])
    git, calls = _failing_git(fail_on, exc)
    monkeypatch.setattr(evidence, "_git", git)
    src = tmp_path / "scorecard_2026-10-23.md"
    src.write_text("# card")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(src, wt / "research/forward/archive/x/scorecard_2026-10-23.md")])
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert [k for k, _, _ in a.fired] == [f"evidence-pr:{step}"]
    _, title, msg = a.fired[0]
    assert title == "Weekly evidence not published"
    assert f"the {step} step {outcome}" in msg and "2026-W43" in msg
    for text in (title, msg):
        assert PAGE.fullmatch(text), text
        for bad in ("ghp-", "https", "github.com", "/home", "var/", "knowledge", "Permission", "fatal", "***"):
            assert bad not in text
    out = capsys.readouterr().out
    assert f"stopped at {step}" in out and "ghp-distinctive-token" not in out    # the detail goes to the log, redacted
    assert not a.resolved


def test_a_commit_with_one_new_file_says_so(monkeypatch, tmp_path):
    _stubbed_run(monkeypatch, tmp_path, [])
    git, _ = _failing_git("push", RuntimeError("x"))
    monkeypatch.setattr(evidence, "_git", git)
    src = tmp_path / "scorecard_2026-10-23.md"
    src.write_text("# card")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(src, wt / "a.md")])
    a = FakeAlerts()
    evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json")
    assert "1 new file(s) wait for the next run" in a.fired[0][2]


@pytest.mark.parametrize(("exc", "outcome"), [(FileNotFoundError("gh"), "gh missing"),
                                              (subprocess.TimeoutExpired(["gh"], 120), "timed out")])
def test_gh_missing_or_hanging_at_pr_create(monkeypatch, tmp_path, exc, outcome):
    _stubbed_run(monkeypatch, tmp_path, [])
    src = tmp_path / "scorecard_2026-10-23.md"
    src.write_text("# card")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(src, wt / "a.md")])

    def run(cmd, **k):
        raise exc
    monkeypatch.setattr(evidence.subprocess, "run", run)
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert [k for k, _, _ in a.fired] == ["evidence-pr:pr-create"]
    assert f"the pr-create step {outcome}. The branch was pushed; the pull request was not opened." in a.fired[0][2]


def test_pr_create_refused_by_github(monkeypatch, tmp_path):
    _stubbed_run(monkeypatch, tmp_path, [])
    src = tmp_path / "scorecard_2026-10-23.md"
    src.write_text("# card")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(src, wt / "a.md")])

    class R:
        returncode = 1
        stdout = ""
        stderr = "GraphQL: Resource not accessible by integration https://api.github.com/graphql"
    monkeypatch.setattr(evidence.subprocess, "run", lambda cmd, **k: R())
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert "GraphQL" not in a.fired[0][2] and "the pr-create step failed" in a.fired[0][2]


def test_the_runs_time_budget_stops_it_with_its_own_alert(monkeypatch, tmp_path):
    _stubbed_run(monkeypatch, tmp_path, [])
    t = iter([0.0, 0.0, 0.0, 600.0, 600.0, 600.0, 600.0])
    budget = evidence.Budget(480.0, clock=lambda: next(t))
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json", budget=budget) == 0
    assert len(a.fired) == 1 and "step timed out" in a.fired[0][2]


def test_a_clean_run_resolves_every_evidence_alert(monkeypatch, tmp_path):
    _stubbed_run(monkeypatch, tmp_path, [])
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [])
    a = FakeAlerts()
    a.firing = {"evidence-pr:push", "evidence-pr:pr-open"}
    assert evidence.run(today=dt.date(2026, 10, 23), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert sorted(a.resolved) == ["evidence-pr:pr-open", "evidence-pr:push"] and not a.fired


def test_a_dry_run_never_pages_and_reports_a_failed_step(monkeypatch, tmp_path, capsys):
    git, _ = _failing_git("fetch", RuntimeError("git fetch failed: x"))
    monkeypatch.setattr(evidence, "_git", git)
    monkeypatch.setattr(evidence, "WT_ROOT", tmp_path / "wt")
    monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0: pytest.fail("a dry run asks nothing"))
    assert evidence.run(dry_run=True, today=dt.date(2026, 10, 23)) == 1
    assert "stopped at fetch" in capsys.readouterr().out


def test_a_parked_run_pages_the_visibility_once_then_stays_quiet(monkeypatch, tmp_path, capsys):
    """Case (c): a public repository is a standing state. One page when it is first seen, none the next weeks."""
    _stubbed_run(monkeypatch, tmp_path, [])
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [])
    monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0: Probe("public", "ok"))
    a = FakeAlerts()
    for week_day in (dt.date(2026, 10, 23), dt.date(2026, 10, 30), dt.date(2026, 11, 6)):
        assert evidence.run(today=week_day, alerts=a, vis_state=tmp_path / "v.json") == 0
        out = capsys.readouterr().out
        assert "repo visibility: public" in out and "evidence PR parked" in out     # said in the log every run
    assert [k for k, _, _ in a.fired] == ["repo-visibility:not-private"]
    monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0: Probe("private", "ok"))
    assert evidence.run(today=dt.date(2026, 11, 13), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert "repo-visibility:not-private" in a.resolved


def test_a_crash_still_exits_non_zero(monkeypatch, tmp_path):
    _stubbed_run(monkeypatch, tmp_path, [])
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: 1 / 0)
    with pytest.raises(ZeroDivisionError):
        evidence.run(today=dt.date(2026, 10, 23), alerts=FakeAlerts(), vis_state=tmp_path / "v.json")


# ---- the weekly job's side (wt.ops.jobs.publish_evidence) ---------------------------------------------------------

class _Log:
    def __init__(self):
        self.lines: list[str] = []

    def __call__(self, msg):
        self.lines.append(msg)


class _Daily(FakeAlerts):
    def once_per_day(self, key, title, message, priority=3, day=None):
        self.fired.append((key, title, message))
        return True


def test_the_weekly_job_logs_the_evidence_outcome_and_pages_only_a_crash_or_a_hang(monkeypatch, tmp_path):
    from wt.ops import jobs

    class R:
        def __init__(self, code, out, err=""):
            self.returncode, self.stdout, self.stderr = code, out, err

    out = "\n".join([f"  research/forward/archive/2026-W46/file{i}.md" for i in range(60)]
                    + ["repo visibility: public (last confirmed public on 2026-11-13)",
                       "evidence 2026-W46: outcome parked, the repository is public, not private; nothing pushed"])
    for result, paged in ((R(0, out), False), (R(1, "", "Traceback ... ZeroDivisionError"), True)):
        log, a = _Log(), _Daily()
        monkeypatch.setattr(jobs.subprocess, "run", lambda *x, r=result, **k: r)
        jobs.publish_evidence(tmp_path, log, a)
        assert bool(a.fired) is paged
        if not paged:
            assert log.lines[-1].endswith("nothing pushed") and any("repo visibility: public" in x for x in log.lines)
        else:
            assert a.fired[0][2] == "See the scorecard log." and "ZeroDivisionError" in log.lines[-1]

    def hang(*x, **k):
        raise subprocess.TimeoutExpired(["python"], 600)
    log, a = _Log(), _Daily()
    monkeypatch.setattr(jobs.subprocess, "run", hang)
    jobs.publish_evidence(tmp_path, log, a)                # before: a log line and no page at all
    assert [k for k, _, _ in a.fired] == ["evidence"] and "did not finish" in a.fired[0][2]
    assert "TimeoutExpired" in log.lines[-1]


# ---- review round: the parked path never fails the weekly job, and the budget holds ------------------------------

def test_a_parked_run_touches_no_git_and_no_network_and_never_fails_whatever_breaks(monkeypatch, tmp_path, capsys):
    """The repository is public today: this is the live path every week."""
    git_calls: list[tuple] = []

    def git(*a, **k):
        git_calls.append(a)
        raise RuntimeError("git fetch failed: fatal https://x-access-token:ghp-distinctive-token@github.com/")

    def no_subprocess(*a, **k):
        raise AssertionError("a parked run runs no subprocess")

    monkeypatch.setattr(evidence, "_git", git)
    monkeypatch.setattr(evidence.subprocess, "run", no_subprocess)
    monkeypatch.setattr(evidence, "open_evidence_prs", lambda *a, **k: pytest.fail("no pull-request listing"))
    monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0: Probe("public", "ok"))
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(tmp_path / "s.md", evidence.ROOT / "research/x.md")])
    monkeypatch.setenv("GH_TOKEN", "ghp-distinctive-token")
    a = FakeAlerts()
    for d in (dt.date(2026, 11, 13), dt.date(2026, 11, 20), dt.date(2026, 11, 27)):
        assert evidence.run(today=d, alerts=a, vis_state=tmp_path / "v.json") == 0
        out = capsys.readouterr().out
        assert out.strip().splitlines()[-1].endswith("not private; nothing pushed") and "research/x.md" in out
    assert git_calls == []                                          # no fetch with the token, no worktree
    assert [k for k, _, _ in a.fired] == ["repo-visibility:not-private"]   # the one state-change page, then nothing


def test_a_parked_runs_local_listing_failing_still_exits_zero(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(evidence, "probe", lambda token, timeout_s=60.0: Probe("unknown", "timeout"))
    monkeypatch.setattr(evidence, "plan_copies", lambda *a, **k: (_ for _ in ()).throw(OSError("disk")))
    monkeypatch.setattr(evidence, "_git", lambda *a, **k: pytest.fail("no git"))
    monkeypatch.setenv("GH_TOKEN", "t")
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 11, 13), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert "could not be made (OSError)" in capsys.readouterr().out and a.fired == []      # one unknown: no page


def test_only_a_manual_dry_run_returns_one_for_a_failed_step(monkeypatch, tmp_path):
    monkeypatch.setattr(evidence, "_git", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    monkeypatch.setattr(evidence, "WT_ROOT", tmp_path / "wt")
    assert evidence.run(dry_run=True, today=dt.date(2026, 11, 13)) == 1


def test_pr_list_timing_out_reads_as_timed_out(monkeypatch, tmp_path):
    _stubbed_run(monkeypatch, tmp_path, [])

    def hang(*a, **k):
        raise subprocess.TimeoutExpired(["gh"], 60)
    monkeypatch.setattr(evidence, "open_evidence_prs", _REAL_OPEN_PRS)      # the real one, not the stub
    monkeypatch.setattr(evidence.subprocess, "run", hang)
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 11, 13), alerts=a, vis_state=tmp_path / "v.json") == 0
    assert [k for k, _, _ in a.fired] == ["evidence-pr:pr-list"] and "the pr-list step timed out" in a.fired[0][2]




class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_the_budget_arithmetic_every_step_and_the_removal_draw_from_one_clock(monkeypatch, tmp_path):
    """Every step takes its whole timeout: the run stops on its own, and the worst case, the stop alert and the
    worktree removal included, stays clearly under the weekly job's 600 s."""
    _stubbed_run(monkeypatch, tmp_path, [])
    clock = FakeClock()
    budget = evidence.Budget(clock=clock)
    granted: list[float] = []

    def slow_git(*a, timeout=120.0, **k):
        granted.append(timeout)
        clock.t += timeout
        return ""

    def slow_run(cmd, timeout=120.0, **k):
        granted.append(timeout)
        clock.t += timeout
        raise subprocess.TimeoutExpired(cmd, timeout)

    src = tmp_path / "scorecard_2026-11-13.md"
    src.write_text("# card")
    monkeypatch.setattr(evidence, "_git", slow_git)
    monkeypatch.setattr(evidence.subprocess, "run", slow_run)
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(src, wt / "a.md")])

    def probe(token, timeout_s=60.0):
        granted.append(timeout_s)
        clock.t += timeout_s
        return Probe("private", "ok")
    monkeypatch.setattr(evidence, "probe", probe)
    a = FakeAlerts()
    assert evidence.run(today=dt.date(2026, 11, 13), alerts=a, vis_state=tmp_path / "v.json", budget=budget) == 0
    assert len(a.fired) == 1 and "timed out" in a.fired[0][2]
    assert clock.t <= evidence.BUDGET_S + evidence.REMOVE_MIN_S             # the removal had what was left, or 5 s
    worst = evidence.BUDGET_S + evidence.REMOVE_MIN_S + 2 * evidence.ALERT_S
    assert worst <= 440 < evidence.PARENT_TIMEOUT_S - 150
    assert granted[0] == 60.0 and all(g > 0 for g in granted)


def test_the_weekly_job_logs_a_hung_runs_output_with_the_token_redacted(monkeypatch, tmp_path):
    from wt.ops import jobs
    monkeypatch.setenv("GH_TOKEN", "ghp-distinctive-token")

    def hang(*a, **k):
        raise subprocess.TimeoutExpired(["python"], 600, output=b"repo visibility: private\nfetch ghp-distinctive-token",
                                        stderr="Traceback: stuck")
    monkeypatch.setattr(jobs.subprocess, "run", hang)
    log, a = _Log(), _Daily()
    jobs.publish_evidence(tmp_path, log, a)
    text = "\n".join(log.lines)
    assert "evidence stdout: repo visibility: private" in text and "evidence stderr: Traceback: stuck" in text
    assert "ghp-distinctive-token" not in text and "***" in text and len(a.fired) == 1


TOKEN_FORMS = ["ghp_" + "A1b2" * 6, "github_pat_" + "11AB_" * 6, "https://x-access-token:sekritvalue@github.com/",
               "Bearer abc.def.ghi"]
SECRETS = ("A1b2A1b2", "11AB_11AB", "sekritvalue", "abc.def.ghi")


@pytest.mark.parametrize("tok", TOKEN_FORMS)
def test_tokens_are_redacted_on_every_path(monkeypatch, tmp_path, tok):
    from wt.ops import jobs
    monkeypatch.delenv("GH_TOKEN", raising=False)
    # evidence: a git error that echoes the remote (a header form cannot be part of a remote, so it is fed directly)
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    remote = tok.replace("/", "_") if " " not in tok else "plain"
    with pytest.raises(RuntimeError) as e:
        evidence._git("push", f"{tmp_path}/no-such-{remote}.git", "main", cwd=repo)
    assert not any(s in str(e.value) for s in SECRETS)
    assert not any(s in evidence._redact(f"remote: {tok}") for s in SECRETS)

    class R:
        def __init__(self, code, out, err):
            self.returncode, self.stdout, self.stderr = code, out, err
    # the weekly job: a run that exits non-zero, then one that hangs
    for result in (R(1, f"evidence: pushing with {tok}", f"Traceback: {tok}"), R(0, f"fine {tok}", "")):
        log, a = _Log(), _Daily()
        monkeypatch.setattr(jobs.subprocess, "run", lambda *x, r=result, **k: r)
        jobs.publish_evidence(tmp_path, log, a)
        text = "\n".join(log.lines)
        assert not any(s in text for s in SECRETS) and "***" in text

    def hang(*x, **k):
        raise subprocess.TimeoutExpired(["python"], 600, output=f"out {tok}".encode(), stderr=f"err {tok}")
    monkeypatch.setattr(jobs.subprocess, "run", hang)
    log, a = _Log(), _Daily()
    jobs.publish_evidence(tmp_path, log, a)
    text = "\n".join(log.lines)
    assert not any(s in text for s in SECRETS) and "***" in text
