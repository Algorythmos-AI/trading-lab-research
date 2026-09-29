"""Forward ledger integrity (audit PR 5c): one locked, fsynced writer; a sha256 chain over lines; idempotent keys and a
two-phase session, so a run killed between trade rows and their marker leaves no duplicates."""
import datetime as dt
import hashlib
import importlib.util
import json
import sys
import threading
from pathlib import Path

import pytest

from wt.ops.locks import job_lock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
_spec = importlib.util.spec_from_file_location("forward_test", ROOT / "scripts/forward_test.py")
ft = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ft)

D = dt.date(2026, 9, 29)


@pytest.fixture
def log(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "FWD", tmp_path)
    monkeypatch.setattr(ft, "LOG", tmp_path / "forward_trades.jsonl")
    monkeypatch.setattr(ft, "spec_version", lambda: "1.0.1")
    return tmp_path / "forward_trades.jsonl"


def rows(path):
    return [json.loads(x) for x in path.read_text().splitlines()]


def units(d, calls):
    """B trades once; GG-1 of Set F has two trades; every other required strategy trades nothing."""
    def b():
        calls["B"] += 1
        return {"B_qqq_qqqm": [{"strategy": "B_qqq_qqqm", "R": 0.5, "exit": "target"}]}

    def f():
        calls["F"] += 1
        return {"r3:F:GG-1": [{"symbol": "ABC", "entry_time": "2026-09-29 13:31:00+00:00", "R": -1.0},
                              {"symbol": "ABC", "entry_time": "2026-09-29 13:52:00+00:00", "R": 2.0}],
                "r3:F:GG-2": [], "r3:F:GG-3": [], "r3:F:GG-4": []}

    rest = sorted(ft.required(d) - {"B_qqq_qqqm"} - {f"r3:F:GG-{i}" for i in range(1, 5)})
    return ([(("B_qqq_qqqm",), b), (tuple(f"r3:F:GG-{i}" for i in range(1, 5)), f)]
            + [((n,), lambda n=n: {n: []}) for n in rest])


def test_a_run_killed_between_trade_rows_and_the_marker_leaves_no_duplicates(log, monkeypatch):
    calls = {"B": 0, "F": 0}
    real_marker = ft.marker

    def dying_marker(d, name, n):
        if name == "r3:F:GG-1":
            raise KeyboardInterrupt("killed after GG-1's trade rows, before its marker")
        return real_marker(d, name, n)

    monkeypatch.setattr(ft, "marker", dying_marker)
    with pytest.raises(KeyboardInterrupt):
        ft.run_session(D, units(D, calls), set())
    first = rows(log)
    assert first[0]["session_started"] and first[0]["key"] == f"{D}|session_started"
    assert sum(1 for r in first if r.get("strategy") == "r3:F:GG-1" and "R" in r) == 2
    assert not any(r.get("strategy_marker") and r["strategy"] == "r3:F:GG-1" for r in first)

    monkeypatch.setattr(ft, "marker", real_marker)
    done = ft.done_by_session(ft.read_log())[str(D)]
    complete = ft.run_session(D, units(D, calls), done)               # the rerun
    assert ft.required(D) <= complete and calls == {"B": 1, "F": 2}
    everything = rows(log)
    keys = [r["key"] for r in everything if "key" in r]
    assert len(keys) == len(set(keys))                                 # nothing written twice
    assert sum(1 for r in everything if r.get("strategy") == "r3:F:GG-1" and "R" in r) == 2
    assert sum(1 for r in everything if r.get("session_started")) == 1
    sm = [r for r in everything if r.get("session_marker")]
    assert len(sm) == 1 and sm[0]["n_trades"] == 3
    assert ft.verify_chain(log) == []
    assert all(r["git_sha"] and r["ts"].endswith("+00:00") and len(r["prev_sha256"]) == 64 for r in everything)
    assert everything[0]["prev_sha256"] == ft.GENESIS


def test_markers_and_trades_are_idempotent_by_key(log):
    assert ft.append({"session": str(D), "strategy": "x", "strategy_marker": True, "key": f"{D}|x|strategy_marker"})
    assert not ft.append({"session": str(D), "strategy": "x", "strategy_marker": True, "key": f"{D}|x|strategy_marker"})
    assert ft.append({"session": str(D), "strategy": "x", "error": "boom"})    # unkeyed rows (errors) always append
    assert ft.append({"session": str(D), "strategy": "x", "error": "boom"})
    assert len(rows(log)) == 3 and ft.verify_chain(log) == []


def test_tampering_with_a_line_breaks_the_chain(log):
    for i in range(4):
        ft.append({"session": str(D), "strategy": "B_qqq_qqqm", "R": float(i), "key": f"{D}|B|{i}"})
    lines = log.read_text().splitlines()
    assert ft.verify_chain(log) == []
    edited = lines.copy()
    edited[1] = edited[1].replace('"R": 1.0', '"R": 9.0')
    log.write_text("\n".join(edited) + "\n")
    assert ft.verify_chain(log) == ["line 3: prev_sha256 does not match line 2"]
    log.write_text("\n".join(lines[:1] + lines[2:]) + "\n")             # a dropped line
    assert ft.verify_chain(log) == ["line 2: prev_sha256 does not match line 1"]


def test_legacy_rows_stay_as_an_unchained_prefix_and_a_torn_tail_is_closed(log):
    legacy = [json.dumps({"session": "2026-09-28", "strategy": "watchlist_bull_flag_atr_M1", "symbol": "OLD", "R": 1.5}),
              json.dumps({"session": "2026-09-28", "session_marker": True, "n_trades": 1})]
    log.write_text("\n".join(legacy) + "\n")
    ft.append({"session": str(D), "session_started": True, "key": f"{D}|session_started"})
    got = log.read_text().splitlines()
    assert got[:2] == legacy                                           # history untouched
    assert json.loads(got[2])["prev_sha256"] == hashlib.sha256(legacy[1].encode()).hexdigest()
    assert ft.verify_chain(log) == []
    with open(log, "a") as f:
        f.write('{"session": "2026-09-29", "strat')                    # a writer killed mid-line
    ft.append({"session": str(D), "strategy": "x", "error": "retry"})
    assert json.loads(log.read_text().splitlines()[-1])["error"] == "retry"
    assert ft.verify_chain(log) == ["line 4: not a JSON object"]      # reported, and the chain still links past it
    assert len(ft.read_log()) == 4


def test_concurrent_writers_never_interleave_or_fork_the_chain(log):
    def writer(k):
        for i in range(15):
            ft.append({"session": str(D), "strategy": f"w{k}", "R": 0.0, "key": f"{D}|w{k}|{i}"})

    threads = [threading.Thread(target=writer, args=(k,)) for k in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(rows(log)) == 90 and ft.verify_chain(log) == []


def test_a_held_lock_times_out_instead_of_writing(log, monkeypatch):
    monkeypatch.setattr(ft, "LOCK_WAIT_S", 0.2)
    with job_lock(log.name, root=log.parent) as got:
        assert got
        with pytest.raises(TimeoutError):
            ft.append({"session": str(D), "strategy": "x", "error": "late"})
    assert not log.exists()
