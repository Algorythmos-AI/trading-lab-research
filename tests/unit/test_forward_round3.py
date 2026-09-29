"""forward_test: round-3 trials nightly (DEC-0010) and D7 bookkeeping (per-strategy markers, catch-up, retries)."""
import datetime as dt
import importlib.util
import json
from pathlib import Path

import pandas as pd
import pytest
import yaml

from wt.core.clock import ET
from wt.data.alpaca import SIP_DELAY_MIN, sip_safe_end

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


ft = load("forward_test")
bp = load("build_pool")


@pytest.fixture
def log(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "FWD", tmp_path)
    monkeypatch.setattr(ft, "LOG", tmp_path / "forward_trades.jsonl")
    monkeypatch.setattr(ft, "spec_version", lambda: "1.0.1")
    return tmp_path / "forward_trades.jsonl"


def rows(path):
    return [json.loads(x) for x in path.read_text().splitlines()]


def test_round3_strategies_map_to_their_preregistered_hypotheses():
    for name, hyp in ft.R3_HYP.items():
        f = next((ROOT / "research/hypotheses").glob(f"{hyp}-*.yaml"))
        h = yaml.safe_load(f.read_text())
        assert h["id"] == hyp and str(h["trial"]).replace(":", "") in name.replace(":", ""), (name, h["trial"])
        assert h["status"] == "pre-registered"
    assert len(ft.R3_HYP) == 10


def test_required_strategies_by_date():
    # the v2 flags wait for DEC-0011 (V2_FROM is None until it is accepted); B and round 3 run as before
    assert ft.required(dt.date(2026, 9, 28)) == {"B_qqq_qqqm"} | set(ft.R3_HYP)
    assert ft.required(dt.date(2026, 9, 25)) == {"B_qqq_qqqm"}


def test_a_pre_d7_session_marker_covers_the_legacy_strategies_unless_that_session_errored():
    done = ft.done_by_session([
        {"session": "2026-09-28", "session_marker": True, "n_trades": 0},
        {"session": "2026-09-29", "error": "boom"}, {"session": "2026-09-29", "session_marker": True},
        {"session": "2026-09-30", "strategy": "r3:MP-1", "strategy_marker": True, "n_trades": 0},
    ])
    assert done["2026-09-28"] == set(ft.LEGACY_V1)                  # the legacy strategies of that time
    assert done["2026-09-29"] == set()
    assert done["2026-09-30"] == {"r3:MP-1"}


def test_pending_sessions_never_reach_the_holdout_and_keep_the_newest():
    sessions = [dt.date(2026, 9, 24), dt.date(2026, 9, 25)] + [dt.date(2026, 9, 28) + dt.timedelta(days=i) for i in range(12)]
    sessions = [d for d in sessions if d.weekday() < 5]
    closes = {d: "16:00" for d in sessions}
    now = dt.datetime(2026, 10, 9, 16, 20, tzinfo=ET)             # 20 min after the 2026-10-09 close
    done = {"2026-09-28": set(ft.required(dt.date(2026, 9, 28)))}
    got = ft.pending_sessions(sessions, closes, now, done, max_n=5)
    assert got == [dt.date(2026, 10, 5), dt.date(2026, 10, 6), dt.date(2026, 10, 7), dt.date(2026, 10, 8), dt.date(2026, 10, 9)]
    assert all(d >= ft.FORWARD_FROM for d in ft.pending_sessions(sessions, closes, now, {}, max_n=50))
    early = dt.datetime(2026, 10, 9, 16, 10, tzinfo=ET)            # the close is only 10 minutes old
    assert dt.date(2026, 10, 9) not in ft.pending_sessions(sessions, closes, early, done, max_n=50)


def test_a_failing_unit_is_retried_next_run_without_duplicating_the_others(log):
    d = dt.date(2026, 9, 29)
    calls = {"B": 0, "F": 0}
    state = {"fail_f": True}

    def unit_b():
        calls["B"] += 1
        return {"B_qqq_qqqm": [{"strategy": "B_qqq_qqqm", "R": 0.5}]}

    def unit_f():
        calls["F"] += 1
        if state["fail_f"]:
            raise RuntimeError("pool build failed")
        return {"r3:F:GG-1": [{"symbol": "ABC", "R": -1.0}], "r3:F:GG-2": [], "r3:F:GG-3": [], "r3:F:GG-4": []}

    def others():
        names = ft.required(d) - {"B_qqq_qqqm", "r3:F:GG-1", "r3:F:GG-2", "r3:F:GG-3", "r3:F:GG-4"}
        return [((n,), lambda n=n: {n: []}) for n in sorted(names)]

    units = [(("B_qqq_qqqm",), unit_b), (tuple(f"r3:F:GG-{i}" for i in range(1, 5)), unit_f)] + others()
    complete = ft.run_session(d, units, set())
    assert not ft.required(d) <= complete
    first = rows(log)
    assert any(r.get("error") and r["strategy"].startswith("r3:F:GG-1") for r in first)
    assert not any(r.get("session_marker") for r in first)

    state["fail_f"] = False
    done = ft.done_by_session(first)[str(d)]
    complete = ft.run_session(d, units, done)
    assert ft.required(d) <= complete
    all_rows = rows(log)
    assert calls == {"B": 1, "F": 2}                                # B was not re-run
    assert sum(1 for r in all_rows if r.get("strategy") == "B_qqq_qqqm" and "R" in r) == 1
    trade = next(r for r in all_rows if r.get("strategy") == "r3:F:GG-1" and "R" in r)
    assert trade["session"] == str(d) and trade["symbol"] == "ABC"
    mk = next(r for r in all_rows if r.get("strategy") == "r3:F:GG-1" and r.get("strategy_marker"))
    assert mk["hyp"] == "HYP-0010" and mk["equity"] == 600.0 and mk["spec_version"] == "1.0.1" and mk["n_trades"] == 1
    sm = [r for r in all_rows if r.get("session_marker")]
    assert len(sm) == 1 and sm[0]["n_trades"] == 2
    assert ft.run_session(d, units, ft.done_by_session(all_rows)[str(d)]) >= ft.required(d)
    assert calls == {"B": 1, "F": 2} and len(rows(log)) == len(all_rows)   # a third run does nothing


def test_a_manual_holdout_date_is_refused_before_any_request():
    with pytest.raises(SystemExit, match="holdout"):
        ft.main("2026-09-25")


def test_sip_safe_end_is_16_minutes_before_now():
    now = pd.Timestamp("2026-09-29T20:20:00Z")
    assert sip_safe_end(now) == (now - pd.Timedelta(minutes=SIP_DELAY_MIN)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert sip_safe_end(pd.Timestamp("2026-09-29T16:20:00-04:00")) == "2026-09-29T20:04:00Z"


def test_split_factor_refresh_never_sends_a_date_only_end():
    seen = []

    class Fake:
        def bars(self, symbols, timeframe, start, end, adjustment="raw"):
            seen.append(end)
            return pd.DataFrame(columns=["symbol", "t", "o", "h", "l", "c", "v"])

    raw = pd.DataFrame(columns=["symbol", "date", "o", "h", "l", "c", "v"])
    bp.SplitStore(Fake(), raw, persist=False).refresh(["ABC"])
    end = pd.Timestamp(seen[0])
    assert len(seen[0]) > 10 and end.tzinfo is not None
    assert pd.Timestamp.now(tz="UTC") - end >= pd.Timedelta(minutes=15)
