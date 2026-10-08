"""The funnel record (wt.scanner.explain): it agrees with the frozen funnel, its counts add up, and it only counts."""
import json
import random

import pandas as pd
import test_pool as tp
from test_frozen_golden import spec_cands

from wt.data.corpactions import SplitFactors
from wt.scanner import pool
from wt.scanner.explain import BAND_STEPS, STEPS, explain, pool_musts, public
from wt.scanner.ranking import SpecCandidate, funnel
from wt.specs.loader import load_spec

SPEC = load_spec("SPEC-0001")
T1, T2 = SPEC["funnel"]["tier1_max"], SPEC["funnel"]["tier2_max"]


def draw(rng: random.Random, n: int) -> list[SpecCandidate]:
    status = [("qualifying", "fda_approval"), ("excluded", "buyout_offer"), ("non_qualifying", "none")]
    out = []
    for i in range(n):
        st, cat = rng.choices(status, weights=[6, 1, 2])[0]
        out.append(SpecCandidate(
            symbol=f"S{i:03d}", price=rng.choice([0.8, 1.0, 1.5, 2.0, 4.0, 9.9, 15.0, 20.0, 24.0]),
            gap_pct=rng.choice([4.5, 5.0, 5.01, 12.0, 40.0, 150.0]), pm_volume=rng.choice([20_000, 50_000, 400_000]),
            rvol_pm=rng.choice([1.0, 2.0, 3.5, 12.0]), float_shares=rng.choice([None, 3e6, 18e6, 49e6, 80e6]),
            catalyst_status=st, catalyst_category=cat, catalyst_score=1.0 if st == "qualifying" else 0.0,
            former_runner=rng.random() < 0.2, chart_ok=rng.random() < 0.5, pm_pattern=rng.random() < 0.3))
    return out


def check_invariants(cands, e, f):
    c = e.counts
    assert [r.symbol for r in e.rows] == [x.symbol for x in cands]                     # one row per name, same order
    assert all(c[a] >= c[b] for a, b in zip(STEPS, STEPS[1:], strict=False))           # nested: never grows
    dropped = c["kept"] - c["passed"]
    assert c["kept"] == len(cands) and dropped == len(f["dropped"])
    assert c["tier1"] == len(f["tier1"]) <= T1 and c["tier2"] == len(f["tier2"]) <= T2
    assert c["primary"] == (1 if f["primary"] else 0)
    assert sum(e.first_failure.values()) == dropped
    assert sum(e.sole_reason.values()) <= dropped and all(v <= dropped for v in e.failed_by_reason.values())
    assert all(e.sole_reason.get(k, 0) <= v for k, v in e.failed_by_reason.items())
    assert all(e.band[k] <= c[k] for k in BAND_STEPS)
    assert all(bool(r.reasons) != (r.reached == "primary") for r in e.rows)            # everyone but the primary has a reason


def test_it_agrees_with_the_funnel_on_500_random_days():
    rng = random.Random(20261008)
    for _ in range(500):
        cands = draw(rng, rng.randint(0, 70))
        f, e = funnel(cands, SPEC), explain(cands, SPEC)
        check_invariants(cands, e, f)
        reached = {r.symbol: r.reached for r in e.rows}
        assert {s for s, at in reached.items() if at in STEPS[2:]} == {r["symbol"] for r in f["tier1"]}
        assert {s for s, at in reached.items() if at in STEPS[4:]} == {r["symbol"] for r in f["tier2"]}
        assert next((s for s, at in reached.items() if at == "primary"), None) == f["primary"]
        assert {r.symbol: r.reasons for r in e.rows if r.reached == "kept"} == {
            d["symbol"]: tuple(d["reasons"]) for d in f["dropped"]}


def test_the_boundary_day_reads_as_expected():
    cands = spec_cands()
    e = explain(cands, SPEC)
    check_invariants(cands, e, funnel(cands, SPEC))
    assert e.counts == {"kept": 72, "passed": 41, "tier1": 20, "chart_ok": e.counts["chart_ok"], "tier2": 4, "primary": 1}
    assert e.failed_by_reason["catalyst_excluded"] == 9 and e.failed_by_reason["float_unknown"] == 6
    assert sum(1 for r in e.rows if r.reasons == ("below_tier1_max",)) == 41 - 20
    assert sum(1 for r in e.rows if r.reasons == ("below_tier2_max",)) == e.counts["chart_ok"] - 4
    assert all(r.reasons == ("chart",) for r in e.rows if r.reached == "tier1")         # no pool row given: bare code


def test_a_name_that_fails_two_filters_is_counted_in_both_and_is_not_a_near_miss():
    base = dict(price=5.0, gap_pct=25.0, pm_volume=300_000, rvol_pm=6.0, float_shares=8e6, catalyst_status="qualifying",
                catalyst_category="fda_approval", catalyst_score=1.0, chart_ok=True)
    cands = [SpecCandidate(symbol="TWO", **{**base, "rvol_pm": 1.0, "pm_volume": 10}),
             SpecCandidate(symbol="ONE", **{**base, "rvol_pm": 1.0}), SpecCandidate(symbol="OK", **base)]
    e = explain(cands, SPEC)
    assert e.failed_by_reason == {"pm_volume": 1, "rvol": 2} and e.sole_reason == {"rvol": 1}
    assert e.first_failure == {"pm_volume": 1, "rvol": 1} and e.counts["primary"] == 1


def test_chart_reasons_name_the_must_and_tell_short_history_from_trend():
    base = dict(price=5.0, gap_pct=25.0, pm_volume=300_000, rvol_pm=6.0, float_shares=8e6, catalyst_status="qualifying",
                catalyst_category="fda_approval", catalyst_score=1.0, chart_ok=False)
    cands = [SpecCandidate(symbol=s, **base) for s in ("NEW", "DOWN", "SPLIT")]
    musts = {"NEW": {"trend_ok": False, "window_ok": True, "pm_consolidation": True, "suspect_split": False, "hist_bars": 40},
             "DOWN": {"trend_ok": False, "window_ok": False, "pm_consolidation": False, "suspect_split": False, "hist_bars": 300},
             "SPLIT": {"trend_ok": True, "window_ok": True, "pm_consolidation": True, "suspect_split": True, "hist_bars": 300}}
    e = explain(cands, SPEC, musts)
    assert {r.symbol: r.reasons for r in e.rows} == {
        "NEW": ("chart:history",), "DOWN": ("chart:trend", "chart:window", "chart:pm_consolidation"),
        "SPLIT": ("chart:suspect_split",)}
    assert e.chart_fail == {"history": 1, "pm_consolidation": 1, "suspect_split": 1, "trend": 1, "window": 1}
    assert e.counts["tier1"] == 3 and e.counts["chart_ok"] == 0


def test_the_flat_form_is_plain_ints_with_no_category_and_no_result():
    e = explain(spec_cands(), SPEC)
    flat = e.flat()
    assert all(type(v) is int for v in flat.values()) and json.loads(json.dumps(flat)) == flat
    assert not any(":" in k or "fda" in k or "buyout" in k for k in flat)             # a catalyst category is never a key
    assert public("catalyst_excluded:buyout_offer") == "catalyst_excluded"
    band = {k for k in flat if k.startswith("band")}
    assert band == {f"band2_20_{s}" for s in BAND_STEPS}                               # the slice is step counts and nothing else
    reasons = {"price", "gap", "float", "float_unknown", "pm_volume", "rvol", "catalyst_excluded", "catalyst_missing"}
    allowed = ({f"n_{s}" for s in STEPS} | {f"{p}_{r}" for p in ("drop", "sole") for r in reasons} | band
               | {f"chart_{m}" for m in ("chart", "history", "trend", "window", "pm_consolidation", "suspect_split")})
    assert set(flat) <= allowed                                                        # counts of steps and reasons: no result


def test_a_repeated_symbol_is_refused():
    c = spec_cands()[:1]
    try:
        explain(c + c, SPEC)
    except ValueError:
        return
    raise AssertionError("a repeated symbol must raise")


def build():
    sessions = [tp.P - pd.Timedelta(days=k).to_pytimedelta() for k in range(25, 0, -1)] + [tp.P]
    return pool.build_day(tp.D, tp.P, tp.FakeClient(), pool.DailyIndex(tp.daily_rows()), {"GAPR", "FLAT", "SPLT", "PENY"},
                          SplitFactors(pd.DataFrame(columns=["symbol", "date", "f"])), tp.FakeCache(), tp.FakeShares(),
                          sessions, pool.PoolConfig(), split_refresh=lambda syms: tp.split_factors())


def test_the_pool_counts_its_bands_and_the_counts_survive_a_parquet_file(tmp_path, monkeypatch):
    cands, pmb, st = build()
    # GAPR 7.30, FLAT 15.35, SPLT 3.30, PENY 0.55: four with a bar, three inside $1-30 and inside $2-20, two kept.
    assert (st.snapshot_symbols, st.in_band, st.kept, st.slice_snapshot, st.slice_kept) == (4, 3, 2, 3, 2)
    assert all(type(getattr(st, k)) is int for k in ("in_band", "slice_snapshot", "slice_kept"))
    monkeypatch.setattr(pool, "POOL_DIR", tmp_path / "pool")
    monkeypatch.setattr(pool, "PM_BARS_DIR", tmp_path / "pm")
    pool.save_day(tp.D, cands, pmb, st)
    back = pd.read_parquet(tmp_path / "pool" / f"{tp.D}.parquet")
    assert len(back) == len(cands) and back.attrs["stats"]["slice_kept"] == 2 and back.attrs["stats"]["in_band"] == 3
    musts = pool_musts(cands)
    assert set(musts) == {"GAPR", "SPLT"} and type(musts["GAPR"]["trend_ok"]) is bool and musts["GAPR"]["hist_bars"] >= 200
