"""forward_test.update_daily must never ask SIP for data inside the free plan's 15-minute window (2026-09-28 403)."""
import datetime as dt
import importlib.util
from pathlib import Path

import pandas as pd

from wt.core.clock import ET, UTC
from wt.data.alpaca import SIP_DELAY_MIN

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("forward_test", ROOT / "scripts/forward_test.py")
ft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ft)

D = dt.date(2026, 9, 28)


def utc(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def test_end_is_capped_16_minutes_before_now_on_the_nightly_run():
    now = dt.datetime(2026, 9, 28, 16, 20, tzinfo=ET)            # the launchd run, ~20 min after the close
    end = utc(ft.daily_end(D, now))
    assert end == now - dt.timedelta(minutes=SIP_DELAY_MIN)
    assert now - end > dt.timedelta(minutes=15)                   # outside the refused window
    assert end > dt.datetime(2026, 9, 28, 16, 0, tzinfo=ET)       # still covers the whole regular session


def test_end_is_the_next_midnight_when_the_session_is_long_past():
    now = dt.datetime(2026, 9, 29, 9, 0, tzinfo=ET)               # a manual catch-up run the next morning
    assert utc(ft.daily_end(D, now)) == dt.datetime(2026, 9, 29, 0, 0, tzinfo=ET)


def test_update_daily_requests_a_permitted_window(tmp_path, monkeypatch):
    chunks = tmp_path / "daily" / "chunks"
    chunks.mkdir(parents=True)
    pd.DataFrame({"symbol": [f"S{i:03d}" for i in range(450)]}).to_parquet(chunks / "chunk_0001.parquet")
    monkeypatch.setattr(ft, "DAILY", tmp_path / "daily" / "daily.parquet")
    now = dt.datetime(2026, 9, 28, 16, 20, tzinfo=ET)
    calls = []

    class FakeClient:
        def bars(self, symbols, timeframe, start, end):
            calls.append((list(symbols), timeframe, start, end))
            return pd.DataFrame({"symbol": list(symbols), "t": pd.Timestamp("2026-09-28T04:00Z"), "c": 1.0})

    ft.update_daily(FakeClient(), D, now)
    assert [len(c[0]) for c in calls] == [200, 200, 50]
    assert all(c[1] == "1Day" and c[2] == "2026-09-28" for c in calls)
    assert all(now - utc(c[3]) > dt.timedelta(minutes=15) for c in calls)
    out = pd.read_parquet(chunks / "chunk_zupd_2026-09-28.parquet")
    assert len(out) == 450
    ft.update_daily(FakeClient(), D, now)                          # already written: no second fetch
    assert len(calls) == 3
