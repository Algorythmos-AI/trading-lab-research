"""The Gap Hunter block of the stocks snapshot (wt.ops.publish.gap_hunter_view): counts, dates and R from the robot's
own journal, plan files, virtual account and switch, never a symbol. Fixture files only."""
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
    assert v == {"enabled": True, "kill": True, "latched": None, "sessions": 2, "last_session": "2026-11-20",
                 "trades": 1, "total_r": 1.5, "mean_r": 1.5, "open": 1,
                 "funnel": {"session": "2026-11-20", "kept": None, "passed": None, "tier1": None, "tier2": None,
                            "primary": False}}
    assert "ABC" not in json.dumps(v)


def test_nothing_yet_is_off_empty_and_valid_against_the_published_contract(tmp_path):
    risk = tmp_path / "risk.yaml"
    risk.write_text("S:\n  switched_on: []\n")
    v = publish.gap_hunter_view(journal=tmp_path / "none.jsonl", state_dir=tmp_path / "none", risk_yaml=risk)
    assert v["enabled"] is False and v["sessions"] == 0 and v["trades"] == 0 and v["mean_r"] is None
    assert v["funnel"] is None and v["open"] == 0
    san = publish.Sanitizer(lambda x: x, None, strict=False)
    assert san.apply(publish.ALLOW["gap_hunter"], v) == v
