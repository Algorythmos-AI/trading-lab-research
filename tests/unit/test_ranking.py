import random

from wt.scanner.catalyst import best_catalyst, classify
from wt.scanner.ranking import Candidate, rank


def cand(sym="ABC", **kw):
    base = dict(symbol=sym, price=5.0, gap_pct=20.0, rvol_tod=6.0, pm_dollar_vol=5e6, spread_pct=0.3,
                spread_abs=0.015, float_shares=8e6, pm_volume=1e6, catalyst_type="fda_clinical", catalyst_score=1.0)
    base.update(kw)
    return Candidate(**base)


def test_hard_filters_drop_with_reasons():
    top, dropped = rank([cand("P", price=1.5), cand("G", gap_pct=2), cand("R", rvol_tod=1.2),
                         cand("L", pm_dollar_vol=1e5), cand("S", spread_pct=2.0), cand("F", float_shares=5e8),
                         cand("O", catalyst_type="offering_dilution", catalyst_score=-1), cand("OK")])
    assert [t["symbol"] for t in top] == ["OK"]
    reasons = {d["symbol"]: d["reasons"] for d in dropped}
    assert reasons["P"] == ["price"] and reasons["G"] == ["gap"] and reasons["R"] == ["rvol"]
    assert reasons["L"] == ["liquidity"] and "spread" in reasons["S"] and reasons["F"] == ["float"]
    assert reasons["O"] == ["catalyst:offering_dilution"]


def test_spread_abs_rule_only_below_5_dollars():
    top, dropped = rank([cand("A", price=4.0, spread_abs=0.05), cand("B", price=12.0, spread_abs=0.05, spread_pct=0.4)])
    assert [t["symbol"] for t in top] == ["B"]


def test_scoring_prefers_evidence_backed_features():
    strong = cand("STRONG")
    weak = cand("WEAK", rvol_tod=2.1, float_shares=90e6, gap_pct=4.5, price=25.0, catalyst_type=None, catalyst_score=0)
    top, _ = rank([weak, strong])
    assert [t["symbol"] for t in top] == ["STRONG", "WEAK"]
    assert 0 <= top[1]["score"] < top[0]["score"] <= 100


def test_deterministic_regardless_of_input_order():
    cs = [cand(f"S{i}", rvol_tod=2 + i % 7, gap_pct=5 + i, price=3 + i % 20) for i in range(30)]
    a = rank(cs)[0]
    random.Random(1).shuffle(cs)
    b = rank(cs)[0]
    assert [x["symbol"] for x in a] == [x["symbol"] for x in b]
    assert len(a) == 10


def test_unknown_float_allowed_but_scores_zero():
    top, _ = rank([cand("U", float_shares=None)])
    assert top and top[0]["subscores"]["float"] == 0.0


def test_catalyst_classifier():
    assert classify("XYZ Announces Pricing of $10 Million Public Offering")[0] == "offering_dilution"
    assert classify("ABC Receives FDA Fast Track Designation")[0] == "fda_clinical"
    assert classify("DEF to be acquired by BigCo for $5.00 per share in cash")[0] == "buyout_merger"
    assert classify("GHI Reports Record Q2 Earnings")[0] == "earnings"
    assert best_catalyst([], former_runner=True)[0] == "former_runner"
    assert best_catalyst(["Contract win", "Priced offering of shares"], False)[1] == -1.0
