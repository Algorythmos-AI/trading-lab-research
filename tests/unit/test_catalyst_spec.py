"""SPEC-0001 catalyst classifier: category rules (SCN-GAP-09..11, K-06, K-23) and stock-level status.
Headlines are synthetic examples written for the tests, not taken from any sample."""
import pytest

from wt.scanner.catalyst import best_catalyst_spec, classify, classify_spec


@pytest.mark.parametrize("headline,expected", [
    ("Acme Bio Receives FDA Approval for Lead Drug", "fda_approval"),
    ("Acme Bio Announces Positive Topline Phase 2 Results", "clinical_study_results"),
    ("Acme Corp Reports Record Revenue for Third Quarter", "earnings_release"),
    ("Analyst Raises Acme Price Target to $12", "price_target_upgrade"),
    ("Acme Awarded $40 Million Defense Contract", "breaking_news"),
    ("Acme Enters Definitive Agreement to Be Acquired for $4.10 Per Share in Cash", "buyout_offer"),
    ("Acme Reportedly in Talks With Strategic Buyer", "unconfirmed_rumor"),
    ("Acme Announces Pricing of $10 Million Public Offering", "offering_dilution"),
    ("Acme Announces 1-for-20 Reverse Stock Split", "reverse_split"),
    ("Acme to Present at Upcoming Healthcare Conference", "none"),
    ("Acme to Report Third Quarter Financial Results on November 5", "none"),       # scheduling, not results
    ("12 Health Care Stocks Moving In Monday's Pre-Market Session", "none"),        # movers roundup
    ("Acme Surges on AI Enthusiasm", "hype_only"),
    ("Acme Inc Common Stock", "none"),
])
def test_classify_spec(headline, expected):
    assert classify_spec(headline) == expected


def test_buyout_excludes_even_with_good_news():
    st, cat, sc, _ = best_catalyst_spec(["Acme Receives FDA Approval", "Acme to Be Acquired by BigCo for $5 Per Share in Cash"])
    assert (st, cat, sc) == ("excluded", "buyout_offer", -1.0)


def test_rumor_excludes_only_without_a_confirmed_catalyst():
    assert best_catalyst_spec(["Acme Reportedly Exploring a Sale"])[:2] == ("excluded", "unconfirmed_rumor")
    st, cat, _, _ = best_catalyst_spec(["Acme Reportedly Exploring a Sale", "Acme Reports Q3 Earnings Beat"])
    assert (st, cat) == ("qualifying", "earnings_release")


def test_best_qualifying_category_wins_by_score_then_priority():
    st, cat, sc, ev = best_catalyst_spec(["Analyst Upgrades Acme", "Acme Wins Supply Agreement", "Acme Announces Positive Phase 3 Data"])
    assert (st, cat, sc) == ("qualifying", "clinical_study_results", 1.0) and ev == ["Acme Announces Positive Phase 3 Data"]


def test_offering_is_non_qualifying_not_excluded():
    assert best_catalyst_spec(["Acme Prices Registered Direct Offering"])[:2] == ("non_qualifying", "offering_dilution")


def test_no_headlines_is_non_qualifying_none():
    assert best_catalyst_spec([]) == ("non_qualifying", "none", 0.0, [])


def test_v1_classifier_unchanged():
    assert classify("Acme announces FDA fast track designation") == ("fda_clinical", 1.0)
