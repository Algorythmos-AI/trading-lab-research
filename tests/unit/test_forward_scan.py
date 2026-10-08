"""A scan with no data is an error, not a session without trades (DEC-0024, decision 2)."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

from wt.scanner.pool import PoolStats

ROOT = Path(__file__).resolve().parents[2]
D = dt.date(2026, 10, 9)


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


ft = load("forward_test")
bp = load("build_pool")


def save_pool(folder: Path, day, **stats) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame({"date": [], "symbol": []})
    df.attrs["stats"] = stats
    df.to_parquet(folder / f"{day}.parquet")
    return folder / f"{day}.parquet"


def test_what_counts_as_a_failed_scan():
    assert "universe" in bp.scan_failure(PoolStats(universe=0))
    assert "pre-market bar" in bp.scan_failure(PoolStats(universe=4300, snapshot_symbols=0))
    assert bp.scan_failure(PoolStats(universe=4300, snapshot_symbols=800, kept=0)) is None      # nothing gapped: a real day
    assert bp.scan_failure({"universe": 4300, "snapshot_symbols": 800}) is None and bp.scan_failure({}) is None


@pytest.mark.parametrize("stats", [PoolStats(universe=0), PoolStats(universe=4300, snapshot_symbols=0)])
def test_the_forward_build_refuses_a_failed_scan_and_saves_nothing(monkeypatch, stats):
    saved = []
    monkeypatch.setattr(bp, "build_day", lambda *a, **k: (pd.DataFrame(), pd.DataFrame(), stats))
    monkeypatch.setattr(bp, "save_day", lambda *a: saved.append(a))
    args = (None, D, [D - dt.timedelta(days=1), D], None, set(), SimpleNamespace(sf=None), None, None, None)
    with pytest.raises(bp.ScanFailed):
        bp.build_one(*args, refuse_failed=True)
    assert saved == []
    assert bp.build_one(*args) is stats and len(saved) == 1            # the batch build is unchanged: it saves as before


@pytest.fixture
def env(tmp_path, monkeypatch):
    pages, built = [], []
    monkeypatch.setattr(ft, "POOL_DIR", tmp_path / "pool")
    monkeypatch.setattr(ft, "DATA_DIR", tmp_path)
    monkeypatch.setattr(ft, "universe_symbols", lambda: set())
    monkeypatch.setattr(ft, "PMCache", lambda since: SimpleNamespace(save=lambda: None))
    monkeypatch.setattr(ft, "page", lambda key, title, message, priority: pages.append((key, priority)))
    state = {"stats": PoolStats(universe=4300, snapshot_symbols=800, kept=20)}

    def build_one(a, d, *rest, refuse_failed=False):
        built.append(d)
        why = ft.scan_failure(state["stats"]) if refuse_failed else None
        if why:
            raise ft.ScanFailed(f"{d}: {why}")
        save_pool(tmp_path / "pool", d, **{k: v for k, v in vars(state["stats"]).items() if type(v) is int})
        return state["stats"]
    monkeypatch.setattr(ft, "build_one", build_one)
    ctx = SimpleNamespace(a=None, sessions=[D], daily=None, splits=None, shares=None)
    return SimpleNamespace(ensure=lambda d=D: ft.Context.ensure_pool(ctx, d), pages=pages, built=built, state=state,
                           pool=tmp_path / "pool")


def test_a_failed_scan_pages_once_and_leaves_no_pool(env):
    env.state["stats"] = PoolStats(universe=0)
    with pytest.raises(ft.ScanFailed):
        env.ensure()
    assert env.pages == [("forward:scan-failed", 4)] and not (env.pool / f"{D}.parquet").exists()


def test_a_normal_scan_is_built_once_and_says_nothing(env):
    env.ensure()
    env.ensure()
    assert env.built == [D] and env.pages == [] and (env.pool / f"{D}.parquet").exists()


def test_a_pool_left_by_an_earlier_failed_scan_is_rebuilt_not_read(env):
    save_pool(env.pool, D, universe=0, snapshot_symbols=0, kept=0)
    env.ensure()
    assert env.built == [D] and ft.pool_stats(env.pool / f"{D}.parquet")["universe"] == 4300
    assert sorted(p.name for p in env.pool.iterdir()) == [f"{D}.parquet"]


def test_a_thin_scan_is_reported_and_still_recorded(env):
    for k in range(1, 7):
        save_pool(env.pool, D - dt.timedelta(days=k), universe=4300, snapshot_symbols=800, kept=30)
    save_pool(env.pool, D - dt.timedelta(days=7), universe=0, snapshot_symbols=0, kept=0)      # a failed day is no baseline
    env.state["stats"] = PoolStats(universe=4300, snapshot_symbols=300, kept=0)
    env.ensure()
    assert env.pages == [("forward:scan-thin", 3)] and (env.pool / f"{D}.parquet").exists()
    assert ft.collapse(D, {"universe": 4300, "snapshot_symbols": 300, "kept": 0}) == [
        "snapshot_symbols 300 against a median of 800", "no name kept"]
    assert ft.collapse(D, {"universe": 4300, "snapshot_symbols": 790, "kept": 4}) == []        # an ordinary day


def test_the_thin_check_is_quiet_until_five_earlier_pools_exist(env):
    for k in range(1, 4):
        save_pool(env.pool, D - dt.timedelta(days=k), universe=4300, snapshot_symbols=800, kept=30)
    assert ft.collapse(D, {"universe": 10, "snapshot_symbols": 1, "kept": 0}) == []


def test_a_unit_that_meets_a_failed_scan_records_an_error_and_no_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "FWD", tmp_path)
    monkeypatch.setattr(ft, "LOG", tmp_path / "forward_trades.jsonl")
    monkeypatch.setattr(ft, "spec_version", lambda: "1.0.1")
    d = dt.date(2026, 10, 9)

    def failed():
        raise ft.ScanFailed(f"{d}: the universe is empty")
    gg = tuple(f"r3:F:GG-{i}" for i in range(1, 5))
    others = [((n,), lambda n=n: {n: []}) for n in sorted(ft.required(d) - set(gg))]
    complete = ft.run_session(d, [(gg, failed)] + others, set())
    rows = [json.loads(x) for x in (tmp_path / "forward_trades.jsonl").read_text().splitlines()]
    assert not set(gg) & complete and not any(r.get("session_marker") for r in rows)
    assert [r["strategy"] for r in rows if r.get("error")] == [",".join(gg)]
    assert not any(r.get("strategy_marker") and r["strategy"] in gg for r in rows)       # retried on the next run
