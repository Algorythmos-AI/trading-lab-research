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
