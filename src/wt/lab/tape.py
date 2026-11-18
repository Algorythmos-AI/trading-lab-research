"""The tape's files (DEC-0060 section 2): Parquet parts per stream, written once, never rewritten.

A session folder holds `<stream>-NNNN.parquet` parts. A restarted recorder starts at the next free part number, so
nothing already written is touched. Rows are raw fields as Alpaca sent them, plus the receive time; nothing is worked
out here.
"""
from __future__ import annotations

import math
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

OPTION = pa.schema([
    ("recv_ns", pa.int64()), ("tick", pa.int32()), ("tier", pa.int8()), ("symbol", pa.string()),
    ("bid", pa.float64()), ("ask", pa.float64()), ("bid_size", pa.int64()), ("ask_size", pa.int64()),
    ("quote_ts", pa.string()), ("last", pa.float64()), ("last_size", pa.int64()), ("last_ts", pa.string()),
    ("volume", pa.int64()), ("iv", pa.float64()), ("delta", pa.float64()), ("gamma", pa.float64()),
    ("theta", pa.float64()), ("vega", pa.float64()),
])
STOCK = pa.schema([
    ("recv_ns", pa.int64()), ("tick", pa.int32()), ("symbol", pa.string()),
    ("bid", pa.float64()), ("ask", pa.float64()), ("bid_size", pa.int64()), ("ask_size", pa.int64()),
    ("quote_ts", pa.string()), ("last", pa.float64()), ("last_size", pa.int64()), ("last_ts", pa.string()),
])
GAP = pa.schema([("recv_ns", pa.int64()), ("tick", pa.int32()), ("stream", pa.string()), ("reason", pa.string())])
PRINT = pa.schema([("recv_ns", pa.int64()), ("symbol", pa.string()), ("ts", pa.string()), ("price", pa.float64()),
                   ("size", pa.int64()), ("exchange", pa.string()), ("conditions", pa.string())])
OPEN_INTEREST = pa.schema([("recv_ns", pa.int64()), ("symbol", pa.string()), ("open_interest", pa.int64()),
                           ("open_interest_date", pa.string()), ("close_price", pa.float64())])
SCHEMAS = {"option": OPTION, "stock": STOCK, "gap": GAP, "print": PRINT, "open_interest": OPEN_INTEREST}


def _num(v: object) -> float | None:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        f = float(v)
        return f if math.isfinite(f) else None
    return None


def _cnt(v: object) -> int | None:
    f = _num(v)
    return int(f) if f is not None and abs(f) < 2**62 else None


def _str(v: object) -> str | None:
    return v if isinstance(v, str) else None


def quote_fields(snap: Mapping[str, Any]) -> dict[str, Any]:
    """The raw quote and trade fields of one Alpaca snapshot (option or stock). Zero bids are kept as zero."""
    q0, t0 = snap.get("latestQuote"), snap.get("latestTrade")
    q: Mapping[str, Any] = q0 if isinstance(q0, Mapping) else {}
    t: Mapping[str, Any] = t0 if isinstance(t0, Mapping) else {}
    return {"bid": _num(q.get("bp")), "ask": _num(q.get("ap")), "bid_size": _cnt(q.get("bs")),
            "ask_size": _cnt(q.get("as")), "quote_ts": _str(q.get("t")), "last": _num(t.get("p")),
            "last_size": _cnt(t.get("s")), "last_ts": _str(t.get("t"))}


def option_fields(snap: Mapping[str, Any]) -> dict[str, Any]:
    g0, b0 = snap.get("greeks"), snap.get("dailyBar")
    g: Mapping[str, Any] = g0 if isinstance(g0, Mapping) else {}
    b: Mapping[str, Any] = b0 if isinstance(b0, Mapping) else {}
    return {**quote_fields(snap), "volume": _cnt(b.get("v")), "iv": _num(snap.get("impliedVolatility")),
            "delta": _num(g.get("delta")), "gamma": _num(g.get("gamma")), "theta": _num(g.get("theta")),
            "vega": _num(g.get("vega"))}


class PartWriter:
    """Buffers one stream's rows and writes them as numbered Parquet parts (zstd). Small parts (20,000 rows) keep
    memory low; the recorder also flushes on a timer, so a stop loses at most a few minutes."""

    def __init__(self, folder: Path, stream: str, max_rows: int = 20_000) -> None:
        self.folder, self.stream, self.schema, self.max_rows = folder, stream, SCHEMAS[stream], max_rows
        self.rows: list[dict[str, Any]] = []
        self.written = 0
        folder.mkdir(parents=True, exist_ok=True)
        for t in folder.glob(f"{stream}-*.parquet.tmp"):        # a write a stop interrupted: never listed, removed
            t.unlink()

    def next_part(self) -> Path:
        n = len(list(self.folder.glob(f"{self.stream}-*.parquet")))
        while (p := self.folder / f"{self.stream}-{n:04d}.parquet").exists():
            n += 1
        return p

    def add(self, row: Mapping[str, Any]) -> None:
        self.rows.append({name: row.get(name) for name in self.schema.names})
        if len(self.rows) >= self.max_rows:
            self.flush()

    def flush(self) -> Path | None:
        if not self.rows:
            return None
        path = self.next_part()
        tmp = path.with_suffix(".parquet.tmp")
        pq.write_table(pa.Table.from_pylist(self.rows, schema=self.schema), tmp, compression="zstd")
        with tmp.open("rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, path)
        self.written += len(self.rows)
        self.rows = []
        return path
