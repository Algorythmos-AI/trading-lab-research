"""The Reference Registry's builder (wt.research.registry) and its CI command (scripts/build_registry.py).

The repositories here are made up in tmp_path (scripts/gen_registry_fixture.py builds the shared one), so nothing
reads the network or the real records except the one agreement test, which only compares statuses.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

from wt.research import registry as reg

ROOT = Path(__file__).resolve().parents[2]


def _load(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


fx = _load("gen_registry_fixture")
cli = _load("build_registry")


@pytest.fixture(scope="module")
def made(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, list[str], dict[str, Any]]:
    where = tmp_path_factory.mktemp("repo")
    shas = fx.make_repo(where)
    index = reg.build(where, branch="integration", sha=shas[-1], as_of=reg.commit_time(where, shas[-1]),
                      built_at="2026-10-07T12:05:00Z", repo="example/x")
    return where, shas, index


def _rec(index: dict[str, Any], rid: str) -> dict[str, Any]:
    return next(r for r in index["records"] if r["id"] == rid)


def _edges(index: dict[str, Any], rid: str) -> set[tuple[str, str]]:
    return {(e["type"], e["to"]) for e in _rec(index, rid)["edges"]}


# ---- discovery and statuses ------------------------------------------------------------------------------------

def test_every_record_once_with_its_status(made: Any) -> None:
    _, _, index = made
    ids = [r["id"] for r in index["records"]]
    assert len(ids) == len(set(ids))
    assert {r["id"]: r["status"] for r in index["records"]} == {
        "DEC-9001": "accepted", "DEC-9003": "accepted", "DEC-9004": "withdrawn", "DEC-9005": "unparsed",
        "HYP-9001": "pre_registered", "HYP-9003": "unparsed", "HYP-9004": "unparsed", "HYP-9005": "pre_registered",
        "EXP-9001": "registered", "EXP-9002b": "no_status", "EXP-9003": "no_config", "LL-9001": "recorded"}
    assert index["counts"] == {"dec": 4, "hyp": 4, "exp": 3, "ll": 1, "tombstones": 2, "issues": 5, "families": 2}


@pytest.mark.parametrize(("name", "kind", "want"), [
    ("DEC-0079-options-clone.md", "dec", "DEC-0079"),
    ("EXP-0005b-g1-etf-dev-realcost", "exp", "EXP-0005b"),
    ("EXP-0015a-catalyst-accuracy", "exp", "EXP-0015a"),
    ("EXP-0015-r3-dev", "exp", "EXP-0015"),
    ("EXP-DEBUG-0001-plumbing-2019", "exp", "EXP-DEBUG-0001"),
    ("HYP-0073-OC_TIME_MID.yaml", "hyp", "HYP-0073"),
    ("LL-0006-read-the-market.md", "ll", "LL-0006"),
    ("README.md", "exp", None),
    ("G1-combined.json", "exp", None),
    ("DEC-079-short.md", "dec", None),
])
def test_ids_from_names(name: str, kind: str, want: str | None) -> None:
    assert reg.id_of(kind, name) == want


@pytest.mark.parametrize(("head", "want"), [
    ("- **Status: ACCEPTED on 2026-11-20 (Sydney).**", ("accepted", "2026-11-20")),
    ("- **Status:** PROPOSED on 2026-11-23. It takes effect", ("proposed", "2026-11-23")),
    ("- **Status: ACCEPTED (2026-11-19).**", ("accepted", "2026-11-19")),
    ("- **Status: IN EFFECT from 2026-09-29.**", ("in_effect", "2026-09-29")),
    ("- **Status: NOT USED.**", ("not_used", None)),
    ("- **Status: WITHDRAWN on 2026-10-25.**", ("withdrawn", "2026-10-25")),
    ("- **Status: SUPERSEDED by DEC-0090 on 2026-12-01.**", ("superseded", "2026-12-01")),
    ("- **Status: MAYBE**", ("unparsed", None)),
    ("- **Date:** 2026-09-27", ("recorded", "2026-09-27")),
])
def test_decision_status_forms(head: str, want: tuple[str, str | None]) -> None:
    assert reg.dec_status(f"# DEC-0001: t\n\n{head}\n") == want


def test_decision_status_agrees_with_the_publisher_on_the_real_records() -> None:
    """Where the host's publisher (wt.ops.status.src_research) reads a status word, the registry reads the same."""
    words = {"ACCEPTED": "accepted", "PROPOSED": "proposed", "WITHDRAWN": "withdrawn", "NOT USED": "not_used",
             "IN EFFECT": "in_effect"}
    import re
    checked = 0
    for p in sorted((ROOT / "research/decisions").glob("DEC-*.md")):
        blob = "\n".join(p.read_text(encoding="utf-8").splitlines()[:14])
        m = re.search(r"\*\*Status:\s*([^*]+)\*\*", blob)
        if not m:
            continue
        theirs = next((code for w, code in words.items() if m.group(1).strip().upper().startswith(w)), None)
        if theirs:
            checked += 1
            assert reg.dec_status(p.read_text(encoding="utf-8"))[0] == theirs, p.name
    assert checked > 50


# ---- relations -------------------------------------------------------------------------------------------------

def test_labelled_relations_and_their_negatives(made: Any) -> None:
    _, _, index = made
    e = _edges(index, "DEC-9003")
    assert {("depends_on", "DEC-9001"), ("depends_on", "HYP-9001"), ("amends", "DEC-9001")} <= e
    # "Does not amend: DEC-9002" and "Amends nothing. DEC-9005 stands" are no amendment.
    assert ("amends", "DEC-9002") not in e and ("amends", "DEC-9005") not in e
    assert ("mentions", "DEC-9002") in e and ("mentions", "DEC-9005") in e


def test_wrapped_bullet_lines_keep_their_label() -> None:
    text = ("# DEC-0100: t\n\n- **Status: ACCEPTED on 2026-11-01.**\n- **Depends on:** DEC-0005 (a), DEC-0028\n"
            "  (b), DEC-0030.\n- **Experiment:** EXP-0055.\n\n## Why\n\nSee DEC-0001.\n")
    edges = {(e.type, e.to) for e in reg.dec_edges(text, "DEC-0100")}
    assert edges == {("depends_on", "DEC-0005"), ("depends_on", "DEC-0028"), ("depends_on", "DEC-0030"),
                     ("experiment", "EXP-0055"), ("mentions", "DEC-0001")}


def test_hypothesis_experiment_and_family_relations(made: Any) -> None:
    _, _, index = made
    assert {("decision", "DEC-9001"), ("experiment", "EXP-9001"), ("family", "Z")} <= _edges(index, "HYP-9001")
    assert {("decision", "DEC-9001"), ("hypothesis", "HYP-9001")} <= _edges(index, "EXP-9001")
    assert ("decision", "DEC-9003") in _edges(index, "EXP-9002b")          # a list config (the early grids)
    assert {("family", "global"), ("family", "Z")} <= _edges(index, "DEC-9001")
    fams = {f["id"]: f["rows"] for f in index["families"]}
    assert fams["Z"][-1] == {"decision": "DEC-9004", "total": 3, "status": "proposed"}


def test_dangling_reference_is_an_issue(made: Any) -> None:
    _, _, index = made
    assert {"code": "dangling-ref", "id": "DEC-9005", "to": "DEC-9999"} in index["issues"]
    # A link to a record that was renamed away is not dangling: the tombstone answers it.
    assert not any(i.get("to") == "DEC-9002" for i in index["issues"])


# ---- history: renames and deletions ----------------------------------------------------------------------------

def test_path_rename_keeps_the_record_and_counts_it(made: Any) -> None:
    _, shas, index = made
    r = _rec(index, "DEC-9001")
    assert r["path_renames"] == 1
    assert r["first_seen"]["sha"] == shas[0] and r["last_changed"]["sha"] == shas[2]
    assert not any(t["id"] == "DEC-9001" for t in index["tombstones"])


def test_id_rename_leaves_a_tombstone_pointing_at_the_new_id(made: Any) -> None:
    _, shas, index = made
    t = next(t for t in index["tombstones"] if t["id"] == "DEC-9002")
    assert t == {"id": "DEC-9002", "kind": "dec", "state": "renamed", "renamed_to": "DEC-9004", "sha": shas[3],
                 "at": "2026-10-04T12:00:00Z", "first_seen": {"sha": shas[0], "at": "2026-10-01T12:00:00Z"},
                 "last_status": "proposed"}


def test_deleted_record_keeps_its_last_status(made: Any) -> None:
    _, shas, index = made
    t = next(t for t in index["tombstones"] if t["id"] == "HYP-9002")
    assert (t["state"], t["renamed_to"], t["sha"], t["last_status"]) == ("deleted", None, shas[5], "falsified")
    assert "HYP-9002" not in {r["id"] for r in index["records"]}


def test_a_record_deleted_and_added_back_is_live_again() -> None:
    log = ("\x00a2 2026-10-02T00:00:00+11:00\nD\tresearch/decisions/DEC-0001-x.md\n"      # newest first, as git
           "\x00a1 2026-10-01T00:00:00+00:00\nA\tresearch/decisions/DEC-0001-x.md\n")
    h = reg.replay(reg.parse_log("\x00a3 2026-10-03T00:00:00Z\nA\tresearch/decisions/DEC-0001-y.md\n" + log))
    assert "DEC-0001" not in h.gone and h.first_seen["DEC-0001"]["sha"] == "a1"
    assert h.last_changed["DEC-0001"] == {"sha": "a3", "at": "2026-10-03T00:00:00Z"}
    h2 = reg.replay(reg.parse_log(log))
    assert h2.gone["DEC-0001"]["sha"] == "a2" and h2.last_changed["DEC-0001"]["at"] == "2026-10-01T13:00:00Z"


def test_an_experiment_is_gone_only_when_its_last_file_is() -> None:
    log = ("\x00b2 2026-10-02T00:00:00Z\nD\tresearch/experiments/EXP-0001-x/config.yaml\n"
           "\x00b1 2026-10-01T00:00:00Z\nA\tresearch/experiments/EXP-0001-x/config.yaml\n"
           "A\tresearch/experiments/EXP-0001-x/README.md\n")
    h = reg.replay(reg.parse_log(log))
    assert "EXP-0001" not in h.gone


def test_shallow_or_missing_history_is_said_not_guessed(tmp_path: Path) -> None:
    (tmp_path / "dashboard/src/lib").mkdir(parents=True)
    (tmp_path / reg.POLICY_PATH).write_text('{"prose": false}')
    index = reg.build(tmp_path, branch="main", sha="0" * 40, as_of="2026-10-01T00:00:00Z",
                      built_at="2026-10-01T00:00:00Z", repo="example/x")          # not a git repository
    assert index["history"] == "unavailable" and index["tombstones"] == []
    assert {"code": "history-unavailable"} in index["issues"]


def test_merged_history_never_hides_a_deleted_record(tmp_path: Path) -> None:
    """Deleted on one line of work, changed on another dated later, the deletion kept at the merge: HEAD has no file,
    so the id is a tombstone, whatever order the replay saw the two lines in."""
    import os
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

    def git(*a: str, date: str | None = None) -> str:
        e = {**env, **({"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date} if date else {})}
        return subprocess.run(["git", *a], cwd=tmp_path, env=e, check=True, capture_output=True, text=True).stdout

    git("init", "-q", "-b", "main")
    (tmp_path / "dashboard/src/lib").mkdir(parents=True)
    (tmp_path / reg.POLICY_PATH).write_text('{"prose": false}')
    d = tmp_path / "research/decisions"
    d.mkdir(parents=True)
    (d / "DEC-0001-a.md").write_text("# DEC-0001\n\n- **Status: ACCEPTED on 2026-10-01.**\n")
    (d / "DEC-0002-b.md").write_text("# DEC-0002\n\n- **Status: ACCEPTED on 2026-10-01.**\n")
    git("add", "-A")
    git("commit", "-q", "-m", "a", date="2026-10-01T00:00:00Z")
    git("switch", "-q", "-c", "side")
    (d / "DEC-0001-a.md").write_text("# DEC-0001\n\n- **Status: WITHDRAWN on 2026-10-03.**\n")
    git("commit", "-q", "-am", "m", date="2026-10-03T00:00:00Z")
    git("switch", "-q", "main")
    git("rm", "-q", "research/decisions/DEC-0001-a.md")
    git("commit", "-q", "-m", "d", date="2026-10-02T00:00:00Z")
    subprocess.run(["git", "merge", "-q", "side", "-m", "merge"], cwd=tmp_path, env=env, capture_output=True)
    git("rm", "-q", "--ignore-unmatch", "research/decisions/DEC-0001-a.md")
    git("commit", "-q", "-m", "merge", date="2026-10-04T00:00:00Z")
    head = git("rev-parse", "HEAD").strip()
    index = reg.build(tmp_path, branch="main", sha=head, as_of="2026-10-04T00:00:00Z", built_at="2026-10-04T00:00:00Z",
                      repo="example/x")
    assert [r["id"] for r in index["records"]] == ["DEC-0002"]
    assert [(t["id"], t["state"]) for t in index["tombstones"]] == [("DEC-0001", "deleted")]
    assert index["tombstones"][0]["last_status"] in ("accepted", "withdrawn")


# ---- duplicates and malformed input ----------------------------------------------------------------------------

def test_duplicate_id_is_one_entry_marked_as_a_conflict(made: Any) -> None:
    _, _, index = made
    r = _rec(index, "HYP-9005")
    assert (r["conflict"], r["files"]) == (True, 2)
    assert [r["id"] for r in index["records"]].count("HYP-9005") == 1
    assert {"code": "duplicate-id", "id": "HYP-9005"} in index["issues"]


def test_malformed_yaml_is_an_issue_and_no_content_leaks(made: Any) -> None:
    _, _, index = made
    assert {"code": "yaml-error", "id": "HYP-9003"} in index["issues"]
    body = reg.encode(index).decode()
    assert "SENTINEL" not in body and "synthetic" not in body           # no record or spec text, at all
    assert "SPEC-9001" not in body


def test_id_field_that_disagrees_with_the_file_name(tmp_path: Path) -> None:
    rec, issues = reg.hyp_record("HYP-0001", {"id": "HYP-0002", "status": "falsified"}, "")
    assert rec.status == "falsified" and [i.code for i in issues] == ["id-mismatch"]


def test_unreadable_and_oversized_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "DEC-0001-x.md"
    p.write_text("x" * 50)
    monkeypatch.setattr(reg, "MAX_FILE_BYTES", 10)
    rec, issues = reg.read_file_record("dec", "DEC-0001", p)
    assert rec.status == "unparsed" and [i.code for i in issues] == ["unreadable"]


# ---- the gate, the size cap, the stamp ---------------------------------------------------------------------------

def test_index_has_no_prose_or_path_keys(made: Any) -> None:
    _, _, index = made
    keys: set[str] = set()

    def walk(v: Any) -> None:
        if isinstance(v, dict):
            keys.update(v)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(index)
    assert not keys & {"title", "summary", "statement", "path", "paths", "name", "question", "subject", "setup"}


def test_policy_is_the_one_gate(tmp_path: Path) -> None:
    (tmp_path / "dashboard/src/lib").mkdir(parents=True)
    with pytest.raises(reg.RegistryError, match="policy-unreadable"):
        reg.read_policy(tmp_path)
    (tmp_path / reg.POLICY_PATH).write_text('{"prose": "no"}')
    with pytest.raises(reg.RegistryError, match="policy-malformed"):
        reg.read_policy(tmp_path)
    (tmp_path / reg.POLICY_PATH).write_text('{"prose": true}')
    with pytest.raises(reg.RegistryError, match="prose-not-built"):
        reg.read_policy(tmp_path)


def test_the_real_policy_is_prose_off() -> None:
    assert json.loads((ROOT / reg.POLICY_PATH).read_text()) == {"prose": False}


def test_size_cap(made: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    _, _, index = made
    monkeypatch.setattr(reg, "MAX_BYTES", 100)
    with pytest.raises(reg.RegistryError, match="too-large"):
        reg.encode(index)


def test_stamp_and_refusals(made: Any) -> None:
    where, shas, index = made
    assert index["run_id"] == f"integration@{shas[-1]}" and index["as_of"] == "2026-10-07T12:00:00Z"
    for kw in ({"branch": "feature"}, {"sha": "abc"}, {"repo": "no slash"}):
        args = {"branch": "main", "sha": shas[-1], "repo": "example/x", **kw}
        with pytest.raises(reg.RegistryError):
            reg.build(where, as_of="2026-10-01T00:00:00Z", built_at="2026-10-01T00:00:00Z", **args)


def test_the_index_matches_the_dashboard_schema(made: Any) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((ROOT / "dashboard/src/lib/registry.schema.json").read_text())
    _, _, index = made
    jsonschema.validate(index, schema)
    for name in ("registry.integration.v1.json", "registry.main.v1.json"):
        jsonschema.validate(json.loads((ROOT / "dashboard/test/fixtures" / name).read_text()), schema)


def test_committed_fixtures_are_current() -> None:
    assert fx.main(["--check"]) == 0


def test_the_real_tree_builds_under_the_cap() -> None:
    """The real records, read whole: the build succeeds and the index is far under the ingest's cap."""
    index = reg.build(ROOT, branch="integration", sha="1" * 40, as_of="2026-11-25T00:00:00Z",
                      built_at="2026-11-25T00:00:00Z", repo="example/x", history=None)
    body = reg.encode(index)
    assert index["counts"]["dec"] > 70 and len(body) < reg.MAX_BYTES // 4


# ---- the CI command ----------------------------------------------------------------------------------------------

class _Net:
    def __init__(self, health: tuple[int, Any], posts: list[tuple[int, Any]]) -> None:
        self.health, self.posts, self.calls = health, list(posts), []

    def __call__(self, url: str, *, data: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
        self.calls.append((url, data is not None, dict(headers or {})))
        return self.health if data is None else self.posts.pop(0)


ENV = {"REGISTRY_INGEST_URL": "https://lab.example/api/ingest", "REGISTRY_INGEST_SECRET": "s3cret",
       "REGISTRY_VERCEL_BYPASS": "bypass"}


def _send(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, net: _Net, env: dict[str, str] = ENV) -> int:
    idx = tmp_path / "i.json"
    idx.write_bytes(b'{"x":1}')
    monkeypatch.setattr(cli, "_request", net)
    monkeypatch.setattr(cli.time, "sleep", lambda s: None)
    return int(cli.cmd_send(type("A", (), {"index": str(idx)})(), env))


HEALTH_OK = (200, {"editions": {"registry": {"accepts": 1}}})


@pytest.mark.parametrize("word", ["stored", "duplicate", "older"])
def test_send_success_outcomes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, word: str,
                               capsys: pytest.CaptureFixture[str]) -> None:
    net = _Net(HEALTH_OK, [(409 if word == "older" else 200, {"status": word})])
    assert _send(tmp_path, monkeypatch, net) == 0
    url, posted, headers = net.calls[1]
    assert posted and headers["x-wt-key-id"] == "registry" and headers["x-vercel-protection-bypass"] == "bypass"
    ts = int(headers["x-wt-timestamp"])
    assert headers["x-wt-signature"] == cli.sign(b'{"x":1}', "s3cret", ts)
    out = capsys.readouterr().out
    assert "s3cret" not in out and "bypass" not in out


def test_send_skips_until_the_dashboard_accepts_the_kind(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    net = _Net((200, {"editions": {}}), [])
    assert _send(tmp_path, monkeypatch, net) == 0 and len(net.calls) == 1


def test_send_refusal_fails_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                    capsys: pytest.CaptureFixture[str]) -> None:
    net = _Net(HEALTH_OK, [(422, {"error": "invalid", "errors": ["/records/0: SENTINEL"]})])
    assert _send(tmp_path, monkeypatch, net) == 1
    out = capsys.readouterr().out
    assert "invalid" in out and "SENTINEL" not in out


def test_send_retries_server_errors_then_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    net = _Net(HEALTH_OK, [(502, {"error": "storage unavailable"})] * 3)
    assert _send(tmp_path, monkeypatch, net) == 1 and len(net.calls) == 4


@pytest.mark.parametrize("drop", ["REGISTRY_INGEST_SECRET", "REGISTRY_VERCEL_BYPASS", "REGISTRY_INGEST_URL"])
def test_send_without_configuration_fails_loudly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, drop: str) -> None:
    net = _Net(HEALTH_OK, [])
    env = {k: v for k, v in ENV.items() if k != drop}
    assert _send(tmp_path, monkeypatch, net, env) == 3 and net.calls == []


def test_send_refuses_a_newer_schema_than_the_site(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    net = _Net((200, {"editions": {"registry": {"accepts": 0}}}), [])
    assert _send(tmp_path, monkeypatch, net) == 1


def test_signature_matches_the_publisher() -> None:
    from wt.ops.publish import sign
    assert cli.sign(b"body", "k", 1700000000) == sign(b"body", "k", 1700000000)


def test_build_prints_one_line_of_counts(made: Any, tmp_path: Path) -> None:
    where, shas, _ = made
    out = tmp_path / "out.json"
    r = subprocess.run([sys.executable, str(ROOT / "scripts/build_registry.py"), "build", "--branch", "integration",
                        "--sha", shas[-1], "--out", str(out)], capture_output=True, text=True, cwd=ROOT)
    # The script builds the checkout it lives in; a foreign SHA is refused by git with a code, never a traceback.
    assert r.returncode in (0, 1) and "Traceback" not in r.stderr
    assert len(r.stdout.strip().splitlines()) == 1


# ---- the workflow ------------------------------------------------------------------------------------------------

def test_workflow_never_publishes_the_index() -> None:
    text = (ROOT / ".github/workflows/registry.yml").read_text()
    wf = yaml.safe_load(text)
    on = wf.get("on") or wf.get(True)
    assert set(on) == {"push", "workflow_dispatch"} and on["push"] == {"branches": ["main", "integration"]}
    assert wf["permissions"] == {"contents": "read"}
    assert wf["concurrency"]["cancel-in-progress"] is False
    job = wf["jobs"]["registry"]
    assert job["environment"] == "registry"
    for forbidden in ("upload-artifact", "set -x", "cat ", "git push", "git commit", "actions/cache"):
        assert forbidden not in text, forbidden
    steps = " ".join(str(s.get("run", "")) for s in job["steps"])
    assert "build_registry.py build" in steps and "build_registry.py send" in steps and "$RUNNER_TEMP" in steps
    checkout = next(s for s in job["steps"] if str(s.get("uses", "")).startswith("actions/checkout"))
    assert checkout["with"]["fetch-depth"] == 0 and checkout["with"]["persist-credentials"] is False
