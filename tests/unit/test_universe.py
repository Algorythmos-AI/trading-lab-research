"""load_daily: a nightly update chunk that repeats a session already in the base chunks must not duplicate rows."""
import pandas as pd

from wt.data import universe


def _bars(syms, day, c):
    t = pd.Timestamp(f"{day} 04:00", tz="UTC")
    return pd.DataFrame({"symbol": syms, "t": [t] * len(syms), "o": c, "h": c, "l": c, "c": c, "v": 100, "n": 1, "vw": c})


def test_update_chunk_overlapping_base_is_deduplicated(tmp_path, monkeypatch):
    chunks = tmp_path / "chunks"
    chunks.mkdir()
    monkeypatch.setattr(universe, "DAILY", tmp_path / "daily.parquet")
    pd.concat([_bars(["AA", "BB"], "2026-09-24", 1.0), _bars(["AA", "BB"], "2026-09-25", 2.0)]).to_parquet(chunks / "chunk_00000.parquet")
    _bars(["AA", "BB"], "2026-09-25", 2.5).to_parquet(chunks / "chunk_zupd_2026-09-25.parquet")
    d = universe.load_daily()
    assert not d.duplicated(["symbol", "date"]).any() and len(d) == 4
    assert (d[d.date.astype(str) == "2026-09-25"].c == 2.0).all()      # the base (rebuilt) copy wins


def test_base_chunks_beat_update_chunks_and_later_updates_beat_earlier_ones(tmp_path, monkeypatch):
    chunks = tmp_path / "chunks"
    chunks.mkdir()
    monkeypatch.setattr(universe, "DAILY", tmp_path / "daily.parquet")
    _bars(["AA"], "2026-09-28", 9.0).to_parquet(chunks / "chunk_zupd_2026-09-28.parquet")    # the night's fetch
    pd.concat([_bars(["AA"], "2026-09-28", 9.5), _bars(["AA"], "2026-09-29", 7.0)]).to_parquet(
        chunks / "chunk_zupd_2026-09-29.parquet")                                           # a later update file
    got = {str(k): v for k, v in universe.load_daily().set_index("date").c.items()}
    assert got == {"2026-09-28": 9.5, "2026-09-29": 7.0}                     # among update chunks the later file wins
    pd.concat([_bars(["AA"], "2026-09-25", 1.0), _bars(["AA"], "2026-09-28", 8.8)]).to_parquet(chunks / "chunk_99999.parquet")
    got = {str(k): v for k, v in universe.load_daily().set_index("date").c.items()}
    assert got == {"2026-09-25": 1.0, "2026-09-28": 8.8, "2026-09-29": 7.0}   # a base rebuild beats both
