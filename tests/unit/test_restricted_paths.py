"""The restricted-path guard (scripts/check_restricted_paths.py): the pre-commit hook's own pattern, enforced in CI."""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_restricted_paths", ROOT / "scripts" / "check_restricted_paths.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True,
                          env=GIT_ENV).stdout


def repo(tmp_path: Path) -> Path:
    r = tmp_path / "repo"
    r.mkdir()
    git(r, "init", "-q", "-b", "main")
    git(r, "config", "core.ignorecase", "false")
    (r / ".pre-commit-config.yaml").write_text((ROOT / ".pre-commit-config.yaml").read_text())
    git(r, "add", ".pre-commit-config.yaml")
    git(r, "commit", "-q", "-m", "base")
    return r


def add(r: Path, rel: str, text: str = "x", commit: bool = True) -> None:
    p = r / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    git(r, "add", "-f", "--", rel)
    if commit:
        git(r, "commit", "-q", "-m", f"add {rel}")


def link(r: Path, rel: str, target: str) -> None:
    p = r / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.symlink_to(target)
    git(r, "add", "-f", "--", rel)
    git(r, "commit", "-q", "-m", f"link {rel}")


# ---- one source of truth -------------------------------------------------------------------------------------------

def test_the_pattern_is_the_pre_commit_hooks_own():
    doc = yaml.safe_load((ROOT / ".pre-commit-config.yaml").read_text())
    hooks = [h for r in doc["repos"] for h in r["hooks"] if h["id"] == "check-restricted"]
    assert len(hooks) == 1 and hooks[0]["language"] == "fail"
    assert guard.load_pattern(ROOT / ".pre-commit-config.yaml").pattern == hooks[0]["files"]
    assert hooks[0]["files"].startswith("(?i)")                 # the hook is case-insensitive; so is the check


def test_ci_runs_the_guard_in_the_required_test_job_with_the_full_history():
    wf = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text())
    steps = wf["jobs"]["test"]["steps"]
    assert steps[0]["uses"].startswith("actions/checkout@") and steps[0]["with"]["fetch-depth"] == 0
    runs = [s for s in steps if "check_restricted_paths.py" in str(s.get("run", ""))]
    assert len(runs) == 1 and "--base" in runs[0]["run"]
    # it runs before the slower steps, so a leak fails fast
    assert steps.index(runs[0]) < next(i for i, s in enumerate(steps) if s.get("name") == "Unit tests")


def test_a_changed_hook_pattern_changes_the_check(tmp_path):
    r = repo(tmp_path)
    add(r, "secret/notes.md")
    assert guard.check(r) == []
    cfg = (r / ".pre-commit-config.yaml").read_text().replace("|^KILL$)", "|^KILL$|^secret/)")
    (r / ".pre-commit-config.yaml").write_text(cfg)
    assert guard.check(r) == ["secret/notes.md"]


def test_a_missing_or_broken_hook_fails_closed(tmp_path):
    cfg = tmp_path / "c.yaml"
    cfg.write_text("repos: []\n")
    with pytest.raises(guard.GuardError):
        guard.load_pattern(cfg)
    cfg.write_text("repos:\n  - repo: local\n    hooks:\n      - id: check-restricted\n        files: '(['\n")
    with pytest.raises(guard.GuardError):
        guard.load_pattern(cfg)
    with pytest.raises(guard.GuardError):
        guard.load_pattern(tmp_path / "absent.yaml")
    assert guard.main(["--root", str(tmp_path)]) == 2                # not a repository, no config: exit 2


# ---- the rule ------------------------------------------------------------------------------------------------------

PATTERN = guard.load_pattern(ROOT / ".pre-commit-config.yaml")


@pytest.mark.parametrize("path", ["knowledge/a.md", "data/live/journal.jsonl", "var/alerts/state.json",
                                  "logs/routine_20261112.log", "build/x", ".env", ".env.local", "KILL",
                                  "research/specs/report.pdf", "Knowledge/a.md", "DATA/x", "Var/y", "docs/Notes.PDF",
                                  ".ENV", "kill", "KNOWLEDGE/sub/Deep/file.md", "research/Deep/Course.Pdf"])
def test_restricted_paths(path):
    assert guard.restricted(PATTERN, path), path


@pytest.mark.parametrize("path", [".env.example", "src/wt/data/loader.py", "docs/knowledge.md", "pdf/readme.md",
                                  "research/notes.pdf.md", "KILL.md", "variables/x", "datasets/a", "README.md"])
def test_allowed_paths(path):
    assert not guard.restricted(PATTERN, path), path


def test_a_clean_tree_passes_and_an_empty_tree_passes(tmp_path, capsys):
    r = tmp_path / "empty"
    r.mkdir()
    git(r, "init", "-q", "-b", "main")
    (r / ".pre-commit-config.yaml").write_text((ROOT / ".pre-commit-config.yaml").read_text())
    assert guard.check(r) == []                                      # nothing tracked at all
    assert guard.main(["--root", str(r)]) == 0
    r2 = repo(tmp_path)
    add(r2, "src/a.py")
    add(r2, ".env.example")
    assert guard.main(["--root", str(r2)]) == 0 and "clean" in capsys.readouterr().out


def test_a_tracked_restricted_file_fails_and_only_its_path_is_printed(tmp_path, capsys):
    r = repo(tmp_path)
    add(r, "knowledge/lesson.md", "RESTRICTED-CONTENT-MARKER")
    add(r, "Data/Live/x.json", "{}")
    assert guard.main(["--root", str(r)]) == 1
    out = capsys.readouterr().out
    assert "knowledge/lesson.md" in out and "Data/Live/x.json" in out
    assert "RESTRICTED-CONTENT-MARKER" not in out                    # paths only, never contents


def test_a_path_that_differs_only_in_case(tmp_path):
    r = repo(tmp_path)
    add(r, "KnOwLeDgE/x.md")
    add(r, "docs/scan.PdF")
    assert guard.check(r) == ["KnOwLeDgE/x.md", "docs/scan.PdF"]


def test_a_file_added_and_deleted_again_inside_the_change_still_fails(tmp_path):
    r = repo(tmp_path)
    base = git(r, "rev-parse", "HEAD").strip()
    add(r, "var/state.json")
    git(r, "rm", "-q", "--cached", "var/state.json")
    git(r, "commit", "-q", "-m", "drop it again")
    assert guard.check(r) == []                                      # HEAD alone looks clean ...
    assert guard.check(r, base) == ["var/state.json"]                # ... the branch's history does not


def test_a_rename_into_a_restricted_path_fails(tmp_path):
    r = repo(tmp_path)
    add(r, "notes/a.md", "some text that is long enough to be detected as the same file\n" * 5)
    base = git(r, "rev-parse", "HEAD").strip()
    (r / "logs").mkdir()
    git(r, "mv", "notes/a.md", "logs/a.md")
    git(r, "commit", "-q", "-m", "move")
    assert guard.check(r, base) == ["logs/a.md"]


def test_a_symlink_to_a_restricted_path_fails(tmp_path):
    r = repo(tmp_path)
    link(r, "docs/k", "../knowledge")                                # a directory
    link(r, "docs/j.json", "../data/live/journal.jsonl")             # a file
    link(r, "docs/abs", "/home/wt/trading/var/alerts/state.json")    # leaves the repository
    link(r, "docs/ok", "../README.md")
    bad = guard.check(r)
    assert bad == ["docs/abs -> (a restricted path)", "docs/j.json -> (a restricted path)",
                   "docs/k -> (a restricted path)"]
    assert all("home/wt" not in b for b in bad)                       # the target itself is not printed


def test_a_symlink_added_in_the_range_is_checked_too(tmp_path):
    r = repo(tmp_path)
    base = git(r, "rev-parse", "HEAD").strip()
    link(r, "a/k", "../Knowledge/x.md")
    git(r, "rm", "-q", "--cached", "a/k")
    git(r, "commit", "-q", "-m", "drop the link")
    assert guard.check(r) == [] and guard.check(r, base) == ["a/k -> (a restricted path)"]


def test_a_bad_base_fails_closed(tmp_path):
    r = repo(tmp_path)
    with pytest.raises(guard.GuardError):
        guard.check(r, "no-such-revision")
    assert guard.main(["--root", str(r), "--base", "no-such-revision"]) == 2


def test_the_repository_itself_is_clean():
    assert guard.check(ROOT) == []


def test_link_resolution():
    assert guard.link_target("docs/k", "../knowledge") == "knowledge"
    assert guard.link_target("a/b/c", "../../var/x") == "var/x"
    assert guard.link_target("a", "/abs/var/x") == "/abs/var/x"
    assert guard.target_restricted(PATTERN, "/abs/var/x")
    assert guard.target_restricted(PATTERN, "../outside/logs/x")
    assert not guard.target_restricted(PATTERN, "../outside/readme.md")
    assert re.search(PATTERN, "x.pdf")
