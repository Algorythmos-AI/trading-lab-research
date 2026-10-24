"""Weekly evidence PR (wt.ops.evidence): only new, immutable copies; never a path the runtime writes."""
from __future__ import annotations

import datetime as dt

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
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week: [])
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
    monkeypatch.setattr(evidence, "plan_copies", lambda wt, week: [(src, wt / "research/forward/archive/x/scorecard_2026-10-23.md")])
    monkeypatch.setattr(evidence, "repo_visibility", lambda token: "private")
    monkeypatch.setattr(evidence, "WT_ROOT", tmp_path / "wt")
    monkeypatch.setenv("GH_TOKEN", "ghp-distinctive-token")
    done: list[list[str]] = []

    class R:
        returncode = 0
        stderr = stdout = ""

    monkeypatch.setattr(evidence.subprocess, "run", lambda cmd, **k: done.append(cmd) or R())
    assert evidence.run(today=dt.date(2026, 10, 23)) == 0
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

    import pytest
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    monkeypatch.setenv("GH_TOKEN", "sekrit-token-value")
    with pytest.raises(RuntimeError) as e:
        evidence._git("-c", "push.default=simple", "push", str(tmp_path / "no-such-sekrit-token-value.git"), "main", cwd=repo)
    assert "sekrit-token-value" not in str(e.value) and "***" in str(e.value) and "git push failed" in str(e.value)
