"""The Gap Hunter block of the stocks snapshot (wt.ops.publish.gap_hunter_view): counts, dates and R from the robot's
own journal, plan files, virtual account and switch; and, since DEC-0078, what it is doing, symbols included, with
codes only and never a row's free text. Fixture files only."""
from __future__ import annotations

import json

from wt.ops import publish


def write_journal(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def test_the_block_counts_sessions_booked_trades_and_the_newest_selection(tmp_path):
    j = tmp_path / "smallcap_journal.jsonl"
    write_journal(j, [
        {"event": "armed", "day": "2026-11-19", "trial": "HYP-0071"},
        {"event": "armed", "day": "2026-11-19", "trial": "HYP-0071"},                    # a restart: one session
        {"event": "armed", "day": "2026-11-18", "trial": "HYP-0070"},                    # the other rule's
        {"event": "gap_primary", "day": "2026-11-19", "symbol": "ABC", "kept": 38, "passed": 6, "tier1": 6,
         "tier2": 4},
        {"event": "trade_closed", "trial": "HYP-0071", "trade_id": "a", "booked": True, "R": 1.5},
        {"event": "trade_closed", "trial": "HYP-0071", "trade_id": "a", "booked": True, "R": 1.5},   # replayed
        {"event": "trade_closed", "trial": "HYP-0071", "trade_id": "b", "booked": False, "R": None},  # an orphan
        {"event": "trade_closed", "trial": "HYP-0070", "trade_id": "c", "booked": True, "R": -1.0},
        {"event": "armed", "day": "2026-11-20", "trial": "HYP-0071"},
        {"event": "gap_primary", "day": "2026-11-20", "symbol": None, "why": "no_pool"},
    ])
    state = tmp_path / "smallcap"
    (state / "plans").mkdir(parents=True)
    (state / "plans" / "x.json").write_text(json.dumps({"state": "in_position"}))
    (state / "plans" / "y.json").write_text(json.dumps({"state": "closed"}))
    (state / "KILL").write_text("")
    risk = tmp_path / "risk.yaml"
    risk.write_text("S:\n  switched_on: [HYP-0071]\n")
    v = publish.gap_hunter_view(journal=j, state_dir=state, risk_yaml=risk)
    assert {k: v[k] for k in ("enabled", "kill", "latched", "sessions", "last_session", "trades", "total_r",
                              "mean_r", "open", "funnel")} == {"enabled": True, "kill": True, "latched": None, "sessions": 2, "last_session": "2026-11-20",
                 "trades": 1, "total_r": 1.5, "mean_r": 1.5, "open": 1,
                 "funnel": {"session": "2026-11-20", "kept": None, "passed": None, "tier1": None, "tier2": None,
                            "primary": False}}


def test_nothing_yet_is_off_empty_and_valid_against_the_published_contract(tmp_path):
    risk = tmp_path / "risk.yaml"
    risk.write_text("S:\n  switched_on: []\n")
    v = publish.gap_hunter_view(journal=tmp_path / "none.jsonl", state_dir=tmp_path / "none", risk_yaml=risk)
    assert v["enabled"] is False and v["sessions"] == 0 and v["trades"] == 0 and v["mean_r"] is None
    assert v["funnel"] is None and v["open"] == 0
    san = publish.Sanitizer(lambda x: x, None, strict=False)
    assert san.apply(publish.ALLOW["gap_hunter"], v) == v


# ---- DEC-0078: what it is doing ------------------------------------------------------------------------------------
SECRET = "RuntimeError at /home/wt/trading/var with token=sekrit and a headline about the setup"


def day_rows():
    return [
        {"ts": "2026-11-24T13:20:00+00:00", "event": "too_early"},                         # before today's arm
        {"ts": "2026-11-24T13:30:00+00:00", "event": "armed", "day": "2026-11-24", "trial": "HYP-0071"},
        {"ts": "2026-11-24T14:25:00+00:00", "event": "gap_primary", "day": "2026-11-24", "symbol": "MEDS",
         "rank": 1, "kept": 9, "passed": 4, "tier1": 4, "tier2": 4},
        {"ts": "2026-11-24T14:25:01+00:00", "event": "rotation_shadow", "kind": "names",
         "names": [[1, "MEDS"], [2, "DWTX"]]},
        {"ts": "2026-11-24T14:31:00+00:00", "event": "gap_rules", "rules": {
            "e1": {"why": "no_level"}, "e2": {"why": "ok", "trigger": 5.06, "stop": 4.94},
            "e3": {"why": SECRET}, "e4": {"why": "never_red"}}},
        {"ts": "2026-11-24T14:31:05+00:00", "event": "entry_placed", "trade_id": "t1", "symbol": "MEDS",
         "code": "e2", "detail": [["entry_placed", SECRET]]},
        {"ts": "2026-11-24T14:31:40+00:00", "event": "entry_filled", "trade_id": "t1", "symbol": "MEDS",
         "code": "e2", "qty": 46, "price": 5.07},
        {"ts": "2026-11-24T14:33:00+00:00", "event": "rotation_shadow", "kind": "change", "symbol": "DWTX"},
        {"ts": "2026-11-24T14:34:00+00:00", "event": "loop_error", "error": SECRET},
        {"ts": "2026-11-24T14:36:00+00:00", "event": "trade_closed", "trade_id": "t1", "trial": "HYP-0071",
         "day": "2026-11-24", "symbol": "MEDS", "code": "e2", "reason": "time_stop_5m", "R": -0.08,
         "booked": True, "entry": 5.07, "stop": 4.94, "qty": 46, "exit_price_estimated": False,
         "origin": "entry"},
    ]


def live(tmp_path, rows, plan=None, latched=False):
    j = tmp_path / "smallcap_journal.jsonl"
    write_journal(j, rows)
    state = tmp_path / "smallcap"
    (state / "plans").mkdir(parents=True, exist_ok=True)
    if plan is not None:
        (state / "plans" / "p.json").write_text(json.dumps(plan))
    risk = tmp_path / "risk.yaml"
    risk.write_text("S:\n  switched_on: [HYP-0071]\n")
    return publish.gap_hunter_view(journal=j, state_dir=state, risk_yaml=risk)


def test_the_day_is_read_from_todays_arm_with_its_pick_rules_and_timeline(tmp_path):
    v = live(tmp_path, day_rows())
    assert v["heartbeat"] == {"session": "2026-11-24", "armed_at": "2026-11-24T13:30:00+00:00",
                              "last_row": "2026-11-24T14:36:00+00:00", "rows_today": 9, "ended": False}
    assert v["pick"] == {"symbol": "MEDS", "rank": 1, "why": None, "tier2": ["MEDS", "DWTX"]}
    assert [(r["rule"], r["why"]) for r in v["rules"]] == [("e1", "no_level"), ("e2", "ok"), ("e3", None),
                                                           ("e4", "never_red")]
    assert v["rules"][1]["trigger"] == 5.06
    events = [t["event"] for t in v["timeline"]]
    assert events == ["armed", "gap_primary", "entry_placed", "entry_filled", "loop_error", "trade_closed"]
    assert "too_early" not in events                                   # before the arm: not today's session
    assert v["timeline"][-1] == {"t": "2026-11-24T14:36:00+00:00", "event": "trade_closed", "code": "e2",
                                 "why": "time_stop_5m", "symbol": "MEDS", "r": -0.08}
    assert v["rotation"] == {"names": 2, "changes": 1, "done": None}


def test_no_free_text_reaches_the_block(tmp_path):
    v = live(tmp_path, day_rows())
    text = json.dumps(v)
    for marker in ("sekrit", "/home/", "RuntimeError", "headline", "setup"):
        assert marker not in text


def test_closed_trades_carry_the_dec_0074_haircut(tmp_path):
    v = live(tmp_path, day_rows())
    (c,) = v["closed"]
    assert c["symbol"] == "MEDS" and c["code"] == "e2" and c["reason"] == "time_stop_5m" and c["r"] == -0.08
    assert c["h1_r"] is not None and c["h2_r"] is not None and c["h2_r"] < c["h1_r"] < c["r"]


def test_the_open_position_is_read_from_its_plan_file(tmp_path):
    plan = {"kind": "gap", "symbol": "MEDS", "code": "e2", "state": "in_position", "origin": "entry", "qty": 46,
            "filled_qty": 46, "partial_qty": 23, "avg_entry": 5.07, "trigger": 5.06, "stop": 5.07, "stop0": 4.94,
            "target": 5.33, "wt": {"t1": 5.33}, "log": [SECRET]}
    v = live(tmp_path, day_rows()[:7], plan)
    assert v["position"] == {"symbol": "MEDS", "code": "e2", "state": "in_position", "origin": "entry",
                             "shares": 46, "sold_at_target": 23, "entry": 5.07, "trigger": 5.06, "stop": 5.07,
                             "stop0": 4.94, "target": 5.33}
    assert "sekrit" not in json.dumps(v)


def test_the_safety_block_reads_the_stop_rule_and_only_latched_x_codes(tmp_path):
    rows = [*day_rows(), {"ts": "x", "event": "execution_stop", "code": "X3", "new_latch": True,
                          "detail": SECRET}]
    v = live(tmp_path, rows)
    sr = v["safety"]["stop_rule"]
    assert sr["decision"] == "DEC-0066" and sr["trades"] == 1 and sr["max_loss_r"] == -6.0 and sr["review_at"] == 30
    assert v["safety"]["x_latched"] == []                              # the account is not latched: nothing shown


def test_the_live_block_is_valid_against_the_published_contract(tmp_path):
    plan = {"kind": "gap", "symbol": "MEDS", "code": "e2", "state": "in_position", "qty": 46, "filled_qty": 46,
            "avg_entry": 5.07, "stop": 4.94, "target": 5.33}
    v = live(tmp_path, day_rows(), plan)
    san = publish.Sanitizer(lambda x: x, None, strict=False)
    assert san.apply(publish.ALLOW["gap_hunter"], v) == v
