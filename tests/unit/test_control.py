"""R7: owner control actions refuse while paper B runs, are recorded, and latch persistence is ordered safely."""
import json
import multiprocessing as mp
import os

import pytest

from wt.ops import audit, control, locks
from wt.risk.virtual_account import StateError, VirtualAccount


def _hold(lock_root, ready, stop):
    with locks.job_lock("paper-b", lock_root):
        ready.set()
        stop.wait(10)


@pytest.fixture
def runner(tmp_path):
    """A second process holding paper-b's lock, like a live runner."""
    ctx = mp.get_context("spawn")
    ready, stop = ctx.Event(), ctx.Event()
    p = ctx.Process(target=_hold, args=(tmp_path / "locks", ready, stop))
    p.start()
    assert ready.wait(10)
    yield tmp_path / "locks"
    stop.set()
    p.join(10)


def test_unkill_refuses_while_the_runner_holds_its_lock(tmp_path, runner):
    (tmp_path / "KILL").write_text("paused")
    code, msg = control.unkill(root=tmp_path, lock_root=runner, audit_log=tmp_path / "a.jsonl")
    assert code == 3 and "running" in msg and (tmp_path / "KILL").exists()
    assert not (tmp_path / "a.jsonl").exists()


def test_unkill_when_idle_removes_kill_and_audits(tmp_path):
    (tmp_path / "KILL").write_text("paused")
    code, _ = control.unkill(root=tmp_path, lock_root=tmp_path / "locks", audit_log=tmp_path / "a.jsonl")
    assert code == 0 and not (tmp_path / "KILL").exists()
    rows = audit.read(tmp_path / "a.jsonl")
    assert [r["kind"] for r in rows] == ["kill_off"] and audit.verify(rows) == (True, None)
    assert control.unkill(root=tmp_path, lock_root=tmp_path / "locks")[1] == "KILL switch already off"


def test_reset_latch_refuses_while_running_and_needs_a_reason(tmp_path, runner):
    va = VirtualAccount()
    va.latch("daily loss limit -2%")
    va.save(tmp_path / "va.json")
    assert control.reset_latch("safe now", va_path=tmp_path / "va.json", lock_root=runner)[0] == 3
    assert VirtualAccount.load(tmp_path / "va.json").latched
    assert control.reset_latch("  ", va_path=tmp_path / "va.json", lock_root=tmp_path / "idle")[0] == 2


def test_reset_latch_when_idle_clears_and_records(tmp_path):
    va = VirtualAccount()
    va.latch("weekly loss limit -4%")
    va.save(tmp_path / "va.json")
    code, _ = control.reset_latch("reviewed the losses", va_path=tmp_path / "va.json", lock_root=tmp_path / "l")
    got = VirtualAccount.load(tmp_path / "va.json")
    assert code == 0 and not got.latched and not (tmp_path / "va.json.latch").exists()
    assert got.latch_history[-1]["reason"] == "weekly loss limit -4%"


def test_a_failed_account_write_cannot_lose_a_latch(tmp_path, monkeypatch):
    """The sentinel is durable before the account is replaced: if that write fails, load() refuses to arm."""
    path = tmp_path / "va.json"
    VirtualAccount().save(path)
    va = VirtualAccount.load(path)
    va.latch("daily loss limit -2%")
    real_replace = os.replace

    def failing_replace(src, dst):
        if str(dst) == str(path):
            raise OSError(28, "No space left on device")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", failing_replace)
    with pytest.raises(OSError):
        va.save(path)
    monkeypatch.setattr(os, "replace", real_replace)
    assert (tmp_path / "va.json.latch").exists()
    assert json.loads(path.read_text())["latched"] is False
    with pytest.raises(StateError):
        VirtualAccount.load(path)


def test_an_unlatch_removes_the_sentinel_only_after_the_account_says_so(tmp_path, monkeypatch):
    path = tmp_path / "va.json"
    va = VirtualAccount()
    va.latch("x")
    va.save(path)
    va.latched, va.latch_reason = False, ""
    real_replace = os.replace
    monkeypatch.setattr(os, "replace", lambda s, d: (_ for _ in ()).throw(OSError(28, "full")))
    with pytest.raises(OSError):
        va.save(path)
    monkeypatch.setattr(os, "replace", real_replace)
    assert (tmp_path / "va.json.latch").exists() and VirtualAccount.load(path).latched   # still latched: safe side


def test_cli_usage():
    assert control.main(["bogus"]) == 2
