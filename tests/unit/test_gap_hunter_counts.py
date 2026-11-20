"""scripts/gap_hunter_counts.py: counts and dates only, from constructed days. Its `main` (the only part that reads
market data) is never called here."""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest
from gap_days import pool_row, write_pool
from spec_bars import minute_bars

from wt.live import runner_s

DAY = dt.date(2024, 3, 1)
OPEN = (5.00, 5.05, 4.95, 5.02, 150_000)
ORB = [OPEN, (5.03, 5.10, 5.01, 5.08, 80_000)] + [(5.08, 5.12, 5.06, 5.10, 30_000)] * 148      # 09:31 breaks the high
GAPPED = [OPEN, (5.12, 5.20, 5.10, 5.15, 80_000)] + [(5.15, 5.17, 5.13, 5.15, 30_000)] * 148   # over the collar
QUIET = [OPEN] + [(5.02, 5.04, 5.00, 5.02, 30_000)] * 149


@pytest.fixture
def counts(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_s, "POOL_DIR", tmp_path / "candidates")
    monkeypatch.setattr(runner_s, "PM_BARS_DIR", tmp_path / "pm_bars")
    spec = importlib.util.spec_from_file_location("gap_hunter_counts",
                                                  Path(__file__).resolve().parents[2] / "scripts" / "gap_hunter_counts.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, tmp_path


def test_a_days_counts_say_which_rules_had_an_order_and_whether_the_engine_fills(counts):
    mod, _ = counts
    ctx = {"overhead": [99.0]}
    got = mod.day_counts(minute_bars(ORB), ctx, 140)
    assert got["e2"] == {"order": 1, "reached": 1, "fill": 1} and got["day"] == {"reached": 1, "fill": 1, "code": "e2"}
    assert got["e1"] == {"order": 0, "reached": 0, "fill": 0}          # no pre-market level in this context
    over = mod.day_counts(minute_bars(GAPPED), ctx, 140)
    assert over["e2"] == {"order": 1, "reached": 1, "fill": 0} and over["day"]["fill"] == 0
    quiet = mod.day_counts(minute_bars(QUIET), ctx, 140)
    assert quiet["day"] == {"reached": 0, "fill": 0, "code": None} and quiet["e2"]["order"] == 1


def test_a_sessions_line_carries_a_date_and_counts_and_nothing_else(counts):
    mod, root = counts
    write_pool(root, pool_row("ABC"), pool_row("XYZ", rvol_pm=3.0))
    asked = []

    def bars_of(sym):
        asked.append(sym)
        return minute_bars(ORB)

    row = mod.session_counts(DAY, "16:00", bars_of)
    assert asked == ["ABC"]                                            # only the primary's bars are read
    assert row["date"] == "2024-03-01" and row["primary"] == 1 and row["day"]["code"] == "e2"
    text = json.dumps(row)
    assert "ABC" not in text and "XYZ" not in text and "5.0" not in text and "." not in text.replace("2024-03-01", "")
    assert set(row) == {"date", "primary", "e1", "e2", "e3", "e4", "day"}
    allowed = {"order", "reached", "fill", "code"}
    assert all(set(row[k]) <= allowed for k in ("e1", "e2", "e3", "e4", "day"))


def test_a_session_with_no_primary_or_no_bars_says_why_in_a_word(counts):
    mod, root = counts
    assert mod.session_counts(DAY, "16:00", lambda s: None) == {"date": "2024-03-01", "primary": 0, "why": "pool_missing"}
    write_pool(root, pool_row("ABC", float_shares=90_000_000.0))
    assert mod.session_counts(DAY, "16:00", lambda s: None)["why"] == "no_name_passed"
    write_pool(root, pool_row("ABC"))
    assert mod.session_counts(DAY, "16:00", lambda s: None) == {"date": "2024-03-01", "primary": 1, "why": "no_rth_bars"}
    assert mod.session_counts(DAY, "16:00", lambda s: minute_bars(ORB[:20]))["why"] == "no_rth_bars"


def test_the_totals_add_the_lines_up(counts):
    mod, _ = counts
    rows = [{"date": "a", "primary": 1, "e1": {"order": 0, "reached": 0, "fill": 0}, "e2": {"order": 1, "reached": 1, "fill": 1},
             "e3": {"order": 0, "reached": 0, "fill": 0}, "e4": {"order": 1, "reached": 0, "fill": 0},
             "day": {"reached": 1, "fill": 1, "code": "e2"}},
            {"date": "b", "primary": 0, "why": "pool_stale"},
            {"date": "c", "primary": 1, "e1": {"order": 1, "reached": 1, "fill": 0}, "e2": {"order": 1, "reached": 0, "fill": 0},
             "e3": {"order": 0, "reached": 0, "fill": 0}, "e4": {"order": 0, "reached": 0, "fill": 0},
             "day": {"reached": 1, "fill": 0, "code": "e1"}}]
    t = mod.totals(rows)
    assert t["sessions"] == 3 and t["primary"] == 2 and t["no_primary"] == {"pool_stale": 1}
    assert t["e2"] == {"order": 2, "reached": 1, "fill": 1} and t["day"] == {"reached": 2, "fill": 1}
    assert t["day_code"] == {"e2": 1, "e1": 1}
