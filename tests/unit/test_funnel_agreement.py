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


def test_a_signal_is_a_name_and_a_trial_and_only_the_four_set_f_trials_count():
    seen = fa.seen_pairs([{"symbol": "AAAA", "trial": "GG-1", "signal_time": "x"}, {"symbol": "AAAA", "trial": "GG-2"},
                          {"symbol": "BBBB", "trial": "MP-1"}, {"symbol": "CCCC", "trial": "GG-3", "error": "boom"}])
    record = fa.record_pairs({"GG-1": ["AAAA", "DDDD"], "GG-2": [], "MP-1": ["BBBB"], "GG-4": ["AAAA"]})
    assert seen == {("AAAA", "GG-1"), ("AAAA", "GG-2")}
    assert record == {("AAAA", "GG-1"), ("DDDD", "GG-1"), ("AAAA", "GG-4")}
    c = fa.compare_signals(seen, record)
    assert c == {"signals_seen": 2, "signals_record": 3, "signals_both": 1}       # the same name on another trial is not a match
    t = fa.total_signals([c, fa.compare_signals(set(), set())])
    assert t == {"sessions": 2, "signals_seen": 2, "signals_record": 3, "signals_both": 1}
