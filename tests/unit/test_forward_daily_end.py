"""forward_test.update_daily never asks SIP for data inside the free plan's 15-minute window (2026-09-28 403), and
fetches the newest update days again on every run instead of once."""
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

    assert ft.update_daily(FakeClient(), [D], now) == [D]
    assert [len(c[0]) for c in calls] == [200, 200, 50]
    assert all(c[1] == "1Day" and c[2] == "2026-09-28" for c in calls)
    assert all(now - utc(c[3]) > dt.timedelta(minutes=15) for c in calls)
    out = pd.read_parquet(chunks / "chunk_zupd_2026-09-28.parquet")
    assert len(out) == 450
    ft.update_daily(FakeClient(), [], now)                         # a later run fetches the recent day again
    assert len(calls) == 6 and all(now - utc(c[3]) > dt.timedelta(minutes=15) for c in calls)
    assert len(pd.read_parquet(chunks / "chunk_zupd_2026-09-28.parquet")) == 450


def test_recent_update_days_are_refetched_and_a_failure_keeps_the_old_chunk(tmp_path, monkeypatch):
    chunks = tmp_path / "daily" / "chunks"
    chunks.mkdir(parents=True)
    pd.DataFrame({"symbol": ["AAA", "BBB"]}).to_parquet(chunks / "chunk_0001.parquet")
    monkeypatch.setattr(ft, "DAILY", tmp_path / "daily" / "daily.parquet")
    monkeypatch.setattr(ft, "LOG", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(ft, "FWD", tmp_path)
    days = [dt.date(2026, 9, 21) + dt.timedelta(days=i) for i in range(8)]
    for x in [x for x in days if x.weekday() < 5]:                 # 09-21 .. 09-28: six earlier update chunks
        pd.DataFrame({"symbol": ["AAA"], "t": pd.Timestamp(f"{x}T04:00Z"), "c": 1.0}).to_parquet(chunks / f"chunk_zupd_{x}.parquet")
    (chunks / "chunk_zupd_manual.parquet").write_bytes(b"")        # a hand-named file is ignored, not parsed
    new = dt.date(2026, 9, 29)
    now = dt.datetime(2026, 9, 29, 16, 20, tzinfo=ET)
    fetched = []

    class Flaky:
        def bars(self, symbols, timeframe, start, end):
            fetched.append(start)
            if start == "2026-09-25":
                raise RuntimeError("HTTP 500")
            return pd.DataFrame({"symbol": list(symbols), "t": pd.Timestamp(f"{start}T04:00Z"), "c": 2.0})

    assert ft.update_daily(Flaky(), [new], now) == [new]
    assert sorted(set(fetched)) == ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"]   # newest 5
    assert pd.read_parquet(chunks / "chunk_zupd_2026-09-28.parquet").c.tolist() == [2.0, 2.0]   # replaced
    assert pd.read_parquet(chunks / "chunk_zupd_2026-09-25.parquet").c.tolist() == [1.0]        # failed: kept
    assert pd.read_parquet(chunks / "chunk_zupd_2026-09-22.parquet").c.tolist() == [1.0]        # older: untouched
    assert not (tmp_path / "ledger.jsonl").exists()               # a refresh failure is not a session error
    assert not [f for f in chunks.iterdir() if f.name.endswith(".tmp")]


def test_a_pending_day_that_cannot_be_fetched_is_logged_and_not_ready(tmp_path, monkeypatch):
    chunks = tmp_path / "daily" / "chunks"
    chunks.mkdir(parents=True)
    pd.DataFrame({"symbol": ["AAA"]}).to_parquet(chunks / "chunk_0001.parquet")
    monkeypatch.setattr(ft, "DAILY", tmp_path / "daily" / "daily.parquet")
    monkeypatch.setattr(ft, "LOG", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(ft, "FWD", tmp_path)

    class Down:
        def bars(self, symbols, timeframe, start, end):
            raise RuntimeError("HTTP 403")

    assert ft.update_daily(Down(), [D], dt.datetime(2026, 9, 28, 16, 20, tzinfo=ET)) == []
    assert "daily_update" in (tmp_path / "ledger.jsonl").read_text()
