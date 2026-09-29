"""Audit R-C1: no loader may return duplicated (symbol, t) rows."""
from __future__ import annotations

import pandas as pd
import pytest

from wt.data import etf_minutes
from wt.data.quality import DataQualityError, assert_unique, dedupe


def bars(day: str, n: int = 3) -> pd.DataFrame:
    t = pd.date_range(f"{day} 09:30", periods=n, freq="1min", tz="America/New_York").tz_convert("UTC")
    return pd.DataFrame({"symbol": "QQQ", "t": t, "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": 1})


def test_assert_unique_raises_on_duplicates_and_dedupe_fixes_them():
    df = pd.concat([bars("2026-09-01"), bars("2026-09-01")])
    with pytest.raises(DataQualityError, match="3 duplicate rows"):
        assert_unique(df, ["symbol", "t"])
    assert len(dedupe(df, ["symbol", "t"])) == 3


def test_month_window_ends_before_the_next_months_first_session():
    s, e = etf_minutes.month_window(pd.Period("2026-09", "M"), "2026-12-31")
    assert s == "2026-09-01T00:00:00-04:00" and e == "2026-09-30T23:59:59-04:00"
    s, e = etf_minutes.month_window(pd.Period("2026-11", "M"), "2026-11-20")      # capped, EST after DST
    assert e == "2026-11-19T23:59:59-05:00"


def test_load_drops_the_overlap_between_month_files(tmp_path):
    # the old builder wrote October's first session into both the September and October files
    pd.concat([bars("2026-09-30"), bars("2026-10-01")]).to_parquet(tmp_path / "2026-09.parquet")
    pd.concat([bars("2026-10-01"), bars("2026-10-02")]).to_parquet(tmp_path / "2026-10.parquet")
    df = etf_minutes.load("QQQ", src=tmp_path)
    assert len(df) == 9 and df.t.is_monotonic_increasing and not df.duplicated(["symbol", "t"]).any()
    assert df.groupby("date").size().tolist() == [3, 3, 3]
