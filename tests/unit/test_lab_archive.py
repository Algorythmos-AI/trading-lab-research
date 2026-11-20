"""The tape's archive (DEC-0060 section 2.5): write-once uploads, lasting receipts, pruning only after a remote
re-read, the weekly check over every archived session, and the lab's own credentials only. A fake store."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from wt.lab import archive, manifest

B = "wt-lab-test"


@dataclass
class R:
    status: int
    body: bytes = b""
    etag: str | None = None


class Store:
    def __init__(self, fail_on: str | None = None, bad_etag: bool = False, no_etag: bool = False,
                 raise_on: str | None = None) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts = 0
        self.fail_on, self.bad_etag, self.no_etag, self.raise_on = fail_on, bad_etag, no_etag, raise_on

    def get(self, bucket: str, key: str) -> R:
        return R(200, self.objects[key]) if key in self.objects else R(404)

    def put(self, bucket: str, key: str, body: bytes, if_match: str | None = None,
            if_none_match: str | None = None, content_type: str = "application/json") -> R:
        self.puts += 1
        assert if_none_match == "*" and bucket == B
        if self.raise_on and self.raise_on in key:
            raise ConnectionError("network")
        if self.fail_on and key.endswith(self.fail_on):
            return R(500)
        if key in self.objects:
            return R(412)
        self.objects[key] = body
        if self.no_etag:
            return R(200)
        return R(200, etag='"' + ("0" * 32 if self.bad_etag else hashlib.md5(body).hexdigest()) + '"')


def session(root: Path, day: str, rows: int = 5, recorded: bool = True) -> Path:
    f = root / day
    f.mkdir(parents=True)
    pq.write_table(pa.table({"x": list(range(rows))}), f / "option-0000.parquet")
    pq.write_table(pa.table({"x": [1]}), f / "gap-0000.parquet")
    (f / "focus.json").write_text('{"names": ["AAA"]}')
    manifest.write(f, {"recorded": recorded})
    return f


def test_a_session_uploads_every_file_once_manifest_last_and_gets_a_lasting_receipt(tmp_path: Path) -> None:
    f, s = session(tmp_path, "2026-11-19"), Store()
    out = archive.upload(f, s, B)
    keys = [o["key"] for o in out["objects"]]
    assert out["verified"] and archive.receipt_ok(f, B) and keys[-1] == "tape/2026-11-19/manifest.json"
    assert "tape/2026-11-19/focus.json" in keys                         # the whole folder, not only the parts
    assert s.objects["tape/2026-11-19/option-0000.parquet"] == (f / "option-0000.parquet").read_bytes()
    assert archive.read_receipt(tmp_path, "2026-11-19")["bucket"] == B
    assert archive.upload_all(tmp_path, s, B) == []                   # nothing left to do
    assert not archive.receipt_ok(f, "wt-lab-other")                  # a receipt is for its own bucket only


def test_a_repeated_upload_accepts_identical_objects_and_refuses_different_ones(tmp_path: Path) -> None:
    f, s = session(tmp_path, "2026-11-19"), Store()
    archive.upload(f, s, B)
    archive.receipt_path(tmp_path, f.name).unlink()
    assert archive.upload(f, s, B)["verified"]                       # same bytes already there: fine
    s.objects["tape/2026-11-19/gap-0000.parquet"] = b"other"
    archive.receipt_path(tmp_path, f.name).unlink()
    out = archive.upload(f, s, B)
    assert not out["verified"] and "exists with other bytes" in out["problems"][0] and not archive.receipt_ok(f, B)


def test_a_failed_put_a_wrong_or_missing_etag_or_a_changed_file_is_caught(tmp_path: Path) -> None:
    f = session(tmp_path, "2026-11-19")
    assert archive.upload(f, Store(fail_on="gap-0000.parquet"), B)["problems"] == [
        "status 500 on tape/2026-11-19/gap-0000.parquet"]
    assert archive.upload(f, Store(bad_etag=True), B)["problems"][0].startswith("etag mismatch")
    assert archive.upload(f, Store(no_etag=True), B)["verified"]      # no ETag: read back and compared instead
    (f / "option-0000.parquet").write_bytes(b"changed")
    archive.receipt_path(tmp_path, f.name).unlink()
    out = archive.upload(f, Store(), B)
    assert out["problems"] == ["changed option-0000.parquet"] and not archive.receipt_ok(f, B)


def test_a_receipt_stops_counting_when_the_manifest_changes(tmp_path: Path) -> None:
    f = session(tmp_path, "2026-11-19")
    archive.upload(f, Store(), B)
    manifest.write(f, {"recorded": True, "note": "rewritten"})
    assert not archive.receipt_ok(f, B)


def test_one_bad_session_never_stops_the_others(tmp_path: Path) -> None:
    session(tmp_path, "2026-11-18")
    (tmp_path / "2026-11-18" / manifest.NAME).write_text("{not json")   # a corrupt manifest on the oldest session
    session(tmp_path, "2026-11-19")
    res = archive.upload_all(tmp_path, Store(), B)
    assert [(r["session"], r["verified"]) for r in res] == [("2026-11-18", False), ("2026-11-19", True)]
    res2 = archive.upload_all(tmp_path, Store(raise_on="2026-11-18"), B)
    assert res2[0]["problems"] == ["manifest unreadable: JSONDecodeError"]


def test_prune_reads_every_object_back_before_deleting_and_counts_only_recorded_sessions(tmp_path: Path) -> None:
    days = [f"2026-11-{d:02d}" for d in (10, 11, 12, 13, 14)]
    folders = [session(tmp_path, d) for d in days]
    empty = [session(tmp_path, f"2026-11-{d:02d}", recorded=False) for d in (15, 16, 17)]
    s = Store()
    for f in folders[1:] + empty:
        archive.upload(f, s, B)
    s.objects["tape/2026-11-12/gap-0000.parquet"] = b"rot"            # the bucket lost a part since the upload
    gone = archive.prune(tmp_path, s, B, keep=2)
    assert gone == ["2026-11-11", "2026-11-15", "2026-11-16", "2026-11-17"]   # 11-10 never uploaded, 11-12 rotten
    assert {"2026-11-10", "2026-11-12", "2026-11-13", "2026-11-14"} <= {p.name for p in tmp_path.iterdir()}
    assert (tmp_path / manifest.HEAD).exists() and archive.read_receipt(tmp_path, "2026-11-11") is not None


def test_prune_never_deletes_a_file_the_receipt_does_not_cover(tmp_path: Path) -> None:
    f, s = session(tmp_path, "2026-11-10"), Store()
    archive.upload(f, s, B)
    (f / "state.json").write_text("{}")                               # written after the upload
    assert archive.prune(tmp_path, s, B, keep=0) == [] and f.exists()


def test_an_unfinished_session_is_neither_uploaded_nor_pruned(tmp_path: Path) -> None:
    (tmp_path / "2026-11-19").mkdir()
    (tmp_path / "2026-11-19" / "option-0000.parquet").write_bytes(b"x")
    assert archive.upload_all(tmp_path, Store(), B) == [] and archive.prune(tmp_path, Store(), B, keep=0) == []


def test_the_weekly_check_covers_pruned_sessions_is_seeded_and_never_passes_empty(tmp_path: Path) -> None:
    s = Store()
    for d in ("2026-11-17", "2026-11-18", "2026-11-19"):
        archive.upload(session(tmp_path, d), s, B)
    archive.prune(tmp_path, s, B, keep=1)                             # two sessions now live in the bucket only
    ok = archive.check(s, B, tmp_path, parts=50, seed="x")
    assert ok["ok"] and ok["sessions"] == 3 and ok["bad"] == [] and ok == archive.check(s, B, tmp_path, 50, "x")
    s.objects["tape/2026-11-17/option-0000.parquet"] = b"rot"         # a part of a pruned session
    del s.objects["tape/2026-11-18/manifest.json"]                     # a pruned session's manifest
    bad = archive.check(s, B, tmp_path, parts=50, seed="x")
    assert not bad["ok"] and set(bad["bad"]) == {"tape/2026-11-17/option-0000.parquet", "tape/2026-11-18/manifest.json"}
    other = tmp_path / "other"
    session(other, "2026-11-19")
    lost = archive.check(Store(), B, other)                            # sessions written here, no receipt left
    assert lost["ok"] is False and lost["receipts_lost"] is True
    import datetime as dt
    fresh = tmp_path / "late"
    good = Store()
    archive.upload(session(fresh, "2026-11-18"), good, B)
    session(fresh, "2026-11-20")                                        # this one's uploads keep failing
    soon = archive.check(good, B, fresh, 50, "x", today=dt.date(2026, 11, 22))
    late = archive.check(good, B, fresh, 50, "x", today=dt.date(2026, 11, 25))
    assert soon["ok"] is True and soon["not_archived"] == ["2026-11-20"] and soon["bad"] == []
    assert late["not_archived_after_3_days"] == ["2026-11-20"] and late["bad"] == []
    assert late["ok"] is False


def test_only_the_labs_own_credentials_are_ever_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                     capsys: Any) -> None:
    monkeypatch.setenv("R2_ACCOUNT_ID", "acct")                        # the backup's token in the process itself
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "backup")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "backup-secret")
    base = {"WT_LAB_TAPE": str(tmp_path), "R2_ACCOUNT_ID": "acct", "R2_ACCESS_KEY_ID": "backup",
            "R2_SECRET_ACCESS_KEY": "backup-secret"}
    assert archive.store_from_env(base) is None
    assert archive.store_from_env({**base, "R2_LAB_ACCESS_KEY_ID": "lab"}) is None         # half a lab token
    assert archive.store_from_env({**base, "R2_LAB_ACCESS_KEY_ID": "backup", "R2_LAB_SECRET_ACCESS_KEY": "s"}) is None
    lab = archive.store_from_env({**base, "R2_LAB_ACCESS_KEY_ID": "lab", "R2_LAB_SECRET_ACCESS_KEY": "lab-s"})
    assert lab is not None and (lab.access, lab.secret) == ("lab", "lab-s")
    assert archive.main(["upload"], env=base) == 2
    with pytest.raises(ValueError):
        archive.bucket_of({"WT_LAB_BUCKET": "trading-backup"})       # the tape never goes to another bucket
    session(tmp_path, "2026-11-19")
    assert archive.main(["upload"], store=Store(), env={**base, "WT_LAB_BUCKET": B}) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])[0]["verified"] is True
