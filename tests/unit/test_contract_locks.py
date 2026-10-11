"""The dashboard's vendored contracts are the files their lock names, byte for byte.

A desk that runs from another repository owns its snapshot contract there. The dashboard keeps copies, pinned by a
lock file with the source repository, path, commit and SHA-256. The dashboard's own tests check the same hashes
(dashboard/test/crypto-contract.test.ts, hft.test.ts); they run only when the dashboard changes, and this runs with
every commit, so a copy edited by hand never passes the required check.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DASH = ROOT / "dashboard"
SHA1, SHA256 = re.compile(r"^[0-9a-f]{40}$"), re.compile(r"^[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_crypto_contract_is_the_one_crypto_lab_tagged():
    lock = json.loads((DASH / "src/lib/crypto.contract.lock.json").read_text())
    assert list(lock) == ["source_repo", "source_tag", "source_commit", "schema", "fixture"]
    assert lock["source_repo"] == "Algorythmos-AI/crypto-lab" and SHA1.match(lock["source_commit"])
    for part, source, path in (("schema", "contracts/crypto.schema.json", "src/lib/crypto.schema.json"),
                               ("fixture", "contracts/crypto.v1.json", "test/fixtures/crypto.v1.json")):
        entry = lock[part]
        assert entry == {"source_path": source, "path": path, "sha256": entry["sha256"]}
        assert SHA256.match(entry["sha256"]) and sha256(DASH / path) == entry["sha256"], f"{path} is not the pinned file"
    # crypto-lab tags a contract by what it is: the first 12 hex digits of the schema's sha256
    assert lock["source_tag"] == "contract-" + lock["schema"]["sha256"][:12]
    schema = json.loads((DASH / "src/lib/crypto.schema.json").read_text())
    fixture = json.loads((DASH / "test/fixtures/crypto.v1.json").read_text())
    assert schema["$id"] == fixture["schema"] == "trading-lab/crypto-snapshot"      # the id ingest files it by


def test_the_hft_contract_is_the_file_its_lock_pins():
    lock = json.loads((DASH / "src/lib/hft.contract.lock.json").read_text())
    assert sha256(DASH / "src/lib/hft.schema.json") == lock["sha256"]


def test_nothing_here_generates_a_vendored_contract():
    """`make schema` writes the stocks schema only; the CI contract step must not expect to regenerate the others."""
    recipe = (ROOT / "Makefile").read_text().split("\nschema:", 1)[1].split("\n\n", 1)[0]
    assert "snapshot.schema.json" in recipe and "crypto" not in recipe and "hft" not in recipe
    step = (ROOT / ".github/workflows/ci.yml").read_text().split("make schema", 1)[1].split("\n      - name:", 1)[0]
    assert "crypto.schema.json" not in step and "hft.schema.json" not in step
