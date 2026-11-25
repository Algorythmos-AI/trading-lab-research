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


# ---- what runs, and where it is set: docs/operations/jobs.md, docs/architecture.md, docs/reference/env-vars.md ----

JOBS_BEGIN = "<!-- jobs:begin (generated from wt.ops.schedule.JOBS; checked by tests/unit/test_docs_truth.py) -->"
JOBS_END = "<!-- jobs:end -->"


def jobs_table() -> str:
    """The job table as docs/operations/jobs.md must hold it, rendered from the schedule itself."""
    from wt.ops.schedule import JOBS
    rows = ["| Unit | When | Runs | `MODE` | Gated | Desk | What it does |", "|---|---|---|---|---|---|---|"]
    for j in JOBS.values():
        when = f"{j.et} New York" if j.et else "; ".join(j.calendars)
        cmd = " ".join(j.command).replace("|", "\\|")
        rows.append(f"| `wt-{j.name}` | {when} | `python {cmd}` | {j.mode} | {'yes' if j.trading else 'no'} | "
                    f"{j.desk} | {j.what.replace('|', '/')} |")
    return "\n".join([JOBS_BEGIN, *rows, JOBS_END])


def between(text: str, begin: str, end: str) -> str:
    assert begin in text and end in text, f"markers missing: {begin} … {end}"
    return text[text.index(begin):text.index(end) + len(end)]


def first_column(block: str) -> set[str]:
    """The backticked names in the first column of a markdown table."""
    out = set()
    for line in block.splitlines():
        cells = line.split("|")
        if len(cells) > 2:
            out |= set(re.findall(r"`([^`]+)`", cells[1]))
    return out


def test_the_job_table_is_the_schedule():
    doc = (ROOT / "docs" / "operations" / "jobs.md").read_text(encoding="utf-8")
    want = jobs_table()
    got = between(doc, JOBS_BEGIN, JOBS_END)
    assert got == want, ("docs/operations/jobs.md no longer matches wt.ops.schedule.JOBS. Replace the block between "
                         "the jobs markers with:\n\n" + want)


def test_the_static_unit_list_is_the_unit_folder():
    doc = (ROOT / "docs" / "operations" / "jobs.md").read_text(encoding="utf-8")
    listed = first_column(between(doc, "<!-- units:begin", "<!-- units:end -->"))
    files = {p.name for p in (ROOT / "deploy" / "oci" / "systemd").iterdir()
             if p.is_file() and p.suffix in (".service", ".timer")}
    assert listed == files, (f"docs/operations/jobs.md, the units table: add {sorted(files - listed)}, "
                             f"remove {sorted(listed - files)}")


def test_the_package_map_is_the_package():
    doc = (ROOT / "docs" / "architecture.md").read_text(encoding="utf-8")
    listed = first_column(between(doc, "<!-- packages:begin", "<!-- packages:end -->"))
    packages = {p.name for p in (ROOT / "src" / "wt").iterdir() if (p / "__init__.py").is_file()}
    assert listed == packages, (f"docs/architecture.md, the package table: add {sorted(packages - listed)}, "
                                f"remove {sorted(listed - packages)}")


ENV_READS = (re.compile(r"""os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']"""),
             re.compile(r"""\benv\(\s*["']([A-Z][A-Z0-9_]+)["']"""),                   # wt.core.config.env("NAME")
             re.compile(r"""getenv\(\s*["']([A-Z][A-Z0-9_]+)["']"""),
             re.compile(r"""environ\.get\(\s*["']([A-Z][A-Z0-9_]+)["']"""),
             re.compile(r"""\b(?:e|env)\.get\(\s*["']([A-Z][A-Z0-9_]+)["']"""),
             re.compile(r"""\b(?:e|env)\[\s*["']([A-Z][A-Z0-9_]+)["']\]"""),
             re.compile(r"""process\.env\.([A-Z][A-Z0-9_]+)"""),
             re.compile(r"""process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]"""))
ENV_SOURCES = (("src", ".py"), ("scripts", ".py"), ("dashboard/src", ".ts"), ("dashboard/src", ".tsx"))


def env_reads() -> dict[str, str]:
    """Every environment variable the code reads by a literal name, and one file that reads it."""
    out: dict[str, str] = {}
    for folder, suffix in ENV_SOURCES:
        for p in sorted((ROOT / folder).rglob(f"*{suffix}")):
            if "node_modules" in p.parts:
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
            for rx in ENV_READS:
                for name in rx.findall(text):
                    out.setdefault(name, rel(p))
    return out


def env_example_names() -> set[str]:
    text = (ROOT / ".env.example").read_text(encoding="utf-8")
    return set(re.findall(r"^\s*#?\s*([A-Z][A-Z0-9_]+)=", text, re.M))


def test_every_env_var_the_code_reads_is_documented():
    doc = (ROOT / "docs" / "reference" / "env-vars.md").read_text(encoding="utf-8")
    documented = set(re.findall(r"`([A-Z][A-Z0-9_]+)`", doc))
    reads = env_reads()
    missing = sorted(n for n in reads if n not in documented)
    assert reads, "the scan found no environment reads: its patterns are broken"
    assert not missing, ("add these to docs/reference/env-vars.md (name, who reads it, where it is set):\n  " +
                         "\n  ".join(f"{n}  (read in {reads[n]})" for n in missing))


def test_every_name_in_the_env_example_is_documented():
    doc = (ROOT / "docs" / "reference" / "env-vars.md").read_text(encoding="utf-8")
    documented = set(re.findall(r"`([A-Z][A-Z0-9_]+)`", doc))
    missing = sorted(env_example_names() - documented)
    assert not missing, f"add these .env.example names to docs/reference/env-vars.md: {missing}"


def fetched_names() -> set[str]:
    """The names wt-fetch-secrets passes from the host's secrets file to the jobs (its REQUIRED and OPTIONAL)."""
    text = (ROOT / "deploy" / "oci" / "bin" / "wt-fetch-secrets").read_text(encoding="utf-8")
    out: set[str] = set()
    for name in ("REQUIRED", "OPTIONAL"):
        m = re.search(rf"^{name}=\((.*?)\)", text, re.S | re.M)
        assert m, f"wt-fetch-secrets: no {name}=(...) list"
        out |= set(m.group(1).split())
    return out


def test_host_secrets_rows_are_what_the_host_passes_to_the_jobs():
    """A name the page says is a host secret must be one wt-fetch-secrets copies into the jobs' environment, and
    every name it copies must be on the page as one."""
    doc = (ROOT / "docs" / "reference" / "env-vars.md").read_text(encoding="utf-8")
    said = set()
    for line in doc.splitlines():
        cells = line.split("|")
        if len(cells) > 3 and "Host secrets" in cells[-2]:
            said |= set(re.findall(r"`([A-Z][A-Z0-9_]+)`", cells[1]))
    passed = fetched_names()
    assert said == passed, ("docs/reference/env-vars.md and deploy/oci/bin/wt-fetch-secrets disagree on the host's "
                            f"secrets: mark as \"Host secrets\" {sorted(passed - said)}; not passed to jobs "
                            f"{sorted(said - passed)}")
