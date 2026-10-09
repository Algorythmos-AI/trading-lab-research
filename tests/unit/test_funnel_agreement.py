"""The dry run against the record, in counts (wt.analytics.funnel_agreement, DEC-0023 section 2)."""
from wt.analytics import funnel_agreement as fa


def rows(**reached):
    return [{"symbol": s, "price": 5.0, "reached": step, "reasons": []} for s, step in reached.items()]


SEEN = rows(AAAA="primary", BBBB="tier2", CCCC="tier1", DDDD="passed", EEEE="kept")
RECORD = rows(AAAA="tier2", BBBB="primary", CCCC="chart_ok", FFFF="tier1", EEEE="kept")


def test_a_session_is_compared_tier_by_tier():
    c = fa.compare(SEEN, RECORD)
    assert (c["tier1_seen"], c["tier1_record"], c["tier1_both"]) == (3, 4, 3)
    assert (c["tier2_seen"], c["tier2_record"], c["tier2_both"]) == (2, 2, 2)
    assert c["first_pick"] == "different"


def test_the_first_pick_has_four_answers():
    assert fa.compare(SEEN, SEEN)["first_pick"] == "same"
    assert fa.compare(SEEN, rows(AAAA="tier1"))["first_pick"] == "one_side"
    assert fa.compare([], [])["first_pick"] == "neither"
    assert fa.compare([], []) == {**dict.fromkeys(fa.KEYS, 0), "first_pick": "neither"}


def test_sessions_add_up_and_no_name_comes_out():
    t = fa.total([fa.compare(SEEN, RECORD), fa.compare(SEEN, SEEN), fa.compare([], [])])
    assert t["sessions"] == 3 and t["tier1_both"] == 6 and t["tier2_record"] == 4
    assert t["first_pick"] == {"same": 1, "different": 1, "one_side": 0, "neither": 1}
    assert not any(s in str(t) + str(fa.compare(SEEN, RECORD)) for s in ("AAAA", "BBBB", "CCCC", "FFFF"))
