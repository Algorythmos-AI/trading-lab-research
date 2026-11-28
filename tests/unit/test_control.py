"""R7: owner control actions refuse while paper B runs, are recorded, and latch persistence is ordered safely."""
import json
import multiprocessing as mp
import os

import pytest

from wt.ops import audit, control, locks
from wt.risk.virtual_account import StateError, VirtualAccount


def _hold(lock_root, ready, stop, name="paper-b"):
    with locks.job_lock(name, lock_root):
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


@pytest.mark.parametrize("held, who", [("paper-s", "Gap Hunter"), (locks.RUNNER_LOCK_S, "Gap Hunter"),
                                       ("paper-o", "options clone"), (control.RUNNER_LOCK_O, "options clone")])
def test_root_unkill_refuses_while_gap_hunter_or_the_clone_runs(tmp_path, held, who):
    """The root KILL stops Gap Hunter too: removing it mid-session would re-enable its entries."""
    ctx = mp.get_context("spawn")
    ready, stop = ctx.Event(), ctx.Event()
    p = ctx.Process(target=_hold, args=(tmp_path / "locks", ready, stop, held))
    p.start()
    try:
        assert ready.wait(10)
        (tmp_path / "KILL").write_text("paused")
        code, msg = control.unkill(root=tmp_path, lock_root=tmp_path / "locks", audit_log=tmp_path / "a.jsonl")
        assert code == 3 and who in msg and (tmp_path / "KILL").exists()
        assert not (tmp_path / "a.jsonl").exists()
    finally:
        stop.set()
        p.join(10)


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


def test_a_reset_with_nothing_latched_records_nothing(tmp_path):
    VirtualAccount().save(tmp_path / "va.json")
    code, msg = control.reset_latch("just checking", va_path=tmp_path / "va.json", lock_root=tmp_path / "l")
    assert code == 0 and "not latched" in msg
    assert VirtualAccount.load(tmp_path / "va.json").latch_history == []


def test_a_reset_of_a_sentinel_only_latch_keeps_the_sentinels_reason(tmp_path):
    path = tmp_path / "va.json"
    VirtualAccount().save(path)
    (tmp_path / "va.json.latch").write_text("daily loss limit -2%")          # the account write had failed
    with pytest.raises(StateError):
        VirtualAccount.load(path)
    assert control.reset_latch("reviewed", va_path=path, lock_root=tmp_path / "l")[0] == 0
    got = VirtualAccount.load(path)
    assert got.latch_history[-1]["reason"] == "daily loss limit -2%" and not got.latched


def test_the_sentinel_exists_even_when_its_reason_cant_be_written(tmp_path, monkeypatch):
    """On a full disk the empty sentinel (no data blocks) still latches; only the reason text is lost."""
    import wt.risk.virtual_account as vam
    path = tmp_path / "va.json"
    VirtualAccount().save(path)
    va = VirtualAccount.load(path)
    va.latch("weekly loss limit -4%")

    def full(p, text):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(vam, "_durable_write", full)
    with pytest.raises(OSError):
        va.save(path)
    assert (tmp_path / "va.json.latch").exists()
    with pytest.raises(StateError):
        VirtualAccount.load(path)


def test_control_actions_release_the_lock_afterwards(tmp_path):
    (tmp_path / "KILL").write_text("x")
    assert control.unkill(root=tmp_path, lock_root=tmp_path / "locks", audit_log=tmp_path / "a.jsonl")[0] == 0
    assert not locks.is_held("paper-b", tmp_path / "locks")



@pytest.fixture
def orphan_runner(tmp_path):
    """A runner orphaned by a dead jobs.py wrapper: it holds only its own process lock."""
    ctx = mp.get_context("spawn")
    ready, stop = ctx.Event(), ctx.Event()
    p = ctx.Process(target=_hold, args=(tmp_path / "locks", ready, stop, locks.RUNNER_LOCK))
    p.start()
    assert ready.wait(10)
    yield tmp_path / "locks"
    stop.set()
    p.join(10)


def test_an_orphaned_runner_still_blocks_unkill_and_reset(tmp_path, orphan_runner):
    (tmp_path / "KILL").write_text("paused")
    assert control.unkill(root=tmp_path, lock_root=orphan_runner, audit_log=tmp_path / "a.jsonl")[0] == 3
    va = VirtualAccount()
    va.latch("x")
    va.save(tmp_path / "va.json")
    assert control.reset_latch("safe", va_path=tmp_path / "va.json", lock_root=orphan_runner)[0] == 3


def test_a_second_runner_process_refuses_to_start(tmp_path, orphan_runner, monkeypatch):
    from wt.live import runner_b
    from wt.ops import alerts
    monkeypatch.setenv("MODE", "paper")
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    monkeypatch.setattr(locks, "LOCK_DIR", orphan_runner)
    monkeypatch.setattr(alerts, "ALERT_DIR", tmp_path / "alerts")
    monkeypatch.setattr(runner_b, "LIVE", tmp_path / "live")
    monkeypatch.setattr(runner_b, "RUNNER_LOCK_WAIT_S", 0.3)

    def must_not_run(*a, **k):
        raise AssertionError("a second runner must not start a session")

    monkeypatch.setattr(runner_b, "_session", must_not_run)
    runner_b.run()                                           # production path: no broker injected
    rows = [json.loads(x) for x in (tmp_path / "live" / "journal.jsonl").read_text().splitlines()]
    assert rows[-1]["event"] == "refuse_to_arm" and "runner lock held" in rows[-1]["reason"]



def test_control_leaves_the_runner_lock_alone_while_the_wrapper_holds_the_job(tmp_path, runner):
    """Second review: probing the runner's lock while paper-b is starting could make the real runner refuse."""
    (tmp_path / "KILL").write_text("x")
    assert control.unkill(root=tmp_path, lock_root=runner, audit_log=tmp_path / "a.jsonl")[0] == 3
    # the job lock was busy, so the runner lock was never taken: a runner starting now would get it
    with locks.job_lock(locks.RUNNER_LOCK, runner) as got:
        assert got


def test_reset_refuses_on_a_missing_or_corrupt_account(tmp_path):
    path = tmp_path / "va.json"
    (tmp_path / "va.json.latch").write_text("daily loss limit -2%")
    code, msg = control.reset_latch("safe", va_path=path, lock_root=tmp_path / "l")
    assert code == 4 and "missing" in msg and not path.exists()             # no fresh US$600 account
    path.write_text("{not json")
    code, msg = control.reset_latch("safe", va_path=path, lock_root=tmp_path / "l")
    assert code == 4 and "unreadable" in msg and path.read_text() == "{not json"


def test_a_read_only_sentinel_does_not_break_saves(tmp_path):
    path = tmp_path / "va.json"
    va = VirtualAccount()
    va.latch("x")
    va.save(path)
    os.chmod(tmp_path / "va.json.latch", 0o444)
    va.equity -= 1
    va.save(path)                                                           # no PermissionError
    assert VirtualAccount.load(path).latched


def test_the_deploy_gate_counts_the_runner_lock(tmp_path, orphan_runner, monkeypatch):
    from wt.ops import deploy
    monkeypatch.setattr(locks, "LOCK_DIR", orphan_runner)
    seen = {}

    def blockers(now, sessions, running, held_locks, exact):
        seen["held"] = held_locks
        return []

    monkeypatch.setattr(deploy, "deploy_blockers", blockers)
    monkeypatch.setattr(deploy, "load_sessions", lambda now: ({}, True))
    monkeypatch.setattr(deploy, "running_jobs", lambda: {})
    deploy.gate_blockers()
    assert locks.RUNNER_LOCK in seen["held"]


# ---------------------------------------------------------------- every desk's kill file (audit 2026-11-25)
def test_desk_kill_paths_are_the_ones_the_runners_read():
    from wt.core.desk import DESKS
    from wt.live import runner_s
    assert control.KILL_S == runner_s.KILL
    assert control.KILL_OPTIONS == DESKS["options"].kill_file
    assert set(control.DESK_KILLS) == {"root", "s", "options"}
    assert control.desk_name("") == control.desk_name("stocks") == "root" and control.desk_name(" S ") == "s"


@pytest.mark.parametrize("desk", ["s", "options"])
def test_unkill_a_desk_file_removes_it_and_audits_with_the_desk(tmp_path, runner, desk):
    """A desk's own file is removed as `rm` would (no lock check: its runner re-reads the file and logs the change)
    and the audit row names the desk. The root file is not touched."""
    (tmp_path / "KILL").write_text("root")
    f = tmp_path / desk / "KILL"
    f.parent.mkdir()
    f.write_text("paused")
    log = tmp_path / "a.jsonl"
    code, msg = control.unkill(root=tmp_path, lock_root=runner, audit_log=log, desk=desk, kill_file=f)
    assert code == 0 and msg == f"{desk} KILL switch off" and not f.exists() and (tmp_path / "KILL").exists()
    rows = audit.read(log)
    assert [(r["kind"], r["detail"]) for r in rows] == [("kill_off", desk)] and audit.verify(rows) == (True, None)
    assert control.unkill(audit_log=log, desk=desk, kill_file=f) == (0, f"{desk} KILL switch already off")
    assert len(audit.read(log)) == 1                      # nothing removed, nothing recorded


def test_unkill_refuses_an_unknown_desk_rather_than_the_root_file(tmp_path):
    (tmp_path / "KILL").write_text("root")
    code, msg = control.unkill(root=tmp_path, lock_root=tmp_path / "l", audit_log=tmp_path / "a.jsonl", desk="gap")
    assert code == 2 and "unknown desk" in msg and (tmp_path / "KILL").exists()
    assert control.main(["unkill", "gap"]) == 2


def test_root_unkill_audit_names_the_root_file(tmp_path):
    (tmp_path / "KILL").write_text("paused")
    control.unkill(root=tmp_path, lock_root=tmp_path / "locks", audit_log=tmp_path / "a.jsonl")
    assert [r["detail"] for r in audit.read(tmp_path / "a.jsonl")] == ["root"]


def _make(target, desk, state, **extra):
    import shutil
    import subprocess
    import sys
    from pathlib import Path
    if shutil.which("make") is None:
        pytest.skip("make not installed")
    repo = Path(__file__).resolve().parents[2]
    env = {**os.environ, "WT_STATE": str(state), "PYTHONPATH": str(repo / "src"), **extra}
    return subprocess.run(["make", "-s", "-C", str(repo), target, f"DESK={desk}", f"PY={sys.executable}"],
                          env=env, capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize(("desk", "sub"), [("s", "smallcap"), ("options", "options")])
def test_make_kill_and_unkill_a_desk_write_its_file_and_audit_both(tmp_path, desk, sub):
    on = _make("kill", desk, tmp_path, REASON="testing")
    f = tmp_path / sub / "KILL"
    assert on.returncode == 0, on.stderr
    assert f.read_text().startswith("testing (")
    off = _make("unkill", desk, tmp_path)
    assert off.returncode == 0, off.stderr
    assert not f.exists()
    rows = audit.read(tmp_path / "audit" / "events.jsonl")
    assert [(r["kind"], r["detail"]) for r in rows] == [("kill_on", desk), ("kill_off", desk)]


def test_make_kill_refuses_an_unknown_desk_and_writes_nothing(tmp_path):
    got = _make("kill", "gap", tmp_path)
    assert got.returncode != 0 and "unknown DESK=gap" in got.stderr
    assert not any(tmp_path.rglob("KILL"))


# ---------------------------------------------------------------- what shows each desk's kill file
@pytest.fixture
def desk_files(tmp_path, monkeypatch):
    s, o = tmp_path / "smallcap" / "KILL", tmp_path / "options" / "KILL"
    monkeypatch.setattr(control, "KILL_S", s)
    monkeypatch.setattr(control, "KILL_OPTIONS", o)
    monkeypatch.setattr(control, "DESK_KILLS", {"root": None, "options": o, "s": s})
    return {"root": tmp_path / "KILL", "s": s, "options": o}


def test_kill_states_read_every_desk_file(tmp_path, desk_files):
    assert control.kill_states(tmp_path) == {"root": False, "options": False, "s": False}
    assert control.paused_note(tmp_path) == ""
    desk_files["s"].parent.mkdir()
    desk_files["s"].write_text("x")
    assert control.kill_states(tmp_path) == {"root": False, "options": False, "s": True}
    assert control.paused_note(tmp_path) == " Kill switch on: Gap Hunter. New entries there are paused."


def test_make_status_shows_gap_hunter_on_when_only_its_file_is(tmp_path, desk_files, monkeypatch, capsys):
    """The audit's case: the root file off, Gap Hunter's on. Status used to print one `off`."""
    from wt.ops import jobs
    desk_files["s"].parent.mkdir()
    desk_files["s"].write_text("x")
    monkeypatch.setattr(jobs, "last_runs", lambda: {})
    monkeypatch.setattr(jobs, "cadence", lambda: [])
    monkeypatch.setattr("wt.ops.alerts.Alerts.firing", lambda self: {})
    monkeypatch.setattr("wt.ops.preflight.run_checks", lambda root: [])
    assert jobs.status(tmp_path) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("KILL switches")
    assert out[1].split() == ["Gap", "Hunter", "ON", "(no", "new", "entries)"]
    assert out[2].split() == ["Options", "clone", "off"]
    assert out[3].split() == ["All", "desks", "(root", "KILL)", "off"]


def test_the_clone_lock_named_here_is_the_runner_s():
    from wt.live import runner_o
    assert control.RUNNER_LOCK_O == runner_o.LOCK
