"""SPEC-0001 funnel (FUN-01..06, SCN-GAP-*): hard filters, v2 score, preferred band ordering, tiers, primary."""
from wt.scanner.ranking import SpecCandidate, funnel, hard_filter_spec, spec_score
from wt.specs.loader import load_spec

SPEC = load_spec("SPEC-0001")
SCAN = SPEC["scanners"]["pre_market_gap"]


def c(sym, **kw):
    base = dict(symbol=sym, price=5.0, gap_pct=25.0, pm_volume=300_000, rvol_pm=6.0, float_shares=8e6,
                catalyst_status="qualifying", catalyst_category="fda_approval", catalyst_score=1.0,
                former_runner=False, chart_ok=True, pm_pattern=False)
    base.update(kw)
    return SpecCandidate(**base)


def test_hard_filters_match_the_spec():
    assert hard_filter_spec(c("OK"), SCAN) == []
    assert hard_filter_spec(c("P1", price=0.99), SCAN) == ["price"] and hard_filter_spec(c("P2", price=1.00), SCAN) == []
    assert hard_filter_spec(c("P3", price=20.01), SCAN) == ["price"]
    assert hard_filter_spec(c("G", gap_pct=5.0), SCAN) == ["gap"]                     # strictly greater than 5%
    assert hard_filter_spec(c("F", float_shares=50e6), SCAN) == ["float"]             # strictly under 50M
    assert hard_filter_spec(c("FU", float_shares=None), SCAN) == ["float_unknown"]
    assert hard_filter_spec(c("V", pm_volume=49_999), SCAN) == ["pm_volume"]
    assert hard_filter_spec(c("R", rvol_pm=1.9), SCAN) == ["rvol"]
    assert hard_filter_spec(c("B", catalyst_status="excluded", catalyst_category="buyout_offer"), SCAN) == ["catalyst_excluded:buyout_offer"]
    assert hard_filter_spec(c("N", catalyst_status="non_qualifying", catalyst_category="none"), SCAN) == ["catalyst_missing:none"]


def test_score_weights_and_former_runner_boost():
    a, b = c("A"), c("B", former_runner=True)
    assert abs(spec_score(b, SPEC["funnel"]) - spec_score(a, SPEC["funnel"]) - 0.15) < 1e-9


def test_tiers_preferred_band_first_and_primary_with_pattern():
    cands = [c("HI", price=15.0, gap_pct=80, rvol_pm=10), c("LO", price=4.0, gap_pct=20, rvol_pm=4),
             c("MID", price=8.0, gap_pct=30, rvol_pm=5, pm_pattern=True), c("X", chart_ok=False, gap_pct=90),
             c("Y", price=6.0), c("Z", price=7.0)]
    out = funnel(cands, SPEC)
    t2 = [r["symbol"] for r in out["tier2"]]
    assert len(t2) == 4 and "X" not in t2 and "HI" not in t2                # $15 name ranks after in-band names
    assert out["primary"] == "MID"


def test_funnel_is_deterministic():
    cands = [c(s) for s in "EDCBA"]
    assert funnel(cands, SPEC) == funnel(list(reversed(cands)), SPEC)
    assert [r["symbol"] for r in funnel(cands, SPEC)["tier2"]] == ["A", "B", "C", "D"]
