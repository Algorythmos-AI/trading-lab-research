"""The frozen selection and admission functions, pinned (DEC-0010 freezes the method these implement).

Two guards, both generated on main before any funnel instrumentation was added:
  * golden outputs: `funnel`, `rank`, `build_day` and `admit_day` on fixed inputs that sit on every threshold;
  * source hashes: the text of each frozen function.
A change to either is a change to what the registered trials select or admit. That needs a decision record first;
only then may the files be regenerated with `GOLDEN_UPDATE=1 pytest tests/unit/test_frozen_golden.py`.
Instrumentation belongs beside these functions, never inside them.
"""
import hashlib
import importlib.util
import inspect
import json
import os
from dataclasses import asdict
from pathlib import Path

import pandas as pd
import test_pool as tp
import test_portfolio as tpf

from wt.backtest.portfolio import admit_day
from wt.data.corpactions import SplitFactors
from wt.scanner import ranking
from wt.scanner.pool import DailyIndex, PoolConfig, build_day
from wt.specs.loader import load_spec

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests/fixtures/golden"
SPEC = load_spec("SPEC-0001")
POOL_STATS_PINNED = ("universe", "snapshot_symbols", "split_checked", "kept", "float_unknown", "notes")
WHY = "a frozen function's output or source changed: this needs a decision record before the golden is regenerated"


def check(name: str, got) -> None:
    path = GOLDEN / f"{name}.json"
    text = json.dumps(got, indent=1, sort_keys=True, default=str) + "\n"
    if os.environ.get("GOLDEN_UPDATE") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    assert path.read_text() == text, f"{name}: {WHY}"


def pick(values: list, i: int, stride: int):
    return values[(i * stride) % len(values)]


def spec_cands() -> list[ranking.SpecCandidate]:
    """72 candidates walking every threshold of the spec funnel: 36 on the boundaries, 36 that pass and differ
    only in score, so the Tier 1 cut, the chart musts and the Tier 2 order are all exercised."""
    prices = [0.99, 1.00, 1.49, 1.50, 5.0, 10.0, 10.01, 20.0, 20.01]
    gaps = [5.0, 5.01, 12.0, 25.0, 80.0, 400.0]
    floats = [None, 2e6, 8e6, 19e6, 49.9e6, 50e6]
    vols = [49_999, 50_000, 300_000, 5_000_000]
    rvols = [1.9, 2.0, 6.0, 40.0]
    cats = [("qualifying", "fda_approval"), ("qualifying", "fda_approval"), ("excluded", "buyout_offer"),
            ("non_qualifying", "none")]
    out = []
    for i in range(36):
        status, category = pick(cats, i, 1)
        out.append(ranking.SpecCandidate(
            symbol=f"B{i:02d}", price=pick(prices, i, 2), gap_pct=pick(gaps, i, 5), pm_volume=pick(vols, i, 3),
            rvol_pm=pick(rvols, i, 1), float_shares=pick(floats, i, 5), catalyst_status=status,
            catalyst_category=category, catalyst_score=1.0 if status == "qualifying" else 0.0,
            former_runner=i % 5 == 0, chart_ok=i % 3 != 0, pm_pattern=i % 4 == 0))
    for i in range(36):
        out.append(ranking.SpecCandidate(
            symbol=f"P{i:02d}", price=pick([1.2, 3.0, 6.5, 9.9, 12.0, 19.5], i, 1), gap_pct=6.0 + 7.0 * (i % 11),
            pm_volume=60_000 + 10_000 * i, rvol_pm=2.0 + 0.75 * (i % 9), float_shares=pick([2e6, 8e6, 19e6, 45e6], i, 3),
            catalyst_status="qualifying", catalyst_category="fda_approval", catalyst_score=1.0,
            former_runner=i % 7 == 0, chart_ok=i % 3 != 1, pm_pattern=i % 5 == 2))
    return out


def baseline_cands() -> list[ranking.Candidate]:
    """60 candidates for the frozen baseline `rank()`: every hard filter on its boundary, and more passers than top_n."""
    prices = [1.99, 2.0, 4.99, 5.0, 12.0, 30.0, 30.01]
    gaps = [3.99, 4.0, 15.0, 60.0]
    rvols = [1.99, 2.0, 5.0, 30.0]
    dollars = [999_999.0, 1_000_000.0, 5e6, 40e6]
    spreads = [(None, None), (0.2, 0.01), (1.0, 0.03), (1.01, 0.031), (0.5, 0.05)]
    floats = [None, 5e6, 100e6, 100_000_001.0]
    cats = [("fda_clinical", 1.0), (None, 0.0), ("offering_dilution", -1.0), ("earnings", 0.6)]
    out = []
    for i in range(60):
        sp, sa = pick(spreads, i, 3)
        ctype, cscore = pick(cats, i, 1) if i % 6 == 0 else cats[i % 2 * 3]
        out.append(ranking.Candidate(
            symbol=f"R{i:02d}", price=pick(prices, i, 3), gap_pct=pick(gaps, i, 3), rvol_tod=pick(rvols, i, 5),
            pm_dollar_vol=pick(dollars, i, 3), spread_pct=sp, spread_abs=sa, float_shares=pick(floats, i, 1),
            pm_volume=100_000.0 + 25_000 * i, catalyst_type=ctype, catalyst_score=cscore, halted=i == 59))
    return out


def test_spec_funnel_output_is_unchanged():
    cands = spec_cands()
    out = ranking.funnel(cands, SPEC)
    assert len(out["tier1"]) == SPEC["funnel"]["tier1_max"] and len(out["tier2"]) == SPEC["funnel"]["tier2_max"]
    check("spec_funnel", {"funnel": out, "inputs": [asdict(c) for c in cands],
                          "scores": {c.symbol: round(ranking.spec_score(c, SPEC["funnel"]), 9) for c in cands}})


def test_baseline_rank_output_is_unchanged():
    cands = baseline_cands()
    top, dropped = ranking.rank(cands)
    assert any(d["reasons"] == ["below_top_n"] for d in dropped)
    check("baseline_rank", {"top": top, "dropped": dropped, "inputs": [asdict(c) for c in cands]})


def test_pool_build_output_is_unchanged():
    sessions = [tp.P - pd.Timedelta(days=k).to_pytimedelta() for k in range(25, 0, -1)] + [tp.P]
    cands, pmb, st = build_day(tp.D, tp.P, tp.FakeClient(), DailyIndex(tp.daily_rows()), {"GAPR", "FLAT", "SPLT", "PENY"},
                               SplitFactors(pd.DataFrame(columns=["symbol", "date", "f"])), tp.FakeCache(),
                               tp.FakeShares(), sessions, PoolConfig(), split_refresh=lambda syms: tp.split_factors())
    rows = json.loads(cands.sort_values("symbol").round(9).to_json(orient="records", date_format="iso"))
    stats = {k: v for k, v in asdict(st).items() if k in POOL_STATS_PINNED}          # counts added later are not selection
    check("pool_build", {"candidates": rows, "stats": stats, "pm_bars": len(pmb),
                         "pm_first": str(pmb.t.min()), "pm_last": str(pmb.t.max())})


def test_day_admission_output_is_unchanged():
    days = {
        "cash": [tpf.cand("A", 1, 3, 1.0, qty=100), tpf.cand("B", 5, 6, 1.0, qty=100), tpf.cand("C", 7, 9, -0.5, qty=100)],
        "losers": [tpf.cand(s, i * 10, i * 10 + 5, -0.4 if i < 3 else 2.0, qty=10) for i, s in enumerate("ABCDE")],
        "day_loss": [tpf.cand("A", 0, 5, -1.2, qty=10), tpf.cand("B", 2, 8, -1.0, qty=10), tpf.cand("D", 6, 7, 0.1, qty=10),
                     tpf.cand("C", 9, 12, 1.5, qty=10)],
        "chains": [tpf.cand("Z", 0, 2, 0.2, qty=118), tpf.cand("A", 1, 3, -1.0, qty=5, px=50.0),
                   tpf.cand("A", 6, 9, 2.0, qty=1, attempt=2), tpf.cand("B", 1, 4, 1.0, qty=1, priority=0),
                   tpf.cand("B", 8, 9, 0.3, qty=1, attempt=2)],
    }
    got = {}
    for name, cands in days.items():
        res = admit_day(cands, equity=600)
        got[name] = {"admitted": [[c.chain, c.attempt, t.qty, r] for c, t, r in res.admitted],
                     "skipped": [[c.chain, c.attempt, why] for c, why in res.skipped]}
    assert {why for day in got.values() for _, _, why in day["skipped"]} == {
        "unfunded", "earlier_attempt_not_admitted", "day_stop_consecutive_losers", "day_stop_loss_R"}
    check("day_admission", got)


def test_frozen_sources_are_unchanged():
    spec = importlib.util.spec_from_file_location("r3_run", ROOT / "scripts/r3_run.py")
    r3 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(r3)
    frozen = {"ranking.hard_filter": ranking.hard_filter, "ranking.subscores": ranking.subscores, "ranking.rank": ranking.rank,
              "ranking.hard_filter_spec": ranking.hard_filter_spec, "ranking.spec_subscores": ranking.spec_subscores,
              "ranking.spec_score": ranking.spec_score, "ranking.funnel": ranking.funnel,
              "portfolio.admit_day": admit_day, "r3_run.set_names": r3.set_names}
    check("frozen_sources", {k: hashlib.sha256(inspect.getsource(f).encode()).hexdigest() for k, f in frozen.items()})
