"""The Reference Registry's index: every research record, built from the repository in CI (scripts/build_registry.py).

One index per branch (integration, main), stamped with the commit it was built from. The dashboard compares that
commit with the branch head, so the page can say whether what it shows is current (dashboard/README.md, "Reference
Registry"). This module only reads: the record files at the working tree and, for history, `git log`.

What the index may carry is set by one constant, `dashboard/src/lib/registry-policy.json` (AGENTS.md, data classes).
While its `prose` is false the index holds SAFE fields only: ids, kinds, closed status codes, dates, commit SHAs,
counts and typed links between ids. No title, no sentence of a record, no file path (paths carry title slugs).

Nothing here prints or returns record text: every error is a code, an id and at most an exception's class name.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

SCHEMA = "stocksdelta/registry"
SCHEMA_VERSION = 1
BRANCHES = ("integration", "main")
MAX_BYTES = 3_000_000          # under the ingest's 3.5 MB body cap (dashboard/src/lib/ingest.ts MAX_BODY_BYTES)
MAX_FILE_BYTES = 2_000_000     # a record file larger than this is not read (issue `unreadable`)
POLICY_PATH = Path("dashboard/src/lib/registry-policy.json")

# The folders whose files are records. Nothing under research/specs/ or research/external/ is ever read (NOTICE.md).
RECORD_DIRS = {
    "dec": "research/decisions",
    "hyp": "research/hypotheses",
    "exp": "research/experiments",
    "ll": "research/lessons_learned",
}
TRIAL_REGISTRY = "config/trial_registry.yaml"

# One id grammar for every kind: four digits, an optional letter (EXP-0005b, EXP-0015a), or the debug experiment.
_ID = r"(?:DEC|HYP|EXP|LL)-(?:DEBUG-\d{4}|\d{4}[a-z]?)"
ID_RE = re.compile(rf"(?<![A-Za-z0-9])({_ID})(?![0-9])")
_PREFIX = {"dec": "DEC", "hyp": "HYP", "exp": "EXP", "ll": "LL"}
_NAME_RE = {k: re.compile(rf"^({p}-(?:DEBUG-\d{{4}}|\d{{4}}[a-z]?))(?:[-_.]|$)") for k, p in _PREFIX.items()}

DEC_STATUSES = ("accepted", "proposed", "withdrawn", "superseded", "not_used", "in_effect", "recorded")
HYP_STATUSES = ("pre_registered", "falsified", "withdrawn", "supported", "closed")
EXP_STATUSES = ("proposed", "registered", "running", "complete", "withdrawn", "no_status", "no_config")
STATUSES = tuple(dict.fromkeys(DEC_STATUSES + HYP_STATUSES + EXP_STATUSES + ("unparsed",)))

EDGE_TYPES = ("depends_on", "amends", "supersedes", "superseded_by", "experiment", "evidence", "hypothesis",
              "decision", "base", "family", "mentions")
ISSUE_CODES = ("duplicate-id", "id-mismatch", "yaml-error", "unreadable", "unparsed-status", "history-unavailable",
               "dangling-ref")

# The labelled lines at the head of a decision record, and the edge each gives. Matched at the start of a bullet,
# so "Does not amend" and "Amends nothing" never become an edge (they are listed so the test can say so).
_DEC_LABELS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^depends on\b"), "depends_on"),
    (re.compile(r"^amends\b(?!\s+nothing)"), "amends"),
    (re.compile(r"^supersedes\b"), "supersedes"),
    (re.compile(r"^superseded by\b"), "superseded_by"),
    (re.compile(r"^experiments?\b"), "experiment"),
    (re.compile(r"^evidence\b"), "evidence"),
    (re.compile(r"^trials?\b"), "hypothesis"),
)
_BULLET_RE = re.compile(r"^- \*\*([^*]+?)\*\*")
_STATUS_RE = re.compile(r"^- \*\*Status:(?:\*\*)?\s*([^*\n]*)")
_DATE_RE = re.compile(r"\b(20\d\d-\d\d-\d\d)\b")


class RegistryError(Exception):
    """A refusal to build or send. Its text is a code and never carries record content."""


@dataclass
class Edge:
    type: str
    to: str


@dataclass
class Record:
    id: str
    kind: str
    status: str
    status_date: str | None = None
    family: str | None = None
    files: int = 1
    conflict: bool = False
    has_results: bool | None = None
    has_report: bool | None = None
    edges: list[Edge] = field(default_factory=list)
    first_seen: dict[str, str] | None = None
    last_changed: dict[str, str] | None = None
    path_renames: int = 0


@dataclass
class Issue:
    code: str
    id: str | None = None
    to: str | None = None


# ---- policy ----------------------------------------------------------------------------------------------------

def read_policy(root: Path) -> dict[str, Any]:
    """The one gate (AGENTS.md data classes). Missing or unreadable is refused, never read as "prose off"."""
    try:
        data = json.loads((root / POLICY_PATH).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise RegistryError(f"policy-unreadable ({e.__class__.__name__})") from None
    if not isinstance(data, dict) or not isinstance(data.get("prose"), bool):
        raise RegistryError("policy-malformed")
    if data["prose"]:
        # Prose needs its own pull request (the RECORD class, the denylist exemption and the extraction with its
        # caps). Until that lands the builder refuses rather than send what it has no rule for.
        raise RegistryError("prose-not-built")
    return data


# ---- reading records -------------------------------------------------------------------------------------------

def id_of(kind: str, name: str) -> str | None:
    """The id a record file (or an experiment's folder) is named for, or None when the name is not a record's."""
    m = _NAME_RE[kind].match(name)
    return m.group(1) if m else None


def _read(p: Path) -> str | None:
    try:
        if p.stat().st_size > MAX_FILE_BYTES:
            return None
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _ids(text: str, own: str | None = None) -> list[str]:
    return list(dict.fromkeys(i for i in ID_RE.findall(text) if i != own))


def _edges_from(pairs: Iterable[tuple[str, str]]) -> list[Edge]:
    seen: set[tuple[str, str]] = set()
    out: list[Edge] = []
    for t, to in pairs:
        if (t, to) not in seen:
            seen.add((t, to))
            out.append(Edge(t, to))
    return out


def dec_status(text: str) -> tuple[str, str | None]:
    """A decision's status code and date from its head. No status line at all is the oldest records' form: `recorded`
    with its `Date:` line. A status line that names no known word is `unparsed`."""
    head = text.splitlines()[:20]
    for line in head:
        m = _STATUS_RE.match(line)
        if not m:
            continue
        words = m.group(1).strip().upper()
        dm = _DATE_RE.search(m.group(1))
        date = dm.group(1) if dm else None
        for word, code in (("NOT USED", "not_used"), ("SUPERSEDED", "superseded"), ("WITHDRAWN", "withdrawn"),
                           ("PROPOSED", "proposed"), ("ACCEPTED", "accepted"), ("IN EFFECT", "in_effect")):
            if words.startswith(word):
                return code, date
        return "unparsed", date
    dm = _DATE_RE.search("\n".join(head))
    return "recorded", dm.group(1) if dm else None


def dec_edges(text: str, own: str) -> list[Edge]:
    """Typed links from the labelled bullets before the first section, then every other id the record names."""
    pairs: list[tuple[str, str]] = []
    lines = text.splitlines()
    head_end = next((i for i, ln in enumerate(lines) if ln.startswith("## ")), len(lines))
    current: str | None = None
    for ln in lines[1:head_end]:
        b = _BULLET_RE.match(ln)
        if b:
            label = b.group(1).strip().rstrip(":.").strip().lower()
            current = next((t for rx, t in _DEC_LABELS if rx.match(label)), None)
            if label.startswith("status"):
                current = None
        elif not ln.startswith("  ") or not ln.strip():
            current = None
        if current:
            pairs.extend((current, i) for i in _ids(ln, own))
    typed = {to for _, to in pairs}
    pairs.extend(("mentions", i) for i in _ids(text, own) if i not in typed)
    return _edges_from(pairs)


_HYP_STATUS = {"pre-registered": "pre_registered", "pre_registered": "pre_registered", "falsified": "falsified",
               "withdrawn": "withdrawn", "supported": "supported", "closed": "closed"}
_EXP_STATUS = {s: s for s in EXP_STATUSES if s not in ("no_config", "no_status")}


def _ids_in(value: Any, own: str) -> list[str]:
    if isinstance(value, str):
        return _ids(value, own)
    if isinstance(value, Mapping):
        return [i for v in value.values() for i in _ids_in(v, own)]
    if isinstance(value, list):
        return [i for v in value for i in _ids_in(v, own)]
    return []


def hyp_record(rid: str, data: Any, text: str) -> tuple[Record, list[Issue]]:
    issues: list[Issue] = []
    if not isinstance(data, Mapping):
        return Record(rid, "hyp", "unparsed"), [Issue("yaml-error", rid)]
    if str(data.get("id", rid)) != rid:
        issues.append(Issue("id-mismatch", rid))
    raw = str(data.get("status") or "").strip().lower()
    status = _HYP_STATUS.get(raw.split()[0] if raw else "", "unparsed")
    if status == "unparsed":
        issues.append(Issue("unparsed-status", rid))
    fam = data.get("family")
    family = str(fam) if isinstance(fam, (str, int)) and re.fullmatch(r"[A-Za-z0-9_-]{1,12}", str(fam)) else None
    pairs: list[tuple[str, str]] = []
    ev = data.get("evidence")
    if isinstance(ev, Mapping):
        for key, val in ev.items():
            t = {"decision": "decision", "decisions": "decision", "experiments": "experiment",
                 "experiment": "experiment", "base": "base"}.get(str(key), "evidence")
            pairs.extend((t, i) for i in _ids_in(val, rid))
    else:
        pairs.extend(("evidence", i) for i in _ids_in(ev, rid))
    if family:
        pairs.append(("family", family))
    typed = {to for _, to in pairs}
    pairs.extend(("mentions", i) for i in _ids(text, rid) if i not in typed)
    return Record(rid, "hyp", status, family=family, edges=_edges_from(pairs)), issues


def exp_record(rid: str, folder: Path) -> tuple[Record, list[Issue]]:
    issues: list[Issue] = []
    files = sorted(p for p in folder.rglob("*") if p.is_file())
    has_results = any(p.name.startswith("result") and p.suffix == ".json" for p in files)
    has_report = any(p.name == "report.md" for p in files)
    cfg: Any = None
    found = False
    text = ""
    for name in ("config.yaml", "config.json"):
        p = folder / name
        if not p.is_file():
            continue
        found = True
        body = _read(p)
        if body is None:
            issues.append(Issue("unreadable", rid))
            break
        text = body
        try:
            cfg = yaml.safe_load(body) if name.endswith(".yaml") else json.loads(body)
        except (yaml.YAMLError, ValueError):
            issues.append(Issue("yaml-error", rid))
        break
    readme = folder / "README.md"
    if readme.is_file():
        text += "\n" + (_read(readme) or "")
    # No config file at all is `no_config`; a config that states no status (the early grids are lists of runs) is
    # `no_status`. Neither is an error.
    status = "unparsed" if issues else ("no_status" if found else "no_config")
    pairs: list[tuple[str, str]] = []
    if isinstance(cfg, Mapping):
        exp_id = cfg.get("experiment")
        if isinstance(exp_id, str) and ID_RE.fullmatch(exp_id) and exp_id != rid:
            issues.append(Issue("id-mismatch", rid))
        raw = str(cfg.get("status") or "").strip().lower()
        if raw:
            status = _EXP_STATUS.get(raw.split()[0], "unparsed")
            if status == "unparsed":
                issues.append(Issue("unparsed-status", rid))
        for key, t in (("decision", "decision"), ("decisions", "decision"), ("hypotheses", "hypothesis"),
                       ("hypothesis", "hypothesis"), ("replaces", "supersedes"), ("supersedes", "supersedes")):
            pairs.extend((t, i) for i in _ids_in(cfg.get(key), rid))
    elif isinstance(cfg, list):
        for item in cfg:
            if isinstance(item, Mapping):
                pairs.extend((t, i) for k, t in (("decision", "decision"), ("hypotheses", "hypothesis"))
                             for i in _ids_in(item.get(k), rid))
    elif cfg is not None:
        status = "unparsed"
        issues.append(Issue("yaml-error", rid))
    typed = {to for _, to in pairs}
    pairs.extend(("mentions", i) for i in _ids(text, rid) if i not in typed)
    return Record(rid, "exp", status, has_results=has_results, has_report=has_report,
                  edges=_edges_from(pairs)), issues


def read_file_record(kind: str, rid: str, p: Path) -> tuple[Record, list[Issue]]:
    """One decision, hypothesis or lesson file read into its SAFE record."""
    text = _read(p)
    if text is None:
        return Record(rid, kind, "unparsed"), [Issue("unreadable", rid)]
    if kind == "dec":
        status, date = dec_status(text)
        issues = [Issue("unparsed-status", rid)] if status == "unparsed" else []
        return Record(rid, "dec", status, status_date=date, edges=dec_edges(text, rid)), issues
    if kind == "hyp":
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError:
            return Record(rid, "hyp", "unparsed"), [Issue("yaml-error", rid)]
        return hyp_record(rid, data, text)
    return Record(rid, "ll", "recorded", edges=_edges_from(("mentions", i) for i in _ids(text, rid))), []


def record_sources(root: Path) -> dict[str, list[tuple[str, Path]]]:
    """Every record source at the working tree, grouped by id: (kind, path). More than one source is a conflict."""
    out: dict[str, list[tuple[str, Path]]] = {}
    for kind, rel in RECORD_DIRS.items():
        base = root / rel
        if not base.is_dir():
            continue
        for p in sorted(base.iterdir()):
            if kind == "exp":
                if not p.is_dir():
                    continue
            elif not p.is_file() or p.suffix not in ((".yaml", ".yml") if kind == "hyp" else (".md",)):
                continue
            rid = id_of(kind, p.name)
            if rid:
                out.setdefault(rid, []).append((kind, p))
    return out


def read_records(root: Path) -> tuple[dict[str, Record], list[Issue]]:
    records: dict[str, Record] = {}
    issues: list[Issue] = []
    for rid, sources in sorted(record_sources(root).items()):
        kind, p = sources[0]
        rec, iss = exp_record(rid, p) if kind == "exp" else read_file_record(kind, rid, p)
        if len(sources) > 1:
            # One entry per id, never two: the first file (by name) speaks for it, the conflict is said out loud.
            rec.conflict = True
            rec.files = len(sources)
            iss.append(Issue("duplicate-id", rid))
        records[rid] = rec
        issues.extend(iss)
    return records, issues


def read_families(root: Path) -> tuple[list[dict[str, Any]], list[Issue]]:
    """The trial families of config/trial_registry.yaml (and the global count as family `global`), rows in order."""
    p = root / TRIAL_REGISTRY
    body = _read(p) if p.is_file() else None
    if body is None:
        return [], ([Issue("unreadable")] if p.exists() else [])
    try:
        data = yaml.safe_load(body)
    except yaml.YAMLError:
        return [], [Issue("yaml-error")]
    if not isinstance(data, Mapping):
        return [], [Issue("yaml-error")]

    def rows(raw: Any) -> list[dict[str, Any]]:
        out = []
        for r in raw if isinstance(raw, list) else []:
            if not isinstance(r, Mapping):
                continue
            dec = str(r.get("decision") or "")
            total = r.get("total")
            status = str(r.get("status") or "")
            out.append({"decision": dec if ID_RE.fullmatch(dec) else None,
                        "total": total if isinstance(total, int) and not isinstance(total, bool) else None,
                        "status": status if status in ("accepted", "proposed", "withdrawn") else "unparsed"})
        return out

    fams = [{"id": "global", "rows": rows(data.get("history"))}]
    for name, raw in (data.get("families") or {}).items() if isinstance(data.get("families"), Mapping) else []:
        if re.fullmatch(r"[A-Za-z0-9_-]{1,12}", str(name)):
            fams.append({"id": str(name), "rows": rows(raw)})
    return fams, []


# ---- history ---------------------------------------------------------------------------------------------------

@dataclass
class Change:
    sha: str
    at: str
    status: str            # A, M, D, R
    old: str | None
    new: str | None


def _kind_of(path: str) -> str | None:
    for kind, rel in RECORD_DIRS.items():
        if path.startswith(rel + "/"):
            return kind
    return None


def path_id(path: str) -> str | None:
    """The record id a repository path belongs to: a record file, or any file inside an experiment's folder."""
    kind = _kind_of(path)
    if kind is None:
        return None
    rest = path[len(RECORD_DIRS[kind]) + 1:]
    if kind == "exp":
        if "/" not in rest:
            return None
        return id_of("exp", rest.split("/", 1)[0])
    if "/" in rest:
        return None
    return id_of(kind, rest)


def _utc(stamp: str) -> str:
    """A git ISO time (with its committer's offset) as UTC with a Z, so every time in the index reads one way."""
    try:
        return dt.datetime.fromisoformat(stamp).astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return stamp


def parse_log(out: str) -> list[list[Change]]:
    """`git log --format=%x00%H %cI --name-status -M` output, oldest commit first."""
    commits: list[list[Change]] = []
    for block in out.split("\x00")[1:]:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        head = lines[0].split(" ")
        if len(head) != 2:
            continue
        sha, at = head[0], _utc(head[1])
        changes = []
        for ln in lines[1:]:
            parts = ln.split("\t")
            code = parts[0][:1]
            if code == "R" and len(parts) == 3:
                changes.append(Change(sha, at, "R", parts[1], parts[2]))
            elif code in ("A", "M", "D", "T", "C") and len(parts) >= 2:
                changes.append(Change(sha, at, "M" if code in ("T", "C") else code, parts[-1], parts[-1]))
        commits.append(changes)
    commits.reverse()
    return commits


@dataclass
class History:
    first_seen: dict[str, dict[str, str]] = field(default_factory=dict)
    last_changed: dict[str, dict[str, str]] = field(default_factory=dict)
    path_renames: dict[str, int] = field(default_factory=dict)
    gone: dict[str, dict[str, Any]] = field(default_factory=dict)   # id -> {sha, at, renamed_to, last_path, last_sha}


def replay(commits: list[list[Change]]) -> History:
    """Walk the record paths' history in order: when each id first appeared and last changed, its path renames, and
    the ids that no longer have any file (deleted, or renamed to another id)."""
    h = History()
    live: dict[str, set[str]] = {}
    last_path: dict[str, tuple[str, str]] = {}       # id -> (path, sha of a commit that had it)
    for changes in commits:
        renamed_to: dict[str, str] = {}
        for c in changes:
            old_id = path_id(c.old) if c.old else None
            new_id = path_id(c.new) if c.new else None
            stamp = {"sha": c.sha, "at": c.at}
            if c.status in ("A", "M") and new_id and c.new:
                live.setdefault(new_id, set()).add(c.new)
                h.first_seen.setdefault(new_id, stamp)
                h.last_changed[new_id] = stamp
                last_path[new_id] = (c.new, c.sha)
                h.gone.pop(new_id, None)
            elif c.status == "D" and old_id and c.old:
                live.get(old_id, set()).discard(c.old)
                h.last_changed[old_id] = stamp
            elif c.status == "R":
                if old_id and c.old:
                    live.get(old_id, set()).discard(c.old)
                if new_id and c.new:
                    live.setdefault(new_id, set()).add(c.new)
                    h.first_seen.setdefault(new_id, stamp)
                    h.last_changed[new_id] = stamp
                    last_path[new_id] = (c.new, c.sha)
                    h.gone.pop(new_id, None)
                if old_id and new_id and old_id == new_id:
                    h.path_renames[new_id] = h.path_renames.get(new_id, 0) + 1
                elif old_id and new_id:
                    renamed_to[old_id] = new_id
                    h.last_changed[old_id] = stamp
        for rid in {path_id(c.old) for c in changes if c.old} - {None}:
            assert rid is not None
            if not live.get(rid) and rid in h.first_seen and rid not in h.gone:
                lp = last_path.get(rid)
                sha, at = next((c.sha, c.at) for c in changes if c.old and path_id(c.old) == rid)
                h.gone[rid] = {"sha": sha, "at": at, "renamed_to": renamed_to.get(rid),
                               "last_path": lp[0] if lp else None}
    return h


def _git(root: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RegistryError(f"git-failed ({args[0]})")
    return r.stdout


def read_history(root: Path) -> History | None:
    """The record paths' history from git, or None when it cannot be read whole (no git, a shallow clone)."""
    try:
        if _git(root, "rev-parse", "--is-shallow-repository").strip() != "false":
            return None
        out = _git(root, "log", "--format=%x00%H %cI", "--name-status", "-M", "--no-color", "--",
                   *RECORD_DIRS.values())
    except (RegistryError, OSError, subprocess.SubprocessError):
        return None
    return replay(parse_log(out))


def last_status(root: Path, rid: str, gone: Mapping[str, Any]) -> str:
    """A gone record's status as its last version said, read from git (the commit before the one that removed it)."""
    path = gone.get("last_path")
    kind = _kind_of(path) if isinstance(path, str) else None
    if not path or not kind:
        return "unparsed"
    target = path
    if kind == "exp":
        folder = RECORD_DIRS["exp"] + "/" + path[len(RECORD_DIRS["exp"]) + 1:].split("/", 1)[0]
        target = folder + "/config.yaml"
    try:
        body = _git(root, "show", f"{gone['sha']}^:{target}")
    except (RegistryError, OSError, subprocess.SubprocessError):
        return "no_config" if kind == "exp" else "unparsed"
    if kind == "dec":
        return dec_status(body)[0]
    if kind == "ll":
        return "recorded"
    try:
        data = yaml.safe_load(body)
    except yaml.YAMLError:
        return "unparsed"
    if not isinstance(data, Mapping):
        return "unparsed"
    raw = str(data.get("status") or "").strip().lower()
    table = _HYP_STATUS if kind == "hyp" else _EXP_STATUS
    return table.get(raw.split()[0] if raw else "", "unparsed")


# ---- the index -------------------------------------------------------------------------------------------------

def _kind_for(rid: str) -> str:
    return {"DEC": "dec", "HYP": "hyp", "EXP": "exp", "LL": "ll"}[rid.split("-", 1)[0]]


def build(root: Path, *, branch: str, sha: str, as_of: str, built_at: str, repo: str,
          history: History | None | bool = True) -> dict[str, Any]:
    """The whole index for the tree at `root`. `history=True` reads git; pass a History (tests) or None (no git)."""
    if branch not in BRANCHES:
        raise RegistryError("bad-branch")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RegistryError("bad-sha")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise RegistryError("bad-repo")
    read_policy(root)
    records, issues = read_records(root)
    families, fam_issues = read_families(root)
    issues.extend(fam_issues)

    for fam in families:
        for row in fam["rows"]:
            dec = row["decision"]
            if dec and dec in records:
                rec = records[dec]
                if not any(e.type == "family" and e.to == fam["id"] for e in rec.edges):
                    rec.edges.append(Edge("family", fam["id"]))

    hist = read_history(root) if history is True else (history or None)
    tombstones: list[dict[str, Any]] = []
    if hist is None:
        issues.append(Issue("history-unavailable"))
    else:
        for rid, rec in records.items():
            rec.first_seen = hist.first_seen.get(rid)
            rec.last_changed = hist.last_changed.get(rid)
            rec.path_renames = hist.path_renames.get(rid, 0)
        for rid, g in sorted(hist.gone.items()):
            if rid in records:
                continue                       # back again under the same id: the live record is the truth
            renamed_to = g.get("renamed_to")
            tombstones.append({
                "id": rid,
                "kind": _kind_for(rid),
                "state": "renamed" if renamed_to else "deleted",
                "renamed_to": renamed_to,
                "sha": g["sha"],
                "at": g["at"],
                "first_seen": hist.first_seen.get(rid),
                "last_status": last_status(root, rid, g) if history is True else "unparsed",
            })

    known = set(records) | {t["id"] for t in tombstones}
    family_ids = {f["id"] for f in families}
    for rid, rec in records.items():
        for e in rec.edges:
            if e.type == "family":
                if e.to not in family_ids and families:
                    issues.append(Issue("dangling-ref", rid, e.to))
            elif e.to not in known and e.type != "mentions":
                issues.append(Issue("dangling-ref", rid, e.to))

    kinds = ("dec", "hyp", "exp", "ll")
    out: dict[str, Any] = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "run_id": f"{branch}@{sha}",
        "as_of": as_of,
        "built_at": built_at,
        "branch": branch,
        "sha": sha,
        "repo": repo,
        "prose": False,
        "history": "complete" if hist is not None else "unavailable",
        "counts": {
            **{k: sum(1 for r in records.values() if r.kind == k) for k in kinds},
            "tombstones": len(tombstones),
            "issues": len(issues),
            "families": len(families),
        },
        "records": [_record_json(records[k]) for k in sorted(records, key=_sort_key)],
        "tombstones": tombstones,
        "families": families,
        "issues": [{k: v for k, v in vars(i).items() if v is not None} for i in issues],
    }
    return out


def _sort_key(rid: str) -> tuple[int, str]:
    return ("DEC", "HYP", "EXP", "LL").index(rid.split("-", 1)[0]), rid


def _record_json(r: Record) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": r.id,
        "kind": r.kind,
        "status": r.status,
        "status_date": r.status_date,
        "family": r.family,
        "files": r.files,
        "conflict": r.conflict,
        "first_seen": r.first_seen,
        "last_changed": r.last_changed,
        "path_renames": r.path_renames,
        "edges": [{"type": e.type, "to": e.to} for e in r.edges],
    }
    if r.kind == "exp":
        d["has_results"] = bool(r.has_results)
        d["has_report"] = bool(r.has_report)
    return d


def encode(index: Mapping[str, Any]) -> bytes:
    body = json.dumps(index, separators=(",", ":"), sort_keys=False, ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_BYTES:
        raise RegistryError(f"too-large ({len(body)} bytes)")
    return body


def summary(index: Mapping[str, Any], body: bytes) -> str:
    """The one line CI prints: counts, the commit and the size. Never a record's text."""
    c = index["counts"]
    return (f"registry {index['branch']}@{index['sha'][:12]}: dec={c['dec']} hyp={c['hyp']} exp={c['exp']} "
            f"ll={c['ll']} families={c['families']} tombstones={c['tombstones']} issues={c['issues']} "
            f"history={index['history']} bytes={len(body)}")


def commit_time(root: Path, sha: str) -> str:
    """The commit's committer time in UTC, the index's `as_of`: a re-run of an older commit is then `older`."""
    raw = _git(root, "show", "-s", "--format=%cI", sha).strip()
    out = _utc(raw)
    if not out.endswith("Z"):
        raise RegistryError("bad-commit-time")
    return out
