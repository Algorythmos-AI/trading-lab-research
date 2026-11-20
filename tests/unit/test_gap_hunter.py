"""wt.scanner.gap_hunter: DEC-0068's selection, number for number, beside a frozen funnel it does not touch."""
from __future__ import annotations

import pandas as pd
import pytest

from wt.scanner import gap_hunter as gh
from wt.scanner import ranking
from wt.specs.loader import load_spec

SPEC = load_spec("SPEC-0001")
CAT = next(iter(SPEC["funnel"]["subscores"]["catalyst"]))       # a qualifying category, read from the spec: never written here


def row(symbol="AAA", **kw) -> dict:
    base = {"symbol": symbol, "price_0925": 5.0, "gap_pct": 20.0, "pm_volume": 300_000.0, "rvol_pm": 5.0,
            "float_shares": 10_000_000.0, "catalyst_status": "qualifying", "catalyst_category": CAT,
            "catalyst_score": 0.8, "former_runner": False, "headlines_n": 2, "trend_ok": False, "window_ok": False,
            "pm_consolidation": False, "suspect_split": False}
    return {**base, **kw}


def pool(*rows: dict) -> pd.DataFrame:
    return pd.DataFrame(list(rows))


def one(**kw) -> gh.Name:
    return gh.names(pool(row(**kw)))[0]


def test_the_numbers_are_the_records():
    assert (gh.PRICE_USD, gh.GAP_MIN_PCT, gh.FLOAT_MAX_SHARES, gh.PM_VOLUME_MIN, gh.RVOL_MIN) == \
        ((1.0, 20.0), 4.0, 50_000_000, 50_000, 2.0)
    assert (gh.NO_HEADLINE_RVOL_MIN, gh.NO_HEADLINE_PM_VOLUME_MIN) == (2.5, 100_000)
    assert gh.BONUS_CHART == {"trend_ok": 0.10, "window_ok": 0.10, "pm_consolidation": 0.10}
    assert gh.BONUS_HEADLINE_NOT_QUALIFYING == 0.05 and (gh.TIER1_MAX, gh.TIER2_MAX) == (20, 4)


@pytest.mark.parametrize("kw, why", [
    ({}, []),
    ({"price_0925": 0.99}, ["price"]), ({"price_0925": 20.01}, ["price"]), ({"price_0925": 20.0}, []),
    ({"gap_pct": 3.99}, ["gap"]), ({"gap_pct": 4.0}, []),
    ({"float_shares": None}, ["float_unknown"]), ({"float_shares": float("nan")}, ["float_unknown"]),
    ({"float_shares": 50_000_001.0}, ["float"]), ({"float_shares": 50_000_000.0}, []),
    ({"pm_volume": 49_999.0}, ["pm_volume"]), ({"rvol_pm": 1.99}, ["rvol"]),
    ({"suspect_split": True}, ["suspect_split"]),
    ({"catalyst_status": "excluded", "catalyst_category": "buyout_offer"}, ["buyout"]),
])
def test_each_hard_filter_at_its_edge(kw, why):
    assert gh.hard_fails(one(**kw)) == why


def test_a_chart_check_or_a_missing_catalyst_never_rejects_a_name():
    plain = one(catalyst_status="non_qualifying", catalyst_category="other_news", trend_ok=False, window_ok=False,
                pm_consolidation=False)
    assert gh.hard_fails(plain) == [] and plain.headline == "other"
    rumour = one(catalyst_status="excluded", catalyst_category="unconfirmed_rumor")
    assert gh.hard_fails(rumour) == [] and rumour.headline == "other"            # only a buyout rejects


def test_a_name_with_no_headline_needs_more_volume():
    quiet = {"catalyst_status": "non_qualifying", "catalyst_category": "none", "headlines_n": 0}
    assert gh.hard_fails(one(**quiet, rvol_pm=2.4, pm_volume=300_000.0)) == ["no_headline_volume"]
    assert gh.hard_fails(one(**quiet, rvol_pm=5.0, pm_volume=99_999.0)) == ["no_headline_volume"]
    assert gh.hard_fails(one(**quiet, rvol_pm=2.5, pm_volume=100_000.0)) == []
    assert one(**quiet).headline == "none"


def test_the_score_is_the_frozen_base_plus_the_bonuses():
    fcfg = SPEC["funnel"]
    n = one(trend_ok=True, pm_consolidation=True)
    t = gh.score_terms(n, fcfg)
    frozen = ranking.spec_score(ranking.SpecCandidate(symbol="AAA", price=5.0, gap_pct=20.0, pm_volume=300_000.0,
                                                      rvol_pm=5.0, float_shares=10_000_000.0,
                                                      catalyst_status="qualifying", catalyst_category=CAT,
                                                      catalyst_score=0.8), fcfg)
    assert t["base"] == pytest.approx(frozen)
    assert (t["trend_ok"], t["window_ok"], t["pm_consolidation"], t["headline_not_qualifying"]) == (0.10, 0.0, 0.10, 0.0)
    other = gh.score_terms(one(catalyst_status="non_qualifying", catalyst_category="other_news"), fcfg)
    none = gh.score_terms(one(catalyst_status="non_qualifying", catalyst_category="none", headlines_n=0), fcfg)
    assert other["headline_not_qualifying"] == 0.05 and none["headline_not_qualifying"] == 0.0
    assert other["base"] == pytest.approx(none["base"]) and other["base"] < t["base"]     # no catalyst weight without one


def test_tier_two_is_the_top_four_and_the_primary_is_rank_one():
    rows = [row(f"S{i}", gap_pct=10.0 + i) for i in range(6)]
    rows.append(row("CHART", gap_pct=10.0, trend_ok=True, window_ok=True, pm_consolidation=True))
    rows.append(row("BUYOUT", gap_pct=90.0, catalyst_status="excluded", catalyst_category="buyout_offer"))
    r = gh.select(pool(*rows), SPEC)
    assert r["kept"] == 8 and r["passed"] == 7 and r["dropped"]["buyout"] == 1
    assert [x["rank"] for x in r["tier2"]] == [1, 2, 3, 4] and len(r["tier1"]) == 7
    assert r["primary"] == "CHART" == r["tier2"][0]["symbol"]                    # three chart checks outrank a bigger gap
    scores = [x["score"] for x in r["tier1"]]
    assert scores == sorted(scores, reverse=True)


def test_ties_go_to_relative_volume_then_gap_then_symbol():
    r = gh.select(pool(row("BBB"), row("AAA"), row("CCC", rvol_pm=5.0)), SPEC)
    assert [x["symbol"] for x in r["tier2"]] == ["AAA", "BBB", "CCC"]


def test_an_empty_pool_has_no_primary_and_a_repeated_symbol_is_refused():
    r = gh.select(pd.DataFrame(), SPEC)
    assert r["primary"] is None and r["tier2"] == [] and r["kept"] == 0
    with pytest.raises(ValueError):
        gh.select(pool(row("AAA"), row("AAA")), SPEC)


def test_it_reads_only_columns_known_at_0925_and_reports_no_headline_text():
    extra = row(catalyst_headline="SECRET HEADLINE TEXT", first_catalyst_at="2026-11-19T12:00:00Z", later_price=99.0)
    r = gh.select(pool(extra), SPEC)
    assert "SECRET" not in repr(r) and CAT not in repr(r)                 # no headline, no category
    only = pd.DataFrame([row()])[list(gh.USED_COLUMNS)]
    assert gh.select(only, SPEC)["primary"] == "AAA"                             # nothing outside USED_COLUMNS is needed


def test_the_frozen_funnel_is_not_changed_by_this_module():
    # the frozen funnel still requires a qualifying catalyst and every chart check: this rule lives beside it
    c = ranking.SpecCandidate(symbol="AAA", price=5.0, gap_pct=20.0, pm_volume=300_000.0, rvol_pm=5.0,
                              float_shares=10_000_000.0, catalyst_status="non_qualifying", catalyst_category="none",
                              catalyst_score=0.0, chart_ok=False)
    assert ranking.funnel([c], SPEC)["tier2"] == []
