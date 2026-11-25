"""The docs keep up with the code (docs/README.md, "One source of truth").

These tests compare *sets of names* between the docs and the files they describe, never prose. When one fails, its
message names the doc to update. They read files inside the repository only: no network, no git, no clock, no
`.env`, no environment variable.

The host's deploy stage runs this suite too (`-m "not replay"`). It cannot fail there on a commit that passed CI:
CI runs the same tests on Linux, a case-sensitive filesystem like the host's, before anything reaches `main`, and
the tests read nothing but the commit's own files.
"""
from __future__ import annotations

import re
import shlex
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The docs these tests look after. Research records, specs and external material are out of scope: records are
# append-only, and restricted folders are never read here.
DOC_GLOBS = ("*.md", "docs/**/*.md", "config/README.md", "research/README.md", "research/*_SUMMARY.md",
             "research/retired_strategies/README.md", "dashboard/README.md", "dashboard/docs/**/*.md")
# Dated, point-in-time records: their links must resolve, but a command they name may since have been retired.
DATED = ("docs/audits/", "docs/incidents/", "docs/releases/")

FENCE = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1[^\n]*$", re.S | re.M)
CODE_SPAN = re.compile(r"`[^`\n]+`")
LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:")
MAKE = re.compile(r"(?:^|[\s;&|(`$])make((?:[ \t]+[^`;&|)\n]+)+)")


def docs() -> list[Path]:
    seen: dict[Path, None] = {}
    for g in DOC_GLOBS:
        for p in sorted(ROOT.glob(g)):
            if p.is_file() and "node_modules" not in p.parts:
                seen[p] = None
    return list(seen)


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def prose(text: str) -> str:
    """The text with fenced blocks and inline code taken out: links inside code are not links."""
    return CODE_SPAN.sub("", FENCE.sub("", text))


def code(text: str) -> list[str]:
    """Fenced blocks and inline code spans: where a command is written."""
    return [m.group(0) for m in FENCE.finditer(text)] + CODE_SPAN.findall(FENCE.sub("", text))


def exists_exactly(base: Path, target: str) -> bool:
    """True if `target`, relative to `base`, names a file or folder inside the repository with exactly this case
    (the Mac's filesystem ignores case; the host's and CI's do not)."""
    if target.startswith("/"):
        return False
    p = (base / target).resolve()
    if p != ROOT and ROOT not in p.parents:
        return False
    cur = ROOT
    for part in p.relative_to(ROOT).parts:
        if not cur.is_dir() or part not in {c.name for c in cur.iterdir()}:
            return False
        cur = cur / part
    return True


def index_rows(index: Path) -> set[str]:
    """The file names a markdown index links to from its table rows, in its own folder."""
    out = set()
    for line in prose_lines(index):
        if line.lstrip().startswith("|"):
            for t in LINK.findall(line):
                name = t.split("#")[0]
                if name.endswith(".md") and "/" not in name:
                    out.add(name)
    return out


def prose_lines(p: Path) -> list[str]:
    return FENCE.sub("", p.read_text(encoding="utf-8")).splitlines()


def test_the_doc_set_is_found():
    found = {rel(p) for p in docs()}
    assert {"README.md", "AGENTS.md", "docs/README.md", "docs/runbooks/README.md", "docs/adr/README.md"} <= found


def test_every_relative_link_resolves():
    broken = []
    for p in docs():
        for target in LINK.findall(prose(p.read_text(encoding="utf-8"))):
            path = target.split("#")[0]
            if not path or SCHEME.match(path):          # an anchor in the same page, or http:, mailto:, ...
                continue
            if not exists_exactly(p.parent, path):
                broken.append(f"{rel(p)} -> {target}")
    assert not broken, ("broken relative links (fix the link, its case, or the file name; links must stay inside "
                        "the repository):\n  " + "\n  ".join(broken))


def test_the_runbook_index_lists_every_runbook():
    folder = ROOT / "docs" / "runbooks"
    pages = {p.name for p in folder.glob("*.md")} - {"README.md"}
    missing = sorted(pages - index_rows(folder / "README.md"))
    assert not missing, f"add a table row for each of these to docs/runbooks/README.md: {missing}"


def test_the_adr_index_lists_every_record():
    folder = ROOT / "docs" / "adr"
    records = {p.name for p in folder.glob("*.md")} - {"README.md", "0003-not-used.md"}
    missing = sorted(records - index_rows(folder / "README.md"))
    assert not missing, f"add a table row for each of these to docs/adr/README.md: {missing}"


def makefile_targets() -> set[str]:
    out = set()
    for line in (ROOT / "Makefile").read_text(encoding="utf-8").splitlines():
        if m := re.match(r"^([A-Za-z][\w-]*(?:[ \t]+[A-Za-z][\w-]*)*)[ \t]*:(?!=)", line):
            out |= set(m.group(1).split())
    return out


def make_targets_named(snippet: str) -> list[str]:
    """The targets of each `make ...` command in a code snippet (flags, VAR=value and `-C dir` skipped; a command
    that runs another directory's Makefile is left alone)."""
    out = []
    for line in snippet.splitlines():
        if line.lstrip().startswith("#"):                       # a comment in a fenced block, not a command
            continue
        for m in MAKE.finditer(line):
            try:
                words = shlex.split(m.group(1))
            except ValueError:                                  # an unclosed quote: read the plain words
                words = m.group(1).split()
            i, other_dir = 0, False
            while i < len(words):
                w = words[i]
                if w in ("-C", "-f", "--directory", "--file"):
                    other_dir |= i + 1 < len(words) and not words[i + 1].endswith("trading")
                    i += 2
                    continue
                if w.startswith("-") or "=" in w:
                    i += 1
                    continue
                if not re.fullmatch(r"[a-z][a-z0-9-]*", w):
                    break
                if not other_dir:
                    out.append(w)
                i += 1
    return out


def test_every_make_target_a_doc_names_exists():
    """A `make X` written as code (a span or a fenced block) must be a real target, so a page never sends the reader
    to a command that is not there."""
    targets = makefile_targets()
    unknown = set()
    for p in docs():
        if rel(p).startswith(DATED):
            continue
        for snippet in code(p.read_text(encoding="utf-8")):
            unknown |= {f"{rel(p)}: make {t}" for t in make_targets_named(snippet) if t not in targets}
    assert not unknown, "these make targets are not in the Makefile:\n  " + "\n  ".join(sorted(unknown))


def test_the_make_target_reader_reads_commands():
    """The parser above, on the shapes the docs use."""
    assert make_targets_named("make kill DESK=options REASON=\"x\"") == ["kill"]
    assert make_targets_named("sudo -u wt make -C /home/wt/trading unkill") == ["unkill"]
    assert make_targets_named("make -s lint typecheck") == ["lint", "typecheck"]
    assert make_targets_named("STAGE=1 make deploy") == ["deploy"]
    assert make_targets_named("make -C dashboard build") == []
    assert make_targets_named("# make sure the gate is open") == []
    assert make_targets_named('make -C ~/trading reset-latch REASON="what you reviewed and why"') == ["reset-latch"]
