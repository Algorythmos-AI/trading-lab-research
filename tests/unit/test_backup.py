"""Off-host evidence protection (wt.ops.backup): write-once anchors, chain flags, restic outcomes, restore test."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from wt.core import ledger
from wt.ops import alerts, backup
from wt.ops.r2 import Response


class Anchors:
    configured = True

    def __init__(self):
        self.objs: dict[str, bytes] = {}

    def put(self, bucket, key, body, if_match=None, if_none_match=None, content_type=""):
        if if_none_match == "*" and key in self.objs:
            return Response(412, b"", None, None)
        self.objs[key] = body
        return Response(200, b"", '"e"', None)

    def get(self, bucket, key):
        return Response(200, self.objs[key], '"e"', None) if key in self.objs else Response(404, b"", None, None)


def chained(path: Path, n: int) -> None:
    prev = ledger.GENESIS
    lines = []
    for i in range(n):
        line = json.dumps({"i": i, "prev_sha256": prev}).encode()
        lines.append(line)
        prev = hashlib.sha256(line).hexdigest()
    path.write_bytes(b"\n".join(lines) + b"\n")


@pytest.fixture
def paths(tmp_path, monkeypatch):
    fwd, jr = tmp_path / "fwd.jsonl", tmp_path / "journal.jsonl"
    monkeypatch.setattr(backup, "FORWARD_LEDGER", fwd)
    monkeypatch.setattr(backup, "JOURNAL", jr)
    monkeypatch.setattr(backup, "CHAIN_FLAG", tmp_path / "evidence" / "chain-broken")
    monkeypatch.setattr(backup, "DIGEST", tmp_path / "digest.json")
    box: list[dict] = []
    monkeypatch.setattr(alerts, "_send", lambda msg, topic, server, timeout=5.0: box.append(msg) or True)
    return fwd, jr, tmp_path, box, alerts.Alerts(root=tmp_path / "alerts", topic="t")


def test_anchors_are_write_once_and_a_rewrite_is_detected(paths):
    fwd, jr, tmp, box, a = paths
    chained(fwd, 3)
    s = Anchors()
    day = dt.date(2026, 10, 20)
    assert backup.anchor(day, backup.chains(), s)[0]
    assert backup.anchor(day, backup.chains(), s) == (True, "anchors/2026-10-20.json already anchored")
    chained(fwd, 2)                                              # history rewritten after anchoring
    ok, why = backup.anchor(day, backup.chains(), s)
    assert not ok and "DIFFERENT" in why


def test_nightly_backs_up_anchors_and_writes_the_digest(paths, monkeypatch):
    fwd, jr, tmp, box, a = paths
    chained(fwd, 4)
    calls = []
    monkeypatch.setattr(backup, "restic", lambda *args, timeout=3600: calls.append(args) or SimpleNamespace(
        returncode=0, stdout="", stderr=""))
    assert backup.nightly(a, weekly=False, client=Anchors()) == 0
    assert calls[0][:3] == ("backup", "--host", backup.host())
    assert "nightly" in calls[0] and "role:primary" in calls[0]
    d = json.loads((tmp / "digest.json").read_text())
    assert d["verified"] and d["anchored"] and d["forward"]["lines"] == 4
    assert not (tmp / "evidence" / "chain-broken").exists()


def test_a_broken_chain_flags_entries_off_and_pages(paths, monkeypatch):
    fwd, jr, tmp, box, a = paths
    chained(fwd, 3)
    lines = fwd.read_bytes().split(b"\n")
    lines[1] = lines[1].replace(b'"i": 1', b'"i": 9')          # an edited middle line
    fwd.write_bytes(b"\n".join(lines))
    monkeypatch.setattr(backup, "restic", lambda *args, timeout=3600: SimpleNamespace(returncode=0, stdout="", stderr=""))
    backup.nightly(a, weekly=False, client=Anchors())
    assert (tmp / "evidence" / "chain-broken").exists()
    assert any("chain broken" in m["title"] for m in box)


def test_a_failed_backup_pages_but_still_anchors(paths, monkeypatch):
    fwd, jr, tmp, box, a = paths
    chained(fwd, 2)
    monkeypatch.setattr(backup, "restic", lambda *args, timeout=3600: SimpleNamespace(returncode=1, stdout="", stderr="x"))
    s = Anchors()
    assert backup.nightly(a, weekly=False, client=s) == 1
    assert any(m["title"] == "Nightly backup failed" for m in box) and s.objs


def test_restore_test_verifies_what_came_back(paths, monkeypatch):
    fwd, jr, tmp, box, a = paths

    def fake_restic(*args, timeout=3600):
        target = Path(args[args.index("--target") + 1])
        chained(target / "fwd.jsonl", 3)
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    monkeypatch.setattr(backup, "restic", fake_restic)
    assert backup.restore_test() == 0

    def broken(*args, timeout=3600):
        target = Path(args[args.index("--target") + 1])
        (target / "fwd.jsonl").write_text('{"i": 0, "prev_sha256": "nope"}\n')
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    monkeypatch.setattr(backup, "restic", broken)
    assert backup.restore_test() == 1


def test_prune_tolerates_locked_objects(monkeypatch):
    monkeypatch.setattr(backup, "restic", lambda *args, timeout=3600: SimpleNamespace(
        returncode=1, stdout="", stderr="unable to remove data/ab/cd: locked"))
    assert backup.prune() == 0
    monkeypatch.setattr(backup, "restic", lambda *args, timeout=3600: SimpleNamespace(returncode=1, stdout="", stderr="auth"))
    assert backup.prune() == 1


def test_the_market_data_is_backed_up_on_fridays(paths, monkeypatch):
    fwd, jr, tmp, box, a = paths
    chained(fwd, 1)
    calls = []
    monkeypatch.setattr(backup, "restic", lambda *args, timeout=3600: calls.append(args) or SimpleNamespace(
        returncode=0, stdout="", stderr=""))
    monkeypatch.setattr(backup, "ROOT", tmp)
    (tmp / "data").mkdir(exist_ok=True)
    for day, want in ((dt.date(2026, 10, 9), True), (dt.date(2026, 10, 8), False)):       # Friday, Thursday
        calls.clear()
        backup.nightly(a, client=Anchors(), today=day)
        assert ("data" in calls[0]) is want, day


def test_a_shadow_host_never_claims_the_primarys_anchor(paths, monkeypatch):
    fwd, jr, tmp, box, a = paths
    chained(fwd, 2)
    s, day = Anchors(), dt.date(2026, 10, 20)
    monkeypatch.setenv("WT_ROLE", "shadow")
    monkeypatch.setenv("WT_HOST_ID", "gcp-use1")
    assert backup.anchor(day, backup.chains(), s) == (True, "anchored shadow/gcp-use1/anchors/2026-10-20.json")
    monkeypatch.setenv("WT_ROLE", "primary")
    chained(fwd, 3)                                              # the primary's heads differ from the shadow's
    assert backup.anchor(day, backup.chains(), s) == (True, "anchored anchors/2026-10-20.json")


def test_restore_test_restores_this_hosts_own_snapshot(paths, monkeypatch):
    seen = []
    monkeypatch.setenv("WT_HOST_ID", "gcp-use1")

    def fake(*args, timeout=3600):
        seen.append(args)
        chained(Path(args[args.index("--target") + 1]) / "fwd.jsonl", 1)
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    monkeypatch.setattr(backup, "restic", fake)
    backup.restore_test()
    assert seen[0][:4] == ("restore", "latest", "--host", "gcp-use1")
    includes = [seen[0][i + 1] for i, a in enumerate(seen[0]) if a == "--include"]
    assert includes == [backup.FORWARD_LEDGER.name, backup.JOURNAL.name]      # names, not absolute paths


def test_a_locked_bucket_that_answers_409_is_read_back_like_a_412(paths):
    """2026-10-04: the day's second backup got HTTP 409 from the locked anchors bucket for an anchor that was
    already there and identical. It was reported as a failed anchor, failed the job and paged."""
    fwd, jr, tmp, box, a = paths
    chained(fwd, 3)
    chained(jr, 2)

    class Locked(Anchors):
        def put(self, bucket, key, body, if_match=None, if_none_match=None, content_type=""):
            if key in self.objs:
                return Response(409, b"", None, None)
            return super().put(bucket, key, body, if_match, if_none_match, content_type)
    s, day = Locked(), dt.date(2026, 10, 20)
    assert backup.anchor(day, backup.chains(), s) == (True, "anchored anchors/2026-10-20.json")
    assert backup.anchor(day, backup.chains(), s) == (True, "anchors/2026-10-20.json already anchored")
    chained(fwd, 4)
    assert backup.anchor(day, backup.chains(), s) == (False, "anchors/2026-10-20.json already anchored with DIFFERENT heads")

    class Unreadable(Locked):
        def get(self, bucket, key):
            return Response(503, b"", None, None)
    u = Unreadable()
    u.objs["anchors/2026-10-20.json"] = b"{}"
    ok, why = backup.anchor(day, backup.chains(), u)
    assert not ok and "could not be read back (HTTP 503)" in why


def test_a_good_anchor_clears_an_earlier_anchor_alert(paths, monkeypatch):
    fwd, jr, tmp, box, a = paths
    chained(fwd, 2)
    chained(jr, 2)
    monkeypatch.setattr(backup, "restic", lambda *x, **k: SimpleNamespace(returncode=0, stdout="", stderr=""))
    monkeypatch.setattr(backup.hc, "ping", lambda *x, **k: True)
    a.fire("anchor", "Daily evidence anchor failed", "anchor write answered HTTP 409", 3)
    assert backup.nightly(a, weekly=False, client=Anchors(), today=dt.date(2026, 10, 20)) == 0
    assert "anchor" not in a.firing()
