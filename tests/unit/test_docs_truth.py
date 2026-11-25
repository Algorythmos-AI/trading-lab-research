"""The docs keep up with the code (docs/README.md, "One source of truth").

These tests compare *sets of names* between the docs and the files they describe, never prose. When one fails, the
message names the doc to update. They read files only: no network, no git, no clock, no `.env`. The host's deploy
stage runs them too, so they must hold in any checkout of the repository.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The docs these tests look after. Research records, specs and external material are out of scope: records are
# append-only, and restricted folders are never read here.
DOC_GLOBS = ("*.md", "docs/**/*.md", "config/README.md", "research/README.md", "research/*_SUMMARY.md",
             "research/retired_strategies/README.md", "dashboard/README.md", "dashboard/docs/**/*.md")

FENCE = re.compile(r"^```.*?^```", re.S | re.M)
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
CODE_SPAN = re.compile(r"`([^`\n]+)`")
MAKE = re.compile(r"\bmake[ \t]+(?:-[sC][ \t]*(?:\S+[ \t]+)?)*([a-z][a-z0-9-]*)\b")   # one line only


def docs() -> list[Path]:
    seen: dict[Path, None] = {}
    for g in DOC_GLOBS:
        for p in sorted(ROOT.glob(g)):
            if p.is_file() and "node_modules" not in p.parts:
                seen[p] = None
    return list(seen)


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def linked_files(index: Path) -> set[str]:
    """The file names a markdown index links to, in its own folder."""
    text = FENCE.sub("", index.read_text(encoding="utf-8"))
    return {t.split("#")[0] for t in LINK.findall(text) if "/" not in t.split("#")[0] and t.endswith(".md")}


def test_the_doc_set_is_found():
    found = {rel(p) for p in docs()}
    assert {"README.md", "AGENTS.md", "docs/runbooks/README.md", "docs/adr/README.md"} <= found


def test_every_relative_link_resolves():
    broken = []
    for p in docs():
        text = FENCE.sub("", p.read_text(encoding="utf-8"))
        for target in LINK.findall(text):
            path = target.split("#")[0]
            if not path or re.match(r"^[a-z][a-z0-9+.-]*:", path):      # an anchor, or http:, mailto:, ...
                continue
            if not (p.parent / path).exists():
                broken.append(f"{rel(p)} -> {target}")
    assert not broken, "broken relative links (fix the link or the file name):\n  " + "\n  ".join(broken)


def test_the_runbook_index_lists_every_runbook():
    folder = ROOT / "docs" / "runbooks"
    pages = {p.name for p in folder.glob("*.md")} - {"README.md"}
    missing = sorted(pages - linked_files(folder / "README.md"))
    assert not missing, f"add these runbooks to docs/runbooks/README.md: {missing}"


def test_the_adr_index_lists_every_record():
    folder = ROOT / "docs" / "adr"
    records = {p.name for p in folder.glob("*.md")} - {"README.md", "0003-not-used.md"}
    missing = sorted(records - linked_files(folder / "README.md"))
    assert not missing, f"add these ADRs to docs/adr/README.md: {missing}"


def makefile_targets() -> set[str]:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    return {m for line in text.splitlines() for m in re.findall(r"^([a-zA-Z][\w-]*)\s*:(?!=)", line)}


def test_every_make_target_a_doc_names_exists():
    """A `make X` written in code (a span or a fenced block) must be a real target, so a runbook never sends the reader
    to a command that is not there."""
    targets = makefile_targets()
    unknown = []
    for p in docs():
        text = p.read_text(encoding="utf-8")
        code = "\n".join(FENCE.findall(text)) + "\n" + "\n".join(CODE_SPAN.findall(FENCE.sub("", text)))
        for name in MAKE.findall(code):
            if name not in targets:
                unknown.append(f"{rel(p)}: make {name}")
    assert not unknown, "these make targets are not in the Makefile:\n  " + "\n  ".join(sorted(set(unknown)))
