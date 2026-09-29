"""Run manifests (DEC-0011): what produced an experiment's results, so a re-run can be checked for exact
reproducibility and a pre-registered run can prove it ran committed code.

write_manifest() records, next to the results it describes:
  * the git SHA, and whether tracked files under src/ scripts/ config/ differ from it (`dirty`, with the paths)
  * sha256 of the spec (wt.specs.loader.spec_sha256), of every config/**/*.yaml and of the lockfiles
  * a hash of the running interpreter's installed distributions (`uv pip freeze`, else `pip freeze`, else
    importlib.metadata), normalised to sorted name==version lines so the source tool does not change the hash
  * a data-snapshot hash over every data file's path, size and mtime; contents are not read, which keeps it cheap
    on multi-GB caches while still catching rewritten, added or removed files
  * python version, platform, UTC timestamp, argv and the driver's own arguments
It never raises because a tool is missing (the results already exist): an unknown value is recorded as None.
assert_clean_for_preregistered_run() is the strict counterpart for runs that must be traceable to a commit.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from wt.specs.loader import spec_sha256

ROOT = Path(__file__).resolve().parents[3]
CODE_DIRS = ("src", "scripts", "config")
LOCKFILES = ("requirements.lock.txt", "requirements-dev.lock.txt")
MANIFEST = "manifest.json"
SCHEMA = 1


class DirtyTreeError(RuntimeError):
    """The code a run would execute is not exactly a commit, so its results could not be reproduced from a SHA."""


def _run(cmd: list[str]) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def git_sha(root: Path = ROOT) -> str | None:
    out = _run(["git", "-C", str(root), "rev-parse", "HEAD"])
    return out.strip() if out else None


def _status(root: Path, untracked: bool) -> list[str] | None:
    out = _run(["git", "-C", str(root), "status", "--porcelain",
                f"--untracked-files={'all' if untracked else 'no'}", "--", *CODE_DIRS])
    if out is None:
        return None
    lines = [x for x in out.splitlines() if x.strip()]
    return sorted(x[3:] for x in lines if x.startswith("??") == untracked)


def dirty_paths(root: Path = ROOT) -> list[str] | None:
    """Tracked files under src/ scripts/ config/ with staged or unstaged changes; None outside a git checkout."""
    return _status(root, untracked=False)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _rel(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def spec_hash(spec_id: str, root: Path = ROOT) -> str | None:
    """sha256 of the spec's spec.yaml: the loader's own hash for this checkout, the same file under another root."""
    try:
        if root.resolve() == ROOT.resolve():
            return spec_sha256(spec_id)
        hits = sorted((root / "research" / "specs").glob(f"{spec_id}-*/spec.yaml"))
        return sha256_file(hits[0]) if len(hits) == 1 else None
    except FileNotFoundError:
        return None


def config_hashes(root: Path = ROOT) -> dict[str, str]:
    """Every YAML under config/, keyed by repo-relative path: the drivers read several (ranking, catalysts, the
    generated spec configs, the trial registry), and hashing all of them costs nothing."""
    base = root / "config"
    return {_rel(p, root): sha256_file(p) for p in sorted(base.rglob("*.yaml"))} if base.is_dir() else {}


def lockfile_hashes(root: Path = ROOT) -> dict[str, str | None]:
    return {n: sha256_file(root / n) if (root / n).is_file() else None for n in LOCKFILES}


def _freeze() -> tuple[str, list[str]]:
    """This interpreter's installed distributions as (source, lines)."""
    uv = shutil.which("uv")
    if uv:
        out = _run([uv, "pip", "freeze", "--python", sys.executable])
        if out is not None:
            return "uv pip freeze", out.splitlines()
    out = _run([sys.executable, "-m", "pip", "freeze"])
    if out is not None:
        return "pip freeze", out.splitlines()
    return "importlib.metadata", [f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions()]


def _canonical(line: str) -> str:
    name, sep, rest = line.strip().partition("==")
    return f"{re.sub(r'[-_.]+', '-', name).lower()}=={rest}" if sep else line.strip()


def environment() -> dict[str, Any]:
    source, lines = _freeze()
    pkgs = sorted({_canonical(x) for x in lines if x.strip() and not x.lstrip().startswith("#")})
    return {"source": source, "n": len(pkgs), "sha256": hashlib.sha256("\n".join(pkgs).encode()).hexdigest(),
            "packages": pkgs}


def data_snapshot(paths: list[Path], root: Path = ROOT) -> dict[str, Any]:
    """Hash of every file under `paths` (files or directories, dotfiles skipped) as sorted path/size/mtime_ns lines.
    Missing paths are listed and hashed too, so "no cache yet" and "empty cache" differ."""
    files: dict[str, tuple[int, int]] = {}
    missing = []
    for p in map(Path, paths):
        if p.is_file():
            found = [p]
        elif p.is_dir():
            found = [f for f in p.rglob("*") if f.is_file() and not any(x.startswith(".") for x in f.relative_to(p).parts)]
        else:
            missing.append(_rel(p, root))
            continue
        for f in found:
            st = f.stat()
            files[_rel(f, root)] = (st.st_size, st.st_mtime_ns)
    lines = [f"{k}\t{s}\t{m}" for k, (s, m) in sorted(files.items())] + [f"MISSING\t{k}" for k in sorted(set(missing))]
    return {"sha256": hashlib.sha256("\n".join(lines).encode()).hexdigest(), "n_files": len(files),
            "bytes": sum(s for s, _ in files.values()), "roots": sorted({_rel(Path(p), root) for p in paths}),
            "missing": sorted(set(missing))}


def build_manifest(args: dict[str, Any], data_paths: list[Path], root: Path = ROOT,
                   spec_id: str | None = "SPEC-0001") -> dict[str, Any]:
    dirty = dirty_paths(root)
    return {
        "schema": SCHEMA,
        "created_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "argv": list(sys.argv),
        "args": args,
        "git": {"sha": git_sha(root), "dirty": None if dirty is None else bool(dirty), "dirty_paths": dirty,
                "untracked_code": _status(root, untracked=True)},
        "spec": {"id": spec_id, "sha256": spec_hash(spec_id, root)} if spec_id else None,
        "config_sha256": config_hashes(root),
        "lockfile_sha256": lockfile_hashes(root),
        "environment": environment(),
        "data": data_snapshot(data_paths, root),
        "python": platform.python_version(),
        "platform": platform.platform(),
    }


def write_manifest(run_dir: Path, args: dict[str, Any], data_paths: list[Path], *, name: str = MANIFEST,
                   root: Path = ROOT, spec_id: str | None = "SPEC-0001") -> dict[str, Any]:
    """Write <run_dir>/<name> (atomically) and return it. `name` lets one run directory hold one manifest per
    output, e.g. results_F.json and results_P.json written by two invocations."""
    manifest = build_manifest(args, data_paths, root, spec_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    tmp = run_dir / f".{name}.tmp"
    tmp.write_text(json.dumps(manifest, indent=1, sort_keys=True, default=str) + "\n")
    os.replace(tmp, run_dir / name)
    return manifest


def assert_clean_for_preregistered_run(root: Path = ROOT) -> str:
    """The commit SHA a pre-registered run executes; raises DirtyTreeError if tracked code under src/ scripts/
    config/ differs from it, or if the checkout is not a git repository at all."""
    sha, dirty = git_sha(root), dirty_paths(root)
    if sha is None or dirty is None:
        raise DirtyTreeError(f"{root} is not a git checkout: a pre-registered run must be traceable to a commit")
    if dirty:
        more = f" (+{len(dirty) - 10} more)" if len(dirty) > 10 else ""
        raise DirtyTreeError(f"tracked code differs from {sha[:12]}: {', '.join(dirty[:10])}{more}; commit it first")
    return sha
