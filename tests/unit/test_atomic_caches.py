"""Shared caches (signal spreads, minute bars, pre-market aggregates) are written atomically and a torn file is read as
empty with a warning, instead of crashing the next job or being silently overwritten (audit: non-atomic caches)."""
import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

import pandas as pd
import pytest

from wt.backtest import runner
from wt.ops import safeio
from wt.scanner import features

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
_spec = importlib.util.spec_from_file_location("r3_run", ROOT / "scripts/r3_run.py")
r3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(r3)

D = dt.date(2024, 3, 1)


def test_a_failed_write_leaves_the_old_file_and_no_temp(tmp_path):
    f = tmp_path / "cache.parquet"
    pd.DataFrame({"symbol": ["OLD"]}).to_parquet(f)

    def boom(p):
        p.write_bytes(b"PAR1 half a file")
        raise KeyboardInterrupt                                     # the job is killed mid-write

    with pytest.raises(KeyboardInterrupt):
        safeio.atomic_replace(f, boom)
    assert list(pd.read_parquet(f).symbol) == ["OLD"]
    assert [p.name for p in tmp_path.iterdir()] == ["cache.parquet"]


def test_a_torn_json_cache_reads_as_empty_and_is_kept_aside(tmp_path):
    f = tmp_path / "signal_spreads.json"
    f.write_text('{"ABC|2024-03-01T14:31:00+00:00": 0.02, "XY')
    with pytest.warns(RuntimeWarning, match="unreadable"):
        got = safeio.read_cache(f, lambda p: json.loads(p.read_text()), dict)
    assert got == {} and not f.exists() and (tmp_path / "signal_spreads.json.corrupt").exists()


def test_spread_cache_survives_a_torn_file_and_saves_atomically(tmp_path, monkeypatch):
    f = tmp_path / "signal_spreads.json"
    f.write_text('{"ABC|x": 0.0')
    monkeypatch.setattr(r3, "QUOTE_CACHE", f)

    class Client:
        def get(self, url, params, tries=3):
            return {"quotes": {"ABC": [{"bp": 5.00, "ap": 5.02}]}}

    with pytest.warns(RuntimeWarning):
        s = r3.SpreadAt(Client())
    assert s.cache == {}
    assert abs(s("ABC", pd.Timestamp("2024-03-01T14:31:00Z")) - 0.02) < 1e-9
    s.save()
    assert list(json.loads(f.read_text()).values()) == [pytest.approx(0.02)]
    assert not [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]


def test_minute_cache_refetches_a_torn_day_file(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "MIN_DIR", tmp_path)
    (tmp_path / f"{D}.parquet").write_bytes(b"PAR1\x00torn")
    calls = []

    class Client:
        def bars(self, symbols, timeframe, start, end, feed="sip"):
            calls.append(list(symbols))
            t = pd.date_range("2024-03-01 14:30", periods=3, freq="1min", tz="UTC")
            return pd.DataFrame({"symbol": symbols[0], "t": t, "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": 100})

    with pytest.warns(RuntimeWarning):
        got = runner.minute_bars(Client(), D, ["ABC"])
    assert calls == [["ABC"]] and len(got["ABC"]) == 3
    assert len(pd.read_parquet(tmp_path / f"{D}.parquet")) == 3     # rewritten whole
    runner.minute_bars(Client(), D, ["ABC"])
    assert len(calls) == 1                                          # and served from the cache afterwards


def test_pm_cache_survives_a_torn_file(tmp_path, monkeypatch):
    f = tmp_path / "pm_agg.parquet"
    f.write_bytes(b"not parquet")
    monkeypatch.setattr(features, "PM_CACHE", f)
    with pytest.warns(RuntimeWarning):
        c = features.PMCache()
    assert c.missing(["ABC"], [D]) == [("ABC", D)]
    c.add([{"symbol": "ABC", "date": D, "pm_volume": 1.0, "pm_dollar_vol": 1.0, "last_0925": 1.0, "pm_high": 1.0, "n_bars": 1}])
    c.save()
    assert list(pd.read_parquet(f).symbol) == ["ABC"]
    assert features.PMCache().missing(["ABC"], [D]) == []


def _pm(sym, day, v=1.0):
    return {"symbol": sym, "date": day, "pm_volume": v, "pm_dollar_vol": v, "last_0925": v, "pm_high": v, "n_bars": 1}


def test_a_filtered_pm_cache_saves_without_dropping_older_rows(tmp_path, monkeypatch):
    f = tmp_path / "pm_agg.parquet"
    monkeypatch.setattr(features, "PM_CACHE", f)
    old = D - dt.timedelta(days=400)
    pd.DataFrame([_pm("OLD", old), _pm("ABC", D - dt.timedelta(days=1))]).to_parquet(f)
    before = pd.read_parquet(f)
    c = features.PMCache(since=D - dt.timedelta(days=30))
    assert list(c.df.symbol) == ["ABC"]                                  # only the recent rows are held
    with pytest.raises(ValueError):
        c.missing(["OLD"], [old])                                        # an earlier date is refused, not "missing"
    with pytest.raises(ValueError):
        c.get(["OLD"], [old])
    assert c.missing(["ABC", "NEW"], [D - dt.timedelta(days=1), D]) == [("ABC", D), ("NEW", D - dt.timedelta(days=1)), ("NEW", D)]
    c.add([_pm("ABC", D, 2.0), _pm("ABC", D, 9.0)])                      # a repeat within the run is ignored
    c.save()
    after = pd.read_parquet(f)
    assert len(after) == 3 and list(after.symbol) == ["OLD", "ABC", "ABC"]
    pd.testing.assert_frame_equal(after.iloc[:2], before)                # the older rows survive, unchanged
    assert after.dtypes.to_dict() == before.dtypes.to_dict()
    assert after.iloc[2].pm_volume == 2.0
    assert features.PMCache().missing(["OLD", "ABC"], [old, D]) == [("OLD", D), ("ABC", old)]


def test_pm_cache_save_keeps_rows_another_writer_added(tmp_path, monkeypatch):
    f = tmp_path / "pm_agg.parquet"
    monkeypatch.setattr(features, "PM_CACHE", f)
    pd.DataFrame([_pm("AAA", D)]).to_parquet(f)
    a, b = features.PMCache(), features.PMCache()                      # two writers load the same file
    a.add([_pm("BBB", D)])
    b.add([_pm("CCC", D), _pm("BBB", D, 7.0)])
    a.save()
    b.save()                                                            # the old save wrote b's copy over a's rows
    got = pd.read_parquet(f)
    assert sorted(got.symbol) == ["AAA", "BBB", "CCC"]
    assert got.set_index("symbol").pm_volume["BBB"] == 1.0              # the first writer's row stands


def test_pm_cache_save_waits_for_the_lock_beside_the_file(tmp_path, monkeypatch):
    from wt.ops import locks
    f = tmp_path / "pm_agg.parquet"
    monkeypatch.setattr(features, "PM_CACHE", f)
    monkeypatch.setattr(features, "PM_LOCK_WAIT_S", 0.0)
    monkeypatch.setattr(locks, "LOCK_DIR", tmp_path / "elsewhere")   # another checkout's or WT_STATE's lock dir
    c = features.PMCache()
    c.add([_pm("ABC", D)])
    with locks.job_lock(features.PM_LOCK, root=tmp_path), pytest.raises(RuntimeError):
        c.save()
    assert not f.exists() and len(c.new) == 1                          # nothing written, nothing forgotten
    c.save()
    assert list(pd.read_parquet(f).symbol) == ["ABC"]


def test_a_save_never_overwrites_a_file_it_could_not_open(tmp_path, monkeypatch):
    f = tmp_path / "pm_agg.parquet"
    monkeypatch.setattr(features, "PM_CACHE", f)
    pd.DataFrame([_pm("OLD", D - dt.timedelta(days=5))]).to_parquet(f)
    c = features.PMCache()
    c.add([_pm("ABC", D)])

    def emfile(*a, **k):
        raise OSError(24, "Too many open files")
    monkeypatch.setattr(features.pq, "ParquetFile", emfile)
    with pytest.raises(RuntimeError):
        c.save()
    assert list(pd.read_parquet(f).symbol) == ["OLD"] and len(c.new) == 1   # the file is intact; nothing forgotten


def test_an_io_error_on_load_never_sets_a_good_cache_aside(tmp_path, monkeypatch):
    f = tmp_path / "pm_agg.parquet"
    pd.DataFrame([_pm("OLD", D)]).to_parquet(f)

    def emfile(*a, **k):
        raise OSError(24, "Too many open files")
    with pytest.raises(OSError):
        safeio.read_cache(f, emfile, lambda: None)
    with pytest.raises(MemoryError):
        safeio.read_cache(f, lambda p: (_ for _ in ()).throw(MemoryError()), lambda: None)
    assert f.exists() and not list(tmp_path.glob("*.corrupt*"))


def test_a_second_torn_file_does_not_overwrite_the_first_one_kept_aside(tmp_path):
    f = tmp_path / "c.parquet"
    (tmp_path / "c.parquet.corrupt").write_bytes(b"first")
    f.write_bytes(b"second")
    with pytest.warns(RuntimeWarning):
        assert safeio.read_cache(f, pd.read_parquet, lambda: "empty") == "empty"
    assert (tmp_path / "c.parquet.corrupt").read_bytes() == b"first"
    assert [p.read_bytes() for p in tmp_path.glob("c.parquet.corrupt-*")] == [b"second"]


def test_saves_compact_small_row_groups(tmp_path, monkeypatch):
    import pyarrow.parquet as pq
    f = tmp_path / "pm_agg.parquet"
    monkeypatch.setattr(features, "PM_CACHE", f)
    monkeypatch.setattr(features, "PM_MAX_ROW_GROUPS", 3)
    for i in range(6):
        c = features.PMCache()
        c.add([_pm(f"S{i}", D)])
        c.save()
    assert pq.ParquetFile(f).num_row_groups <= 3
    assert sorted(pd.read_parquet(f).symbol) == [f"S{i}" for i in range(6)]
