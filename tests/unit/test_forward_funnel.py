"""The forward test's funnel record (var/forward/funnel/<d>.json): counts beside the ledger, never in it, and never
able to change or fail what a round-3 unit returns."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
import test_portfolio as tpf

from wt.scanner.explain import from_pool
from wt.scanner.ranking import funnel
from wt.specs.loader import load_spec

ROOT = Path(__file__).resolve().parents[2]
D = dt.date(2026, 10, 7)
SPEC = load_spec("SPEC-0001")


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


ft = load("forward_test")
r3 = load("r3_run")


def pool_row(sym, **kw):
    base = dict(symbol=sym, price_0925=5.0, gap_pct=25.0, pm_volume=300_000.0, rvol_pm=6.0, float_shares=8e6,
                catalyst_status="qualifying", catalyst_category="fda_approval", catalyst_score=1.0, former_runner=False,
                chart_ok=True, pm_pattern=None, trend_ok=True, window_ok=True, pm_consolidation=True, suspect_split=False,
                hist_bars=260)
    return {**base, **kw}


def pool_frame() -> pd.DataFrame:
    rows = [pool_row("OK", pm_pattern="flag"), pool_row("SEC", price_0925=6.0), pool_row("THIN", rvol_pm=1.0),
            pool_row("NEW", chart_ok=False, trend_ok=False, hist_bars=30), pool_row("NOFL", float_shares=float("nan")),
            pool_row("BUY", catalyst_status="excluded", catalyst_category="buyout_offer")]
    extra = dict(rvol_tod_base=6.0, pm_dollar_vol=5e6, spread_pct=float("nan"), spread_abs=float("nan"),
                 catalyst_type_v1="fda_clinical", catalyst_score_v1=1.0)
    return pd.DataFrame([{**r, **extra} for r in rows])


@pytest.fixture
def env(tmp_path, monkeypatch):
    pool = pool_frame()
    pool.attrs["stats"] = {"universe": 4335, "snapshot_symbols": 837, "kept": 6, "slice_kept": 6, "notes": []}
    (tmp_path / "pool").mkdir()
    pool.to_parquet(tmp_path / "pool" / f"{D}.parquet")
    monkeypatch.setattr(ft, "POOL_DIR", tmp_path / "pool")
    monkeypatch.setattr(ft, "FWD", tmp_path / "forward")
    monkeypatch.setattr(ft, "trade_row", lambda d, c, tr, r: {"symbol": c.chain, "entry_time": str(c.entry_time), "R": r})
    per_trial = {"GG-1": ([tpf.cand("OK", 1, 3, 1.0, qty=100), tpf.cand("SEC", 5, 6, -0.5, qty=100)],
                          [{"symbol": "X", "reason": "spread", "spread": 0.09}, {"symbol": "Y", "reason": "no_fill"}], []),
                 "GG-2": ([], [{"symbol": "OK", "reason": "no_rth_bars"}], [])}
    monkeypatch.setattr(ft, "gg_day", lambda *a, **k: per_trial)
    ctx = SimpleNamespace(a=None, spec=SPEC, spread_at=None, closes={}, ensure_pool=lambda d: None)
    return SimpleNamespace(ctx=ctx, path=tmp_path / "forward" / "funnel" / f"{D}.json", tmp=tmp_path)


def test_the_record_candidates_are_the_ones_the_registered_run_builds():
    pool = pool_frame()
    names = r3.set_names(pool, "F", SPEC, set())
    f = funnel(from_pool(pool), SPEC)
    assert names == [(t["symbol"], 0 if t["primary"] else t["rank"]) for t in f["tier2"]] and names[0] == ("OK", 0)
    assert next(c for c in from_pool(pool) if c.symbol == "NOFL").float_shares is None
    assert [c.pm_pattern for c in from_pool(pool)][:2] == [True, False]
    assert from_pool(pd.DataFrame({"date": [], "symbol": []})) == []


def test_a_set_f_session_is_recorded_in_counts(env):
    out = ft.r3_gg(env.ctx, D, "F")
    assert [t["symbol"] for t in out["r3:F:GG-1"]] == ["OK", "SEC"] and out["r3:F:GG-3"] == []
    part = json.loads(env.path.read_text())["parts"]["set_F"]
    assert part["pool"] == {"universe": 4335, "snapshot_symbols": 837, "kept": 6, "slice_kept": 6}
    assert part["pool_rows"] == 6 and part["names"] == 2
    assert part["funnel"]["n_kept"] == 6 and part["funnel"]["n_tier2"] == 2 and part["funnel"]["drop_float_unknown"] == 1
    assert part["trials"]["GG-1"] == {"candidates": 2, "skips": {"no_fill": 1, "spread": 1}, "admitted": 2,
                                      "admission_skips": {}}
    assert part["trials"]["GG-2"]["skips"] == {"no_rth_bars": 1} and part["trials"]["GG-4"]["candidates"] == 0
    assert part.pop("git_sha")                                # set aside: a commit hash is hex and can spell anything
    text = json.dumps(part)
    assert not any(w in text for w in ('"R"', "buyout", "fda", "0.09", "entry"))      # counts: no result, category or price


def test_the_trades_returned_are_the_same_with_and_without_the_record(env, monkeypatch):
    with_record = ft.r3_gg(env.ctx, D, "F")
    monkeypatch.setattr(ft, "gg_record", lambda *a, **k: 1 / 0)
    assert ft.r3_gg(env.ctx, D, "F") == with_record                            # a failing record costs the unit nothing
    monkeypatch.setattr(ft, "FWD", env.tmp / "missing" / "\0bad")
    assert ft.r3_gg(env.ctx, D, "F") == with_record                            # nor does a path that cannot be written


def test_parts_of_one_session_share_a_file_and_the_ledger_is_untouched(env, monkeypatch):
    ft.r3_gg(env.ctx, D, "F")
    ft.r3_gg(env.ctx, D, "P")
    monkeypatch.setattr(ft, "intraday_day", lambda a, d, trial, *rest: (rest[-1].update(spread=3, no_fill=1) or
                                                                        [tpf.cand("MP", 2, 4, 0.4, qty=10)]))
    ctx = SimpleNamespace(**vars(env.ctx), sessions=[], daily=None, splits=None, shares=None)
    assert [t["symbol"] for t in ft.r3_intraday(ctx, D, "REV-1")["r3:REV-1"]] == ["MP"]
    doc = json.loads(env.path.read_text())
    assert set(doc["parts"]) == {"set_F", "set_P", "REV-1"} and doc["session"] == str(D)
    assert "funnel" not in doc["parts"]["set_P"]                                # the step counts describe Set F only
    assert doc["parts"]["set_P"]["names"] == len(r3.set_names(pool_frame(), "P", SPEC, set())) == 5
    assert doc["parts"]["REV-1"]["skips"] == {"no_fill": 1, "spread": 3} and doc["parts"]["REV-1"]["admitted"] == 1
    assert not (env.tmp / "forward" / "forward_trades.jsonl").exists()          # the record never writes the ledger
    assert sorted(p.name for p in (env.tmp / "forward" / "funnel").iterdir()) == [f"{D}.json"]   # no temp file left


def test_the_scorecard_reads_the_record_from_the_same_pool_with_the_same_funnel(tmp_path, monkeypatch):
    """weekly_scorecard.record_rows: the rows it compares the dry run with are the funnel of record's own."""
    import importlib.util

    import wt.scanner.pool as pool_mod
    import wt.specs.loader as loader
    s = importlib.util.spec_from_file_location("sc_rows", ROOT / "scripts/weekly_scorecard.py")
    sc = importlib.util.module_from_spec(s)
    s.loader.exec_module(sc)
    (tmp_path / "pool").mkdir()
    pool = pool_frame()
    pool.to_parquet(tmp_path / "pool" / f"{D}.parquet")
    pd.DataFrame({"date": [], "symbol": []}).to_parquet(tmp_path / "pool" / "2026-01-02.parquet")
    monkeypatch.setattr(pool_mod, "POOL_DIR", tmp_path / "pool")
    monkeypatch.setattr(loader, "load_spec", lambda name: SPEC)
    got = sc.record_rows(str(D))
    f = funnel(from_pool(pool), SPEC)
    assert {r["symbol"] for r in got if r["reached"] in ("tier2", "primary")} == {c["symbol"] for c in f["tier2"]}
    first = f["primary"]["symbol"] if isinstance(f["primary"], dict) else f["primary"]
    assert [r["symbol"] for r in got if r["reached"] == "primary"] == ([first] if first else [])
    assert f["tier2"]                                                    # the fixture does reach Tier 2
    assert sc.record_rows("2026-01-02") == [] and sc.record_rows("2026-01-05") is None
