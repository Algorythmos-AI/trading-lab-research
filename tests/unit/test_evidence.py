"""Weekly evidence PR (wt.ops.evidence): only new, immutable copies; never a path the runtime writes."""
from __future__ import annotations

import datetime as dt

import pytest

from wt.ops import evidence


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


def test_evidence_never_pushes_unless_the_repo_is_confirmed_private(monkeypatch, capsys):
    from wt.ops import evidence
    calls = []
    monkeypatch.setattr(evidence, "_git", lambda *a, **k: calls.append(a) or "")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [])
    for vis in ("public", "unknown", "internal"):
        monkeypatch.setattr(evidence, "repo_visibility", lambda token, v=vis: v)
        monkeypatch.setenv("GH_TOKEN", "t")
        assert evidence.run() == 0
        assert "evidence PR parked" in capsys.readouterr().out
    assert not [a for a in calls if "push" in a]


def test_evidence_pushes_over_https_with_the_token_never_through_origin(monkeypatch, tmp_path, capsys):
    """On the host `origin` is a read-only deploy key once the repository is private; the push must not use it."""
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(evidence, "_git", lambda *a, **k: calls.append(a) or "")
    src = tmp_path / "scorecard_2026-10-23.md"
    src.write_text("# card")
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week, **kw: [(src, wt / "research/forward/archive/x/scorecard_2026-10-23.md")])
    monkeypatch.setattr(evidence, "repo_visibility", lambda token: "private")
    monkeypatch.setattr(evidence, "WT_ROOT", tmp_path / "wt")
    monkeypatch.setenv("GH_TOKEN", "ghp-distinctive-token")
    done: list[list[str]] = []

    class R:
        returncode = 0
        stderr = stdout = ""

    monkeypatch.setattr(evidence.subprocess, "run", lambda cmd, **k: done.append(cmd) or R())
    monkeypatch.setattr(evidence, "open_evidence_prs", lambda token: [])
    assert evidence.run(today=dt.date(2026, 10, 23)) == 0
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
    monkeypatch.setattr(evidence, "repo_visibility", lambda token: "private")
    monkeypatch.setattr(evidence, "open_evidence_prs", lambda token: prs)
    monkeypatch.setattr(evidence, "WT_ROOT", tmp_path / "wt")
    monkeypatch.setenv("GH_TOKEN", "ghp-distinctive-token")

    class R:
        returncode = 0
        stderr = stdout = ""

    monkeypatch.setattr(evidence.subprocess, "run", lambda cmd, **k: done.append(cmd) or R())
    return calls, done


def test_a_run_stops_and_alerts_while_an_evidence_pull_request_is_open_or_unlistable(monkeypatch, tmp_path, capsys):
    calls, _ = _stubbed_run(monkeypatch, tmp_path, ["evidence/2026-W42"])
    assert evidence.run(today=dt.date(2026, 10, 23)) == 1
    assert "needs the owner's merge" in capsys.readouterr().out and calls == []
    calls, _ = _stubbed_run(monkeypatch, tmp_path, None)                    # gh failed: never "none open"
    assert evidence.run(today=dt.date(2026, 10, 23)) == 1
    assert "could not be listed" in capsys.readouterr().out and calls == []


def test_a_catch_up_run_stages_that_weeks_scorecards_and_nothing_else(monkeypatch, tmp_path, capsys):
    calls, done = _stubbed_run(monkeypatch, tmp_path, [])
    _, var = _evidence_tree(tmp_path)
    monkeypatch.setattr(evidence, "FORWARD_LEDGER", var / "forward" / "forward_trades.jsonl")
    monkeypatch.setattr(evidence, "FORWARD_WATCHLIST_DIR", var / "watchlist")
    monkeypatch.setattr(evidence, "SCORECARD_DIR", var / "scorecards")
    assert evidence.run(today=dt.date(2026, 10, 23), week="2026-W41") == 0
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
    assert evidence.run(today=dt.date(2026, 10, 23), week="2026-W50") == 1
    assert "has not happened yet" in capsys.readouterr().out and calls == []


def test_the_catch_up_flag_is_a_week():
    with pytest.raises(ValueError):
        evidence.main(["--week", "last"])
