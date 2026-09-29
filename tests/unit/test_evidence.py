"""Weekly evidence PR (wt.ops.evidence): only new, immutable copies; never a path the runtime writes."""
from __future__ import annotations

import datetime as dt

from wt.ops import evidence


def test_iso_week():
    assert evidence.iso_week(dt.date(2026, 10, 3)) == "2026-W40"


def test_plan_copies_only_new_files_and_never_overwrites(tmp_path):
    wt, var = tmp_path / "wt", tmp_path / "var"
    (var / "forward").mkdir(parents=True)
    (var / "forward" / "forward_trades.jsonl").write_text('{"session": "2026-10-02"}\n')
    (var / "watchlist").mkdir()
    (var / "watchlist" / "2026-10-01.json").write_text("{}")
    (var / "watchlist" / "2026-10-02.json").write_text("{}")
    (var / "scorecards").mkdir()
    (var / "scorecards" / "scorecard_2026-10-03.md").write_text("# card")
    (wt / "watchlist").mkdir(parents=True)
    (wt / "watchlist" / "2026-10-01.json").write_text("{}")                 # already tracked
    pairs = evidence.plan_copies(wt, "2026-W40", var / "forward" / "forward_trades.jsonl", var / "watchlist",
                                 var / "scorecards")
    dsts = sorted(str(d.relative_to(wt)) for _, d in pairs)
    assert dsts == ["research/forward/archive/2026-W40/forward_trades.jsonl",
                    "research/forward/archive/2026-W40/scorecard_2026-10-03.md", "watchlist/2026-10-02.json"]
    for _, d in pairs:                                                      # once archived, nothing is re-copied
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_text("x")
    assert evidence.plan_copies(wt, "2026-W40", var / "forward" / "forward_trades.jsonl", var / "watchlist",
                                var / "scorecards") == []


def test_run_is_skipped_without_a_token(monkeypatch, capsys):
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert evidence.run() == 0 and "skipped" in capsys.readouterr().out
