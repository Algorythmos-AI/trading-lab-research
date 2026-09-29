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
