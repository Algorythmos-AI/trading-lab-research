"""R3: the paper journal is hash-chained through wt.core.ledger.append, fsyncs the events G2 rests on, and still
never raises."""
import json
import multiprocessing as mp
import os

from wt.core import ledger
from wt.live import runner_b


def test_append_chains_from_genesis_and_verifies(tmp_path):
    p = tmp_path / "j.jsonl"
    for i in range(5):
        ledger.append(p, {"event": "x", "i": i})
    rows = [json.loads(x) for x in p.read_text().splitlines()]
    assert rows[0]["prev_sha256"] == ledger.GENESIS
    assert ledger.verify_chain(p) == []


def test_an_unchained_prefix_is_accepted_and_the_chain_starts_after_it(tmp_path):
    p = tmp_path / "j.jsonl"
    p.write_text('{"event": "old"}\n{"event": "older"}\n')
    ledger.append(p, {"event": "new"})
    assert ledger.verify_chain(p) == []
    p.write_text(p.read_text() + '{"event": "sneaky, unchained"}\n')
    assert ledger.verify_chain(p) == ["line 4: no prev_sha256 after the chain started"]


def test_edits_and_deletions_are_detected(tmp_path):
    p = tmp_path / "j.jsonl"
    for i in range(4):
        ledger.append(p, {"event": "x", "R": i})
    lines = p.read_text().splitlines()
    p.write_text("\n".join([lines[0], lines[1].replace('"R": 1', '"R": 9'), *lines[2:]]) + "\n")
    assert ledger.verify_chain(p) == ["line 3: prev_sha256 does not match line 2"]
    p.write_text("\n".join([lines[0], *lines[2:]]) + "\n")
    assert ledger.verify_chain(p)


def test_a_torn_last_line_is_ended_not_glued(tmp_path):
    p = tmp_path / "j.jsonl"
    ledger.append(p, {"event": "a"})
    with open(p, "ab") as f:
        f.write(b'{"event": "torn')                       # a writer killed mid-line
    ledger.append(p, {"event": "b"})
    lines = p.read_text().splitlines()
    assert lines[1] == '{"event": "torn' and json.loads(lines[2])["event"] == "b"
    assert ledger.verify_chain(p) == ["line 2: not a JSON object"]      # reported, and the chain continues


def test_a_last_line_longer_than_the_tail_window(tmp_path):
    p = tmp_path / "j.jsonl"
    ledger.append(p, {"event": "big", "blob": "x" * (ledger.TAIL * 2)})
    ledger.append(p, {"event": "after"})
    assert ledger.verify_chain(p) == []


def _writer(path, n):
    for i in range(n):
        ledger.append(path, {"event": "w", "pid": os.getpid(), "i": i})


def test_concurrent_writers_keep_one_chain(tmp_path):
    p = tmp_path / "j.jsonl"
    ctx = mp.get_context("spawn")
    procs = [ctx.Process(target=_writer, args=(p, 40)) for _ in range(3)]
    for pr in procs:
        pr.start()
    for pr in procs:
        pr.join(30)
    assert len(p.read_text().splitlines()) == 120 and ledger.verify_chain(p) == []


def test_runner_log_chains_fsyncs_durable_events_and_adds_idem(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_b, "LIVE", tmp_path)
    synced = []
    real = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (synced.append(fd), real(fd))[1])
    runner_b.log("loop_error", error="X")
    assert synced == []
    runner_b.log("trade_closed", trade_id="t-1", R=1.0)
    assert len(synced) == 1
    rows = [json.loads(x) for x in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert rows[1]["idem"] == "t-1:trade_closed" and "idem" not in rows[0]
    assert ledger.verify_chain(tmp_path / "journal.jsonl") == []


def test_runner_log_never_raises(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(runner_b, "LIVE", tmp_path)

    def boom(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(ledger, "append", boom)
    runner_b.log("trade_closed", trade_id="t-2")
    err = capsys.readouterr().err
    assert "JOURNAL WRITE FAILED (OSError)" in err and "t-2" in err
