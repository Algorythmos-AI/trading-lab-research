"""Run manifests (DEC-0011) against a throwaway git repository; no market data is read."""
import hashlib
import json
import os
import subprocess

import pytest

from wt.research import manifest as mf


def git(root, *args):
    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                    "-c", "commit.gpgsign=false", *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    for rel, text in {"src/pkg/mod.py": "X = 1\n", "scripts/run.py": "print(1)\n", "config/a.yaml": "a: 1\n",
                      "config/generated/b.yaml": "b: 2\n", "requirements.lock.txt": "numpy==2.5.3\n",
                      "research/specs/SPEC-0001-x/spec.yaml": "version: 1\n", "README.md": "r\n"}.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "init")
    data = root / "data" / "minute"
    data.mkdir(parents=True)
    (data / "2024-01-02.parquet").write_bytes(b"x" * 10)
    (data / ".DS_Store").write_bytes(b"junk")
    return root


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_manifest_records_code_config_lockfile_env_and_data(repo, tmp_path):
    run = tmp_path / "EXP-T"
    m = mf.write_manifest(run, {"exp": "EXP-T", "method": "dec0011"}, [repo / "data" / "minute"], root=repo)
    assert json.loads((run / "manifest.json").read_text()) == json.loads(json.dumps(m, default=str))
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert m["git"] == {"sha": head, "dirty": False, "dirty_paths": [], "untracked_code": []}
    assert m["config_sha256"] == {"config/a.yaml": sha(repo / "config/a.yaml"),
                                  "config/generated/b.yaml": sha(repo / "config/generated/b.yaml")}
    assert m["lockfile_sha256"] == {"requirements.lock.txt": sha(repo / "requirements.lock.txt"),
                                    "requirements-dev.lock.txt": None}
    assert m["spec"] == {"id": "SPEC-0001", "sha256": sha(repo / "research/specs/SPEC-0001-x/spec.yaml")}
    assert m["data"]["n_files"] == 1 and m["data"]["bytes"] == 10 and m["data"]["roots"] == ["data/minute"]
    env = m["environment"]
    assert env["n"] == len(env["packages"]) > 0 and len(env["sha256"]) == 64
    assert env["sha256"] == hashlib.sha256("\n".join(env["packages"]).encode()).hexdigest()
    assert m["args"] == {"exp": "EXP-T", "method": "dec0011"} and isinstance(m["argv"], list)
    assert m["python"].startswith("3.12") and m["platform"] and m["created_utc"].endswith("+00:00")


def test_dirty_tracked_code_is_flagged_and_blocks_a_preregistered_run(repo):
    assert mf.assert_clean_for_preregistered_run(repo) == mf.git_sha(repo)
    (repo / "src/pkg/new.py").write_text("Y = 2\n")                     # untracked: recorded, not dirty
    (repo / "README.md").write_text("changed\n")                         # outside src/ scripts/ config/
    m = mf.build_manifest({}, [], root=repo)
    assert m["git"]["dirty"] is False and m["git"]["untracked_code"] == ["src/pkg/new.py"]
    (repo / "scripts/run.py").write_text("print(2)\n")
    (repo / "config/a.yaml").write_text("a: 2\n")
    git(repo, "add", "config/a.yaml")                                    # staged counts as dirty too
    m = mf.build_manifest({}, [], root=repo)
    assert m["git"]["dirty"] is True and m["git"]["dirty_paths"] == ["config/a.yaml", "scripts/run.py"]
    with pytest.raises(mf.DirtyTreeError, match="scripts/run.py"):
        mf.assert_clean_for_preregistered_run(repo)


def test_outside_git_nothing_is_claimed(tmp_path):
    m = mf.build_manifest({}, [], root=tmp_path, spec_id=None)
    assert m["git"]["sha"] is None and m["git"]["dirty"] is None and m["spec"] is None
    with pytest.raises(mf.DirtyTreeError, match="not a git checkout"):
        mf.assert_clean_for_preregistered_run(tmp_path)


def test_data_snapshot_tracks_size_mtime_and_membership(repo):
    d = repo / "data" / "minute"
    f = d / "2024-01-02.parquet"
    a = mf.data_snapshot([d], repo)
    assert a == mf.data_snapshot([d, d], repo)                           # stable, duplicates ignored
    os.utime(f, ns=(f.stat().st_atime_ns, f.stat().st_mtime_ns + 10**9))
    b = mf.data_snapshot([d], repo)
    assert b["sha256"] != a["sha256"]                                    # a rewritten file
    (d / "2024-01-03.parquet").write_bytes(b"y")
    c = mf.data_snapshot([d], repo)
    assert c["sha256"] != b["sha256"] and c["n_files"] == 2              # an added file
    gone = mf.data_snapshot([d, repo / "data" / "pm"], repo)
    assert gone["missing"] == ["data/pm"] and gone["sha256"] != c["sha256"]


def test_environment_hash_ignores_the_tool_that_listed_it(monkeypatch):
    monkeypatch.setattr(mf, "_freeze", lambda: ("pip freeze", ["Pandas==3.0.6", "", "typing_extensions==4.16.0"]))
    a = mf.environment()
    monkeypatch.setattr(mf, "_freeze", lambda: ("importlib.metadata", ["typing-extensions==4.16.0", "pandas==3.0.6"]))
    b = mf.environment()
    assert a["sha256"] == b["sha256"] and a["packages"] == ["pandas==3.0.6", "typing-extensions==4.16.0"]


def test_freeze_falls_back_to_importlib_metadata(monkeypatch):
    monkeypatch.setattr(mf.shutil, "which", lambda name: None)
    monkeypatch.setattr(mf, "_run", lambda cmd: None)                    # no uv, no pip
    source, lines = mf._freeze()
    assert source == "importlib.metadata" and any(x.lower().startswith("numpy==") for x in lines)
