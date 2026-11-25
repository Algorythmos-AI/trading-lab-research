#!/usr/bin/env python
"""Write the dashboard's synthetic Reference Registry fixtures from a made-up repository.

    python scripts/gen_registry_fixture.py            # write dashboard/test/fixtures/registry.*.v1.json
    python scripts/gen_registry_fixture.py --check    # exit 1 when the committed fixtures differ

The staging site and the dashboard's tests read only these files, never the real index (AGENTS.md: staging shows
synthetic data). Every record here is invented (ids 9001 upward, no real record's text). The repository is built in
a temporary folder with fixed dates and author, so the commit SHAs, and so the fixtures, come out the same every time.
The same history is the builder's own test case for renames, deletions and duplicates (tests/unit/test_registry.py).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from wt.research import registry  # noqa: E402

OUT = ROOT / "dashboard" / "test" / "fixtures"
REPO = "example/registry-fixture"


def dec(n: str, status: str, head: str = "") -> str:
    return f"# DEC-{n}: synthetic decision {n}\n\n- **Status: {status}**\n{head}\n## Why\n\nSynthetic text.\n"


def hyp(n: str, status: str, extra: str = "") -> str:
    return f"id: HYP-{n}\nstatus: {status}\nfamily: Z\nstatement: \"synthetic\"\n{extra}"


POLICY = '{\n  "prose": false\n}\n'
REGISTRY = ("history:\n  - {decision: DEC-9001, total: 3, status: accepted}\nfamilies:\n  Z:\n"
            "    - {decision: DEC-9001, total: 2, status: accepted}\n    - {decision: DEC-9004, total: 3, status: proposed}\n")

# Each step is (message, {path: text or None to delete}, [(old, new) renames]). Messages are never read by the builder.
STEPS: list[tuple[str, dict[str, str | None], list[tuple[str, str]]]] = [
    ("seed", {
        "dashboard/src/lib/registry-policy.json": POLICY,
        "config/trial_registry.yaml": REGISTRY,
        "research/decisions/DEC-9001-first.md": dec("9001", "ACCEPTED on 2026-10-01", "- **Experiment:** EXP-9001.\n"),
        "research/decisions/DEC-9002-second.md": dec("9002", "PROPOSED on 2026-10-02"),
        "research/hypotheses/HYP-9001-ALPHA.yaml": hyp("9001", "pre-registered",
                                                       "evidence: {decision: DEC-9001, experiments: [EXP-9001]}\n"),
        "research/hypotheses/HYP-9002-BETA.yaml": hyp("9002", "falsified", "evidence: {decision: DEC-9001}\n"),
        "research/experiments/EXP-9001-alpha/config.yaml":
            "experiment: EXP-9001\nstatus: registered\ndecision: DEC-9001\nhypotheses: [HYP-9001]\n",
        "research/lessons_learned/LL-9001-a-lesson.md": "# LL-9001\n\nSee DEC-9001.\n",
    }, []),
    ("more", {
        "research/decisions/DEC-9003-third.md": dec(
            "9003", "ACCEPTED on 2026-10-10",
            "- **Depends on:** DEC-9001, HYP-9001.\n- **Amends:** DEC-9001 (one rule).\n"
            "- **Does not amend:** DEC-9002.\n- **Amends nothing.** DEC-9005 stands.\n"),
        "research/experiments/EXP-9002b-beta/config.json": '[{"decision": "DEC-9003"}]\n',
        "research/experiments/EXP-9003-gamma/README.md": "# EXP-9003\n\nNo config yet.\n",
    }, []),
    ("slug rename", {}, [("research/decisions/DEC-9001-first.md", "research/decisions/DEC-9001-first-renamed.md")]),
    ("id rename", {}, [("research/decisions/DEC-9002-second.md", "research/decisions/DEC-9004-second.md")]),
    ("id rename fix", {"research/decisions/DEC-9004-second.md": dec("9004", "WITHDRAWN on 2026-10-20")}, []),
    ("delete", {"research/hypotheses/HYP-9002-BETA.yaml": None}, []),
    ("trouble", {
        "research/hypotheses/HYP-9003-BROKEN.yaml": "id: HYP-9003\nstatus: [unclosed\nSENTINEL-SECRET-PROSE: x\n",
        "research/hypotheses/HYP-9004-ODD.yaml": hyp("9004", "maybe-someday"),
        "research/hypotheses/HYP-9005-ONE.yaml": hyp("9005", "pre-registered"),
        "research/hypotheses/HYP-9005-TWO.yaml": hyp("9005", "pre-registered"),
        "research/decisions/DEC-9005-fifth.md": dec("9005", "PONDERING on 2026-10-25", "- **Depends on:** DEC-9999.\n"),
        "research/specs/SPEC-9001/spec.md": "SENTINEL-SECRET-PROSE in a spec, never read\n",
    }, []),
]
MAIN_STEPS = 2    # the main branch's fixture is the repository after the first two steps (it lags integration)


def _git(cwd: Path, *args: str, env: dict[str, str]) -> str:
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout


def make_repo(where: Path, steps: int = len(STEPS)) -> list[str]:
    """Build the made-up repository in `where`; returns the commit SHAs, oldest first."""
    base = {**os.environ, "GIT_AUTHOR_NAME": "fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    _git(where, "init", "-q", "-b", "integration", env=base)
    shas = []
    for i, (msg, files, renames) in enumerate(STEPS[:steps]):
        for old, new in renames:
            (where / new).parent.mkdir(parents=True, exist_ok=True)
            _git(where, "mv", old, new, env=base)
        for rel, text in files.items():
            p = where / rel
            if text is None:
                _git(where, "rm", "-q", rel, env=base)
                continue
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
            _git(where, "add", rel, env=base)
        stamp = f"2026-10-{i + 1:02d}T12:00:00+00:00"
        _git(where, "commit", "-q", "-m", msg, env={**base, "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp})
        shas.append(_git(where, "rev-parse", "HEAD", env=base).strip())
    return shas


def fixture(branch: str, steps: int) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        where = Path(tmp)
        shas = make_repo(where, steps)
        index = registry.build(where, branch=branch, sha=shas[-1], as_of=registry.commit_time(where, shas[-1]),
                               built_at=f"2026-10-{steps:02d}T12:05:00Z", repo=REPO)
        return registry.encode(index)


def outputs() -> dict[Path, bytes]:
    return {OUT / "registry.integration.v1.json": fixture("integration", len(STEPS)) + b"\n",
            OUT / "registry.main.v1.json": fixture("main", MAIN_STEPS) + b"\n"}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true")
    a = p.parse_args(argv)
    stale = []
    for path, body in outputs().items():
        if a.check:
            if not path.is_file() or path.read_bytes() != body:
                stale.append(path.name)
        else:
            path.write_bytes(body)
    if stale:
        print("stale registry fixtures (run python scripts/gen_registry_fixture.py): " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
