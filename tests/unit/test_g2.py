"""G2 counting (wt.analytics.g2): only clean sessions count, a trade counts once, orphans never."""
from wt.analytics import g2


def ts(day: str, hh: str = "14:00") -> str:
    return f"{day}T{hh}:00+00:00"                     # 10:00 ET in October (EDT)


def session(day: str, *, kill=False, refuse=False, kill_later=False, complete=True, extra=()):
    rows = [{"event": "armed", "day": day, "kill": kill, "ts": ts(day, "12:30")}]
    if refuse:
        rows.append({"event": "refuse_to_arm", "reason": "free disk", "exits_only": True, "ts": ts(day, "12:31")})
    if kill_later:
        rows.append({"event": "kill_state", "on": True, "ts": ts(day, "15:00")})
    rows += list(extra)
    if complete:
        rows.append({"event": "session_end", "ts": ts(day, "20:00")})
    return rows


def closed(day: str, tid: str, origin: str = "entry") -> dict:
    return {"event": "trade_closed", "trade_id": tid, "origin": origin, "R": 1.0, "ts": ts(day, "16:00")}


def test_only_clean_sessions_count():
    rows = (session("2026-10-01") + session("2026-10-02", kill=True) + session("2026-10-05", refuse=True)
            + session("2026-10-06", kill_later=True) + session("2026-10-07", complete=False)
            + session("2026-10-08", extra=[{"event": "END_OF_DAY_NOT_FLAT", "qty": 1, "ts": ts("2026-10-08", "20:01")}])
            + session("2026-10-09", extra=[{"event": "reconcile", "actions": ["SHORT position QQQM x-1"],
                                            "ts": ts("2026-10-09")}])
            + session("2026-10-12", extra=[{"event": "loop_error", "ts": ts("2026-10-12")}] * 3)
            + session("2026-10-13", extra=[{"event": "loop_error", "ts": ts("2026-10-13")}] * 2))
    s = g2.summary(rows)
    assert s["armed_sessions"] == 9 and s["sessions"] == 2           # 10-01 and 10-13 (two loop errors are tolerated)
    assert s["incident_free_streak"] == 1


def test_a_trade_counts_once_and_orphans_never():
    rows = session("2026-10-01", extra=[closed("2026-10-01", "t1"), closed("2026-10-01", "t1"),
                                        closed("2026-10-01", "o1", origin="orphan")])
    assert g2.summary(rows)["trades"] == 1
    assert [r["trade_id"] for r in g2.trades(rows)] == ["t1"]


def test_day_level_agreement_over_clean_sessions_both_ran():
    rows = (session("2026-10-01", extra=[closed("2026-10-01", "t1")]) + session("2026-10-02")
            + session("2026-10-05", kill=True))
    s = g2.summary(rows, forward_sessions={"2026-10-01", "2026-10-02", "2026-10-05"},
                   forward_b_days={"2026-10-01", "2026-10-02"})
    assert (s["agreement_agree"], s["agreement_days"], s["agreement_level"]) == (1, 2, "day")


def test_a_refusal_row_without_a_day_lands_on_its_et_date():
    rows = [{"event": "refuse_to_arm", "reason": "x", "ts": "2026-10-02T01:00:00+00:00"}]   # 21:00 ET on 10-01
    assert "2026-10-01" in g2.sessions(rows)


def ended(day: str, outcome: str | None) -> list[dict]:
    rows = session(day, complete=False)
    return rows + [{"event": "session_end", "ts": ts(day, "20:00"), **({"outcome": outcome} if outcome else {})}]


def test_a_session_whose_signal_could_not_be_checked_is_not_clean():
    """DEC-0024, decision 1: `no_inputs` is counted on its own, breaks the clean streak and is not in agreement."""
    rows = (ended("2026-10-08", "no_signal") + ended("2026-10-09", "no_inputs") + ended("2026-10-12", "no_signal")
            + ended("2026-10-13", "blocked:kill_file") + ended("2026-10-14", "traded"))
    s = g2.summary(rows, forward_sessions={"2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"},
                   forward_b_days=set())
    assert s["armed_sessions"] == 5 and s["sessions"] == 4 and s["unchecked_sessions"] == 1
    assert s["incident_free_streak"] == 3                              # the unchecked session ends the run before it
    assert s["agreement_days"] == 4 and s["agreement_agree"] == 4      # it would have "agreed" by not trading: left out
    assert not g2.sessions(rows)["2026-10-09"].clean and g2.sessions(rows)["2026-10-13"].clean


def test_a_session_from_before_the_outcome_existed_is_judged_as_before():
    rows = ended("2026-10-01", None) + ended("2026-10-02", "no_signal")
    s = g2.summary(rows)
    assert s["sessions"] == 2 and s["unchecked_sessions"] == 0


def test_bar_level_agreement_from_the_replay_records(tmp_path):
    """DEC-0037 part 1: same or neither agree; different and one-sided disagree; unknown is counted, not judged;
    the forward-vs-replay harness number sits beside it and is never pooled."""
    import json

    from wt.analytics import b_replay
    folder = tmp_path / "replay"
    folder.mkdir()
    recs = [("2026-10-12", "neither", "neither"), ("2026-10-13", "same", "same"), ("2026-10-14", "different", "same"),
            ("2026-10-15", "only_second", "neither"), ("2026-10-16", "unknown", "unknown"), ("2026-10-19", "same", "different")]
    for day, rj, fr in recs:
        (folder / f"{day}.json").write_text(json.dumps({"session": day, "replay_vs_journal": rj, "forward_vs_replay": fr}))
    (folder / "broken.json").write_text("{")
    loaded = b_replay.load_records(folder)
    assert [r["session"] for r in loaded] == [d for d, _, _ in recs]
    a = b_replay.agreement(loaded)
    assert a == {"agreement_level": "bar", "agreement_days": 5, "agreement_agree": 3, "agreement_unknown": 1,
                 "harness_days": 5, "harness_agree": 4}
    # only the clean sessions asked for are judged
    a = b_replay.agreement(loaded, {"2026-10-13", "2026-10-14", "2026-10-16"})
    assert (a["agreement_days"], a["agreement_agree"], a["agreement_unknown"]) == (2, 1, 1)
    assert b_replay.load_records(tmp_path / "missing") == []


def test_summary_prefers_the_bar_level_measure_when_replay_records_exist():
    rows = [{"event": "armed", "day": "2026-10-13"}, {"event": "session_end", "day": "2026-10-13", "outcome": "no_signal"},
            {"event": "decision_summary", "day": "2026-10-13", "inputs": True}]
    sessions = g2.sessions(rows)
    clean = {d for d, s in sessions.items() if s.clean}
    replay = [{"session": d, "replay_vs_journal": "same", "forward_vs_replay": "neither"} for d in clean] + \
             [{"session": "2026-10-10", "replay_vs_journal": "different", "forward_vs_replay": "different"}]
    out = g2.summary(rows, replay=replay)
    assert out["agreement_level"] == "bar"
    assert out["agreement_days"] == len(clean) and out["agreement_agree"] == len(clean)   # the unclean day is not judged
    assert out["harness_days"] == len(clean) and out["harness_agree"] == len(clean)
    day = g2.summary(rows, {"2026-10-13"}, set())
    assert day["agreement_level"] == "day" and day["agreement_unknown"] is None
    assert g2.summary(rows, {"2026-10-13"}, set(), replay=[])["agreement_level"] == "day"   # no records: day-level still
