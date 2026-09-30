"""wt.ops.hostsync: exactly the right files move, a seed that differs from its manifest by one byte is refused, a broken
chain is refused, and apply swaps unit by unit under every lock, archiving what it replaces."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from wt.core import ledger
from wt.ops import hostsync, locks


def chained(path: Path, n: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    prev, lines = ledger.GENESIS, []
    for i in range(n):
        line = json.dumps({"i": i, "prev_sha256": prev}).encode()
        lines.append(line)
        prev = hashlib.sha256(line).hexdigest()
    path.write_bytes(b"\n".join(lines) + b"\n")


def put(root: Path, rel: str, body: str = "x") -> None:
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(body)


@pytest.fixture
def mac(tmp_path) -> Path:
    r = tmp_path / "mac"
    chained(r / "var/forward/forward_trades.jsonl", 3)
    chained(r / "data/live/journal.jsonl", 4)
    for rel in ("var/watchlist/2026-09-29.json", "var/heartbeats/runs.jsonl", "var/alerts/state.json",
                "data/daily/chunks/chunk_00000.parquet", "data/pm/pm_agg.parquet", "data/minute/2026-09-29/A.parquet",
                "data/intraday_volume_curve_2019.npy", "data/signal_spreads.json"):
        put(r, rel)
    # never carried
    for rel in ("var/forward/forward_trades.jsonl.lock", "var/dashboard/cache/host.json", "var/deploy/x.json",
                "var/locks/paper-b.lock", "var/alerts/spool/1.json", "var/evidence/chain-broken", "KILL", ".env",
                "data/.alpaca_rate.json", "data/_quarantine/chunk_zupd_2026-09-25.parquet",
                "data/minute_liquid/A.parquet", "data/pm/pm-cache.lock", "data/pm/.pm_agg.parquet.x.tmp",
                "data/daily/chunks/chunk_1.parquet.corrupt", "watchlist/2026-01-01.json", "logs/launchd_routine.err"):
        put(r, rel)
    return r


def ship(src: Path, dest: Path) -> Path:
    """What wt-seed-vm does, without the network: the manifest plus a byte-for-byte copy of the listed files."""
    m = hostsync.manifest(src)
    for rel in hostsync.files(src):
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        (dest / rel).write_bytes((src / rel).read_bytes())
    (dest / hostsync.MANIFEST).write_text(json.dumps(m))
    return dest


def test_the_seed_carries_state_and_nothing_host_specific(mac):
    got = set(hostsync.files(mac))
    assert "var/forward/forward_trades.jsonl" in got and "data/live/journal.jsonl" in got
    assert "data/intraday_volume_curve_2019.npy" in got and "data/daily/chunks/chunk_00000.parquet" in got
    for never in ("KILL", ".env", "var/dashboard", "var/deploy", "var/locks", "spool", "chain-broken", ".alpaca_rate",
                  "_quarantine", "minute_liquid", ".lock", ".tmp", ".corrupt", "watchlist/2026-01-01", "logs/"):
        assert not any(never in f for f in got), never


def test_a_faithful_copy_verifies(mac, tmp_path):
    seed = ship(mac, tmp_path / "seed")
    assert hostsync.verify(seed) == []


@pytest.mark.parametrize("damage", ["tamper", "missing", "extra", "no_manifest"])
def test_any_difference_from_the_manifest_is_refused(mac, tmp_path, damage):
    seed = ship(mac, tmp_path / "seed")
    if damage == "tamper":
        (seed / "data/pm/pm_agg.parquet").write_text("y")          # same size, other bytes
    elif damage == "missing":
        (seed / "var/heartbeats/runs.jsonl").unlink()
    elif damage == "extra":
        put(seed, "data/daily/chunks/._chunk_00000.parquet")        # e.g. a macOS AppleDouble file
    else:
        (seed / hostsync.MANIFEST).unlink()
    assert hostsync.verify(seed)


def test_a_broken_chain_is_refused_even_when_the_bytes_match(mac, tmp_path):
    j = mac / "data/live/journal.jsonl"
    lines = j.read_bytes().split(b"\n")
    lines[1] = lines[1].replace(b'"i": 1', b'"i": 7')
    j.write_bytes(b"\n".join(lines))
    seed = ship(mac, tmp_path / "seed")
    assert any("chain data/live/journal.jsonl" in p for p in hostsync.verify(seed))
    ok, msgs = hostsync.apply(seed, tmp_path / "vm", lock_root=tmp_path / "locks")
    assert not ok and "refused" in msgs[0]


def test_apply_swaps_in_and_archives_what_it_replaces(mac, tmp_path):
    vm = tmp_path / "home" / "trading"
    chained(vm / "data/live/journal.jsonl", 9)                     # tonight's shadow journal on the VM
    put(vm, "KILL", "vm kill")
    put(vm, "var/alerts/spool/vm.json")
    seed = ship(mac, tmp_path / "home" / "seed-1")
    ok, msgs = hostsync.apply(seed, vm, lock_root=tmp_path / "locks")
    assert ok, msgs
    assert (vm / "data/live/journal.jsonl").read_bytes() == (mac / "data/live/journal.jsonl").read_bytes()
    assert (vm / "KILL").read_text() == "vm kill"                  # the VM keeps its own KILL
    assert (vm / "var/alerts/spool/vm.json").exists()              # and its own spool
    archived = next((tmp_path / "home" / "archive").glob("hostsync-*"))
    assert ledger.head(archived / "data/live/journal.jsonl")[0] == 9   # the shadow journal is kept, not lost
    rec = json.loads(next((vm / "var/hostsync").glob("*.json")).read_text())
    assert rec["chains"]["data/live/journal.jsonl"][0] == 4
    assert not seed.exists()


def test_apply_refuses_while_a_job_holds_its_lock(mac, tmp_path):
    vm = tmp_path / "vm"
    put(vm, "data/live/journal.jsonl", "")
    seed = ship(mac, tmp_path / "seed")
    with locks.job_lock("paper-b", tmp_path / "locks"):
        ok, msgs = hostsync.apply(seed, vm, lock_root=tmp_path / "locks")
    assert not ok and "paper-b" in msgs[0]
    assert (vm / "data/live/journal.jsonl").read_text() == "" and seed.exists()   # nothing changed


def test_the_seed_script_never_stages_on_the_mac_and_strips_mac_metadata():
    text = (Path(__file__).resolve().parents[2] / "deploy/gcp/bin/wt-seed-vm").read_text()
    assert "--tunnel-through-iap" in text and "COPYFILE_DISABLE=1" in text and "--no-mac-metadata" in text
    assert 'launchctl list 2>/dev/null | grep -q com.wt' in text          # APPLY refuses while Mac agents are loaded
    assert "verify --dir" in text and text.index("verify --dir") < text.index("apply --from")
