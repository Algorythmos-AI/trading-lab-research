"""The tape's archive (DEC-0060 section 2.5): write-once uploads, receipts, pruning, restore checks. A fake store."""
from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from wt.lab import archive, manifest


@dataclass
class R:
    status: int
    body: bytes = b""
    etag: str | None = None


class Store:
    def __init__(self, fail_on: str | None = None, bad_etag: bool = False) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts = 0
        self.fail_on, self.bad_etag = fail_on, bad_etag

    def get(self, bucket: str, key: str) -> R:
        return R(200, self.objects[key]) if key in self.objects else R(404)

    def put(self, bucket: str, key: str, body: bytes, if_match: str | None = None,
            if_none_match: str | None = None, content_type: str = "application/json") -> R:
        self.puts += 1
        assert if_none_match == "*" and bucket == "b"
        if self.fail_on and key.endswith(self.fail_on):
            return R(500)
        if key in self.objects:
            return R(412)
        self.objects[key] = body
        return R(200, etag='"' + ("0" * 32 if self.bad_etag else hashlib.md5(body).hexdigest()) + '"')


def session(root: Path, day: str, rows: int = 5) -> Path:
    f = root / day
    f.mkdir(parents=True)
    pq.write_table(pa.table({"x": list(range(rows))}), f / "option-0000.parquet")
    pq.write_table(pa.table({"x": [1]}), f / "gap-0000.parquet")
    manifest.write(f, {"recorded": True})
    return f


def test_a_session_uploads_once_manifest_last_and_gets_a_receipt(tmp_path: Path) -> None:
    f, s = session(tmp_path, "2026-11-19"), Store()
    out = archive.upload(f, s, "b")
    assert out["verified"] and archive.receipt_ok(f)
    assert [o["key"] for o in out["objects"]][-1] == "tape/2026-11-19/manifest.json"
    assert s.objects["tape/2026-11-19/option-0000.parquet"] == (f / "option-0000.parquet").read_bytes()
    assert archive.upload_all(tmp_path, s, "b") == []                 # nothing left to do


def test_a_repeated_upload_accepts_identical_objects_and_refuses_different_ones(tmp_path: Path) -> None:
    f, s = session(tmp_path, "2026-11-19"), Store()
    archive.upload(f, s, "b")
    (f / archive.RECEIPT).unlink()
    assert archive.upload(f, s, "b")["verified"]                     # same bytes already there: fine
    s.objects["tape/2026-11-19/gap-0000.parquet"] = b"other"
    (f / archive.RECEIPT).unlink()
    out = archive.upload(f, s, "b")
    assert not out["verified"] and "exists with other bytes" in out["problems"][0] and not archive.receipt_ok(f)


def test_a_failed_put_a_wrong_etag_or_a_changed_file_writes_no_receipt(tmp_path: Path) -> None:
    f = session(tmp_path, "2026-11-19")
    assert archive.upload(f, Store(fail_on="gap-0000.parquet"), "b")["problems"] == [
        "status 500 on tape/2026-11-19/gap-0000.parquet"]
    assert archive.upload(f, Store(bad_etag=True), "b")["problems"][0].startswith("etag mismatch")
    (f / "option-0000.parquet").write_bytes(b"changed")
    out = archive.upload(f, Store(), "b")
    assert out["problems"] == ["changed option-0000.parquet"] and not archive.receipt_ok(f)


def test_a_receipt_stops_counting_when_the_manifest_changes(tmp_path: Path) -> None:
    f = session(tmp_path, "2026-11-19")
    archive.upload(f, Store(), "b")
    manifest.write(f, {"recorded": True, "note": "rewritten"})
    assert not archive.receipt_ok(f)


def test_prune_keeps_the_newest_and_removes_only_verified_sessions(tmp_path: Path) -> None:
    days = [f"2026-11-{d:02d}" for d in (10, 11, 12, 13, 14)]
    folders = [session(tmp_path, d) for d in days]
    s = Store()
    for f in folders[1:]:
        archive.upload(f, s, "b")
    gone = archive.prune(tmp_path, keep=2)
    assert gone == ["2026-11-11", "2026-11-12"]                       # 11-10 was never uploaded: kept
    assert sorted(p.name for p in tmp_path.iterdir() if p.is_dir()) == ["2026-11-10", "2026-11-13", "2026-11-14"]
    assert (tmp_path / manifest.HEAD).exists()                      # the chain head outlives the pruned folders


def test_an_unfinished_session_is_neither_uploaded_nor_pruned(tmp_path: Path) -> None:
    (tmp_path / "2026-11-19").mkdir()
    (tmp_path / "2026-11-19" / "option-0000.parquet").write_bytes(b"x")
    assert archive.upload_all(tmp_path, Store(), "b") == [] and archive.prune(tmp_path, keep=0) == []


def test_the_weekly_check_finds_a_changed_object(tmp_path: Path) -> None:
    s = Store()
    for d in ("2026-11-18", "2026-11-19"):
        archive.upload(session(tmp_path, d), s, "b")
    assert archive.check(s, "b", tmp_path, parts=10, rng=random.Random(1)) == {"checked": 6, "bad": []}
    s.objects["tape/2026-11-19/option-0000.parquet"] = b"rot"
    assert archive.check(s, "b", tmp_path, parts=10, rng=random.Random(1))["bad"] == ["tape/2026-11-19/option-0000.parquet"]


def test_main_refuses_without_the_labs_own_credentials(tmp_path: Path, capsys: Any) -> None:
    env = {"WT_LAB_TAPE": str(tmp_path), "R2_ACCOUNT_ID": "a", "R2_ACCESS_KEY_ID": "shared", "R2_SECRET_ACCESS_KEY": "x"}
    assert archive.main(["upload"], env=env) == 2                    # the backup's own token is never used
    session(tmp_path, "2026-11-19")
    assert archive.main(["upload"], store=Store(), env={**env, "WT_LAB_BUCKET": "b"}) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])[0]["verified"] is True
