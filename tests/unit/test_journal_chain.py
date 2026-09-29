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


def test_unchained_lines_after_a_rollback_are_notes_not_breaks(tmp_path):
    """Older code (a rollback) writes unchained lines. That must not turn entries off for good; the next chained
    line commits to them, so changing them later is still a break."""
    p = tmp_path / "j.jsonl"
    ledger.append(p, {"event": "new code"})
    with open(p, "a") as f:
        f.write('{"event": "old code after a rollback"}\n')
    ledger.append(p, {"event": "new code again"})
    assert ledger.verify_chain(p) == []
    assert ledger.notes(p) == ["line 2: unchained line after the chain started (older code?)"]
    p.write_text(p.read_text().replace("after a rollback", "EDITED"))
    assert ledger.verify_chain(p) == ["line 3: prev_sha256 does not match line 2"]


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
    assert ledger.verify_chain(p) == []                                 # sealed by the next line: not a break
    assert ledger.notes(p) == ["line 2: not a JSON object (a torn line?)"]


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
    assert runner_b.log("loop_error", error="X") is True
    runner_b.log("trade_closed", trade_id="t-1", R=1.0)
    assert len(synced) == 2                                             # every event reaches the disk
    rows = [json.loads(x) for x in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert rows[1]["idem"] == "t-1:trade_closed" and "idem" not in rows[0]
    assert ledger.verify_chain(tmp_path / "journal.jsonl") == []


def test_runner_log_never_raises(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(runner_b, "LIVE", tmp_path)

    def boom(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(ledger, "append", boom)
    assert runner_b.log("trade_closed", trade_id="t-2") is False
    err = capsys.readouterr().err
    assert "JOURNAL WRITE FAILED (OSError)" in err and "t-2" in err
    circular: dict = {}
    circular["self"] = circular
    assert runner_b.log("odd", weird={(1, 2): "tuple key"}, loop=circular) is False    # the fallback can't raise


class _FakeOMS:
    def exit_fill(self, plan):
        return plan.exit_fill_price


def _closed_plan(attempt=0):
    from wt.oms.manager import TradePlan
    return TradePlan(date="2026-10-01", strategy="B", symbol="QQQM", qty=2, trigger=200.2, limit=200.4, stop=199.0,
                     target=203.0, attempt=attempt, filled_qty=2, avg_entry=200.0, exit_fill_price=198.0,
                     exit_reason="stop", state="closed")


def test_a_failed_account_save_is_retried_and_blocks_entries_until_it_lands(tmp_path, monkeypatch):
    import datetime as dt
    from wt.risk.virtual_account import VirtualAccount
    monkeypatch.setattr(runner_b, "LIVE", tmp_path)
    plan = _closed_plan()
    va = VirtualAccount()
    books = runner_b.Books(va, tmp_path / "va.json", readonly=False)
    real_save = VirtualAccount.save
    monkeypatch.setattr(VirtualAccount, "save", lambda self, path: (_ for _ in ()).throw(OSError(28, "full")))
    persisted = []
    day = dt.date(2026, 10, 1)
    books.close(plan, _FakeOMS(), day, day + dt.timedelta(days=1), persisted.append)
    assert books.unsaved and not books.flush() and not plan.recorded and persisted == []
    monkeypatch.setattr(VirtualAccount, "save", real_save)
    books.close(plan, _FakeOMS(), day, day + dt.timedelta(days=1), persisted.append)
    assert books.flush() and plan.recorded and persisted == [plan]
    assert VirtualAccount.load(tmp_path / "va.json").recorded_trades == [plan.trade_id]
    rows = [json.loads(x) for x in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert [r["event"] for r in rows].count("trade_closed") == 1
    assert [r["event"] for r in rows].count("account_save_failed") == 1


def test_a_failed_journal_write_leaves_the_close_to_be_retried(tmp_path, monkeypatch):
    import datetime as dt
    from wt.risk.virtual_account import VirtualAccount
    monkeypatch.setattr(runner_b, "LIVE", tmp_path)
    plan = _closed_plan(attempt=1)
    books = runner_b.Books(VirtualAccount(), tmp_path / "va.json", readonly=False)
    real = ledger.append
    monkeypatch.setattr(ledger, "append", lambda *a, **k: (_ for _ in ()).throw(OSError(28, "full")))
    day = dt.date(2026, 10, 1)
    books.close(plan, _FakeOMS(), day, day, lambda p: None)
    assert not plan.recorded and plan.trade_id not in books.journaled
    monkeypatch.setattr(ledger, "append", real)
    books.close(plan, _FakeOMS(), day, day, lambda p: None)
    assert plan.recorded and plan.trade_id in books.journaled



def test_a_chained_line_commits_to_every_line_since_the_last_chained_one(tmp_path):
    """Second review: editing the chained line before an unchained run, or dropping a line of the run, is a break."""
    p = tmp_path / "j.jsonl"
    ledger.append(p, {"event": "a", "R": -1})
    with open(p, "a") as f:
        f.write('{"event": "old code 1"}\n{"event": "old code 2"}\n')
    ledger.append(p, {"event": "b"})
    assert ledger.verify_chain(p) == []
    lines = p.read_text().splitlines()
    p.write_text("\n".join([lines[0].replace('"R": -1', '"R": 3'), *lines[1:]]) + "\n")
    assert ledger.verify_chain(p)                                   # the edited chained line is caught
    p.write_text("\n".join([lines[0], lines[1], lines[3]]) + "\n")
    assert ledger.verify_chain(p)                                   # a dropped unchained line is caught


def test_fully_chained_and_legacy_files_hash_as_before(tmp_path):
    """Existing ledgers must keep verifying: the new rule equals the old one without unchained runs."""
    import hashlib
    p = tmp_path / "j.jsonl"
    p.write_text('{"event": "legacy 1"}\n{"event": "legacy 2"}\n')
    ledger.append(p, {"event": "x"})
    ledger.append(p, {"event": "y"})
    lines = p.read_bytes().split(b"\n")
    assert json.loads(lines[2])["prev_sha256"] == hashlib.sha256(lines[1]).hexdigest()
    assert json.loads(lines[3])["prev_sha256"] == hashlib.sha256(lines[2]).hexdigest()


def test_a_long_unchained_run_beyond_the_tail_window(tmp_path):
    p = tmp_path / "j.jsonl"
    ledger.append(p, {"event": "start"})
    with open(p, "a") as f:
        for i in range(3000):
            f.write(json.dumps({"event": "old", "i": i, "pad": "x" * 40}) + "\n")
    ledger.append(p, {"event": "after"})
    assert ledger.verify_chain(p) == []


def test_log_survives_a_full_disk_on_the_job_log_too(tmp_path, monkeypatch):
    import sys
    monkeypatch.setattr(runner_b, "LIVE", tmp_path)
    monkeypatch.setattr(ledger, "append", lambda *a, **k: (_ for _ in ()).throw(OSError(28, "full")))

    class Full:
        def write(self, *_):
            raise OSError(28, "No space left on device")

        def flush(self):
            raise OSError(28, "No space left on device")

    monkeypatch.setattr(sys, "stdout", Full())
    monkeypatch.setattr(sys, "stderr", Full())
    assert runner_b.log("loop_error", error="X") is False            # no exception, even with nowhere to print


def test_a_close_whose_failed_write_landed_is_not_journaled_twice(tmp_path, monkeypatch):
    import datetime as dt
    from wt.risk.virtual_account import VirtualAccount
    monkeypatch.setattr(runner_b, "LIVE", tmp_path)
    plan = _closed_plan(attempt=2)
    books = runner_b.Books(VirtualAccount(), tmp_path / "va.json", readonly=False)
    real = ledger.append

    def wrote_then_failed(path, rec, fsync=False):
        real(path, rec, fsync)
        raise OSError(5, "I/O error on fsync")

    monkeypatch.setattr(ledger, "append", wrote_then_failed)
    day = dt.date(2026, 10, 1)
    books.close(plan, _FakeOMS(), day, day, lambda p: None)
    monkeypatch.setattr(ledger, "append", real)
    books.close(plan, _FakeOMS(), day, day, lambda p: None)
    rows = [json.loads(x) for x in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert [r["event"] for r in rows].count("trade_closed") == 1 and plan.recorded
