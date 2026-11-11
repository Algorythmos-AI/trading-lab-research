"""Fail when a tracked path, or a path a pull request adds or renames, is restricted or runtime material.

    python scripts/check_restricted_paths.py [--base <rev>]

The pattern is the pre-commit hook's own (`.pre-commit-config.yaml`, hook id `check-restricted`, its `files:`
regex), read from that file at run time, so the hook and this check can never disagree. The hook only runs where a
contributor installed it; this check runs in CI's required `test` job, so nothing restricted reaches a public
branch either way.

What it checks, case-insensitively like the hook (the regex carries `(?i)`):
  * every path tracked at HEAD (`git ls-files`);
  * with `--base`, every path added, renamed, changed in type or modified by any commit in `<base>..HEAD`,
    including commits whose file was deleted again later in the same pull request (the branch's history is public
    too), so a symlink retargeted inside the range is seen;
  * a tracked symlink whose target is absolute, or leaves the repository (`..` above the root), wherever it points:
    a checkout elsewhere (a host's `/home/wt/trading/var`) resolves it there. A relative link that stays inside is
    matched on the path it resolves to (`docs/k -> ../knowledge`). At HEAD and in the range.

It prints the offending paths only, never a file's contents. Exit codes: 0 clean, 1 restricted paths found,
2 the check could not run: the config unreadable, PyYAML missing, or git failing (a broken check fails closed).

Out of scope: content. A PDF renamed to another extension, or restricted prose pasted into a tracked file, is not a
path match; gitleaks and review catch secrets and prose, not this check.
"""
from __future__ import annotations

import argparse
import posixpath
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ".pre-commit-config.yaml"
HOOK_ID = "check-restricted"
SYMLINK_MODE = "120000"


class GuardError(Exception):
    """The check could not run: the pattern or git is unreadable."""


def load_pattern(config: Path) -> re.Pattern[str]:
    """The `files:` regex of the `check-restricted` hook. Raises GuardError when it is missing or invalid."""
    try:
        import yaml
    except ImportError as e:
        raise GuardError("PyYAML is not installed") from e
    try:
        doc = yaml.safe_load(config.read_text())
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as e:
        raise GuardError(f"{config.name} unreadable ({e.__class__.__name__})") from e
    hooks = [h for r in (doc or {}).get("repos") or [] for h in (r or {}).get("hooks") or []]
    found = [h for h in hooks if isinstance(h, dict) and h.get("id") == HOOK_ID]
    if len(found) != 1 or not isinstance(found[0].get("files"), str) or not found[0]["files"].strip():
        raise GuardError(f"{config.name}: expected exactly one {HOOK_ID} hook with a files: regex")
    try:
        return re.compile(found[0]["files"])
    except re.error as e:
        raise GuardError(f"{config.name}: the {HOOK_ID} regex does not compile ({e})") from e


def _git(root: Path, *args: str) -> bytes:
    try:
        r = subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        raise GuardError(f"git {args[0]} could not run ({e.__class__.__name__})") from e
    if r.returncode != 0:
        raise GuardError(f"git {args[0]} failed (exit {r.returncode})")
    return r.stdout


def _split(out: bytes) -> list[str]:
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def link_target(link: str, target: str) -> str:
    """Where a symlink at repository path `link` points, as a repository-relative path when it stays inside."""
    if target.startswith("/"):
        return posixpath.normpath(target)
    return posixpath.normpath(posixpath.join(posixpath.dirname(link), target))


def restricted(pattern: re.Pattern[str], path: str) -> bool:
    """The hook's test on one repository path, exactly as pre-commit applies it."""
    return bool(pattern.search(path))


def _as_target(pattern: re.Pattern[str], path: str) -> bool:
    """A symlink target may be a directory: `knowledge` (the directory) counts like a file inside it."""
    return restricted(pattern, path) or (bool(path) and restricted(pattern, path.rstrip("/") + "/x"))


def leaves_repo(resolved: str) -> bool:
    """An absolute target, or one that climbs above the repository's root."""
    parts = [p for p in resolved.split("/") if p not in ("", ".")]
    return resolved.startswith("/") or bool(parts and parts[0] == "..")


def target_restricted(pattern: re.Pattern[str], resolved: str) -> bool:
    """A relative target that stays inside the repository, matched on the path it resolves to."""
    parts = [p for p in resolved.split("/") if p not in ("", ".")]
    return not leaves_repo(resolved) and _as_target(pattern, "/".join(parts))


def tracked(root: Path) -> list[tuple[str, str, str]]:
    """(mode, blob, path) for every tracked path."""
    out = []
    for rec in _split(_git(root, "ls-files", "-s", "-z")):
        meta, _, path = rec.partition("\t")
        mode, blob, _stage = meta.split(" ")
        out.append((mode, blob, path))
    return out


def added_in_range(root: Path, base: str) -> list[tuple[str, str, str]]:
    """(mode, blob, path) for every path added, renamed (its new name), changed in type or modified by any commit
    in base..HEAD: a modification of a symlink is a retarget."""
    fields = _split(_git(root, "log", "--format=", "--raw", "--no-abbrev", "-M", "--diff-filter=ARTM", "-z",
                         f"{base}..HEAD"))
    out: list[tuple[str, str, str]] = []
    i = 0
    while i < len(fields):
        meta = fields[i].lstrip("\n").split(" ")
        if len(meta) < 5 or not meta[0].startswith(":"):
            i += 1
            continue
        mode, blob, status = meta[1], meta[3], meta[4]
        if status.startswith("R"):                 # renamed: old path, new path
            out.append((mode, blob, fields[i + 2]))
            i += 3
        else:
            out.append((mode, blob, fields[i + 1]))
            i += 2
    return out


def offending(root: Path, pattern: re.Pattern[str], entries: Iterable[tuple[str, str, str]]) -> list[str]:
    """The paths that are restricted, or symlinks that point at a restricted path (reported as `link -> target`)."""
    bad: set[str] = set()
    for mode, blob, path in entries:
        if restricted(pattern, path):
            bad.add(path)
        elif mode == SYMLINK_MODE:
            target = _git(root, "cat-file", "blob", blob).decode("utf-8", "surrogateescape")
            resolved = link_target(path, target)
            if leaves_repo(resolved):
                bad.add(f"{path} -> (a target outside the repository)")
            elif target_restricted(pattern, resolved):
                bad.add(f"{path} -> (a restricted path)")
    return sorted(bad)


def check(root: Path, base: str | None = None, config: Path | None = None) -> list[str]:
    pattern = load_pattern(config or root / CONFIG)
    entries = tracked(root)
    if base:
        entries += added_in_range(root, base)
    return offending(root, pattern, entries)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="check_restricted_paths.py", description=__doc__.splitlines()[0])
    ap.add_argument("--base", help="also check every path added or renamed in <base>..HEAD")
    ap.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    try:
        bad = check(Path(a.root), a.base)
    except GuardError as e:
        print(f"restricted-path check could not run: {e}", file=sys.stderr)
        return 2
    if bad:
        print(f"{len(bad)} restricted or runtime path(s) are tracked or added (AGENTS.md, Data classes):")
        print("\n".join(f"  {p}" for p in bad))
        return 1
    print("restricted-path check: clean" + (f" (HEAD and {a.base}..HEAD)" if a.base else " (HEAD)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
