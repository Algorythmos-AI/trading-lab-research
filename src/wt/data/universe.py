"""Point-in-time equity universe from daily bars (active + inactive listed symbols).

Known limitation (DEC-0003): Alpaca's inactive-asset list is incomplete (e.g. TWTR, SIVB, BBBY, FRC are
absent although their bars exist), so some delisted names are missing -> residual survivorship bias,
which flatters long-momentum results. Reported in every G1 report.
"""
from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from wt.core.config import DATA_DIR  # noqa: E402
from wt.data.alpaca import AlpacaREST  # noqa: E402

LISTED = {"NASDAQ", "NYSE", "AMEX"}
FUND_RX = re.compile(r"\b(ETF|ETN|Funds?|Index|Shares|Trust|Notes?|Warrants?|Rights?|Units?|Preferred|Depositary|Acquisition Corp)\b", re.I)
DAILY = DATA_DIR / "daily" / "equities_daily.parquet"
ASSETS = DATA_DIR / "daily" / "assets.parquet"


def build_assets(a: AlpacaREST) -> pd.DataFrame:
    rows = []
    for status in ("active", "inactive"):
        for x in a.assets(status):
            if x["exchange"] in LISTED:
                rows.append({"symbol": x["symbol"], "name": x["name"], "exchange": x["exchange"], "status": status,
                             "is_fund_like": bool(FUND_RX.search(x["name"] or "")),
                             "has_dot": "." in x["symbol"] or "/" in x["symbol"]})
    df = pd.DataFrame(rows).drop_duplicates("symbol")
    ASSETS.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(ASSETS)
    return df


def build_daily(start: str = "2018-06-01", end: str | None = None) -> None:
    a = AlpacaREST()
    assets = build_assets(a)
    warrant_like = assets.symbol.str.len().ge(5) & assets.symbol.str[-1].isin(list("WRU"))
    clean = assets.symbol.str.fullmatch(r"[A-Z]{1,5}")
    syms = assets[clean & ~assets.is_fund_like & ~assets.has_dot & ~warrant_like].symbol.tolist()
    syms += ["SPY", "QQQ", "SPYM", "QQQM", "IWM"]  # ETF track + regime inputs
    # free plan forbids SIP data from the last 15 min; an end *date* of today counts as recent
    end = end or (pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=16)).strftime("%Y-%m-%dT%H:%M:%SZ")
    chunk_dir = DAILY.parent / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    for i in range(0, len(syms), 200):
        f = chunk_dir / f"chunk_{i:05d}.parquet"
        if f.exists():          # resumable
            continue
        batch = syms[i:i + 200]
        try:
            df = a.bars(batch, "1Day", start, end, feed="sip", adjustment="raw")
        except Exception as e:  # isolate bad symbols: retry one by one
            print(f"  chunk {i} failed ({e.__class__.__name__}); retrying per symbol", flush=True)
            dfs = []
            for s_ in batch:
                try:
                    dfs.append(a.bars([s_], "1Day", start, end, feed="sip", adjustment="raw"))
                except Exception:
                    print(f"    skip {s_}", flush=True)
            df = pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()
        df.to_parquet(f)
        print(f"  {min(i + 200, len(syms))}/{len(syms)} symbols", flush=True)
    daily = load_daily()
    print(f"saved chunks in {chunk_dir}: {len(daily)} rows, {daily.symbol.nunique()} symbols (no merged copy: disk-light)")


COLS = ["symbol", "t", "o", "h", "l", "c", "v", "n", "vw"]
VALUE_COLS = ["o", "h", "l", "c", "v", "n", "vw"]
TAIL_MARGIN = 60              # spare rows per symbol beyond what the oldest evaluated session needs
INDEX_ETFS = ("SPY", "QQQ", "IWM")     # trade every session: their dates are the store's sessions


class TailWindowExceeded(RuntimeError):
    """A point-in-time lookup reached before the rows a tail load kept, so its answer would silently differ from a
    full load. Load more rows (tail_rows_for) instead of trusting a shortened history."""


@dataclass(frozen=True)
class TailMeta:
    """What load_daily_tail kept. `first_kept`: symbols whose history was cut -> the earliest date still held; every
    other symbol is complete. A lookup is exact when it needs no row before its symbol's first kept date."""
    rows: int
    data_end: dt.date | None
    first_kept: Mapping[str, dt.date] = field(default_factory=dict)

    @property
    def complete_from(self) -> dt.date | None:
        """The earliest day on which every symbol's rows are all held (None: nothing was cut)."""
        return max(self.first_kept.values()) if self.first_kept else None

    def covers(self, day: dt.date) -> bool:
        """True if every symbol's rows dated on or after `day` are held (so date filters from `day` are exact)."""
        start = self.complete_from
        return start is None or day >= start

    def covers_symbol(self, symbol: str, day: dt.date) -> bool:
        first = self.first_kept.get(symbol)
        return first is None or day >= first


def _chunk_files() -> list[Path]:
    return sorted((DAILY.parent / "chunks").glob("chunk_*.parquet"))


def _read_chunk(f: Path, symbols: list[str] | None = None) -> pd.DataFrame:
    x = pd.read_parquet(f, columns=COLS, filters=[("symbol", "in", symbols)] if symbols is not None else None)
    x = x.assign(_base=not f.name.startswith("chunk_zupd_"))
    x["date"] = x["t"].dt.tz_convert("America/New_York").dt.date
    return x.drop(columns=["t"])


def _merge(parts: list[pd.DataFrame]) -> pd.DataFrame:
    daily = pd.concat(parts, ignore_index=True)
    # A nightly update chunk (chunk_zupd_<date>) can repeat a session that a base chunk also holds. Keep one row
    # per symbol-day and let the base chunk win: a base rebuild is the corrected copy, while an update chunk was
    # fetched minutes after that session's close (audit: update chunks overrode later rebuilds). Among update
    # chunks the later file wins (the sort is stable; chunks are read in name order).
    daily = daily.sort_values("_base", kind="stable").drop_duplicates(["symbol", "date"], keep="last")
    return daily.drop(columns=["_base"]).sort_values(["symbol", "date"], ignore_index=True)


def load_daily() -> pd.DataFrame:
    """Read the whole chunked daily store (no merged duplicate is written, to save disk). Peaks near 3 GB: the
    research scripts and old-date replays use it; the nightly jobs use load_daily_tail."""
    return _merge([_read_chunk(f) for f in _chunk_files()])


def load_daily_symbols(symbols: Iterable[str]) -> pd.DataFrame:
    """The full history of just these symbols, identical to their rows in load_daily()."""
    syms = sorted(set(symbols)) or ["\0"]          # "\0" matches nothing: an empty frame with the usual columns
    return _merge([_read_chunk(f, syms) for f in _chunk_files()])


def _keep_last(sid: np.ndarray, day: np.ndarray, prio: np.ndarray, rows: int) -> tuple[np.ndarray, np.ndarray]:
    """Row positions that survive the merge and the cut: one row per (symbol, day), the highest `prio` winning (ties:
    the later position, as a stable sort then keep="last" does), then each symbol's last `rows` days. Also returns
    the symbol ids that lost days to the cut."""
    order = np.lexsort((np.arange(len(sid)), prio, day, sid))
    s, d = sid[order], day[order]
    last = np.ones(len(order), dtype=bool)
    last[:-1] = (s[1:] != s[:-1]) | (d[1:] != d[:-1])               # the final copy of each symbol-day wins
    order, s = order[last], s[last]
    back = np.zeros(len(order), dtype=np.int64)                    # days after this one, within its symbol
    if len(order):
        new = np.r_[True, s[1:] != s[:-1]]
        start = np.flatnonzero(new)
        size = np.diff(np.r_[start, len(order)])
        back = np.repeat(start + size, size) - np.arange(len(order)) - 1
    return order[back < rows], np.unique(s[back >= rows])


def load_daily_tail(rows: int) -> tuple[pd.DataFrame, TailMeta]:
    """Each symbol's last `rows` rows, identical to load_daily().groupby("symbol").tail(rows) (same columns, dtypes and
    order), without ever holding the whole store. Every file is deduplicated and cut on its own before the merge,
    which is exact: a row among a symbol's last `rows` distinct days overall is also among them within its own file,
    and the file that wins the merge holds it. The merge runs on plain arrays (symbol ids, int64 days), so peak
    memory is about one file plus the kept rows."""
    if rows < 1:
        raise ValueError("rows must be >= 1")
    files = _chunk_files()
    ids: dict[str, int] = {}
    keep: dict[str, list[np.ndarray]] = {k: [] for k in ("sid", "day", "prio", *VALUE_COLS)}
    cut: set[int] = set()
    str_dtype = None
    for i, f in enumerate(files):
        x = pd.read_parquet(f, columns=COLS, use_threads=False)
        str_dtype = str_dtype or x["symbol"].dtype
        codes, names = pd.factorize(x["symbol"])
        sid = np.array([ids.setdefault(str(n), len(ids)) for n in names], dtype=np.int64)[codes]
        day = x["t"].dt.tz_convert("America/New_York").dt.tz_localize(None).dt.normalize().to_numpy().astype("datetime64[ns]").view(np.int64)
        prio = np.full(len(x), (0 if f.name.startswith("chunk_zupd_") else len(files)) + i, dtype=np.int64)
        pos, lost = _keep_last(sid, day, prio, rows)
        cut |= set(lost.tolist())
        keep["sid"].append(sid[pos])
        keep["day"].append(day[pos])
        keep["prio"].append(prio[pos])
        for c in VALUE_COLS:
            keep[c].append(x[c].to_numpy()[pos])
        del x
    if not files:
        raise ValueError("No objects to concatenate")
    arr = {k: np.concatenate(keep.pop(k)) for k in list(keep)}     # one column at a time: no second full copy
    pos, lost = _keep_last(arr["sid"], arr["day"], arr["prio"], rows)
    cut |= set(lost.tolist())
    names = np.array(list(ids), dtype=object)
    rank = np.empty(len(names), dtype=np.int64)                    # symbol id -> rank of its name (the final sort)
    rank[np.argsort(names, kind="stable")] = np.arange(len(names))
    pos = pos[np.lexsort((arr["day"][pos], rank[arr["sid"][pos]]))]
    sid = arr.pop("sid")[pos]
    days, inv = np.unique(arr.pop("day")[pos], return_inverse=True)
    del arr["prio"]
    cols = {"symbol": pd.array(names[sid], dtype=str_dtype)}
    for c in VALUE_COLS:
        cols[c] = arr.pop(c)[pos]
    # one datetime.date per distinct day, shared by its rows (equal values; far fewer objects than one per row)
    cols["date"] = np.array(list(pd.DatetimeIndex(days.view("datetime64[ns]")).date), dtype=object)[inv.ravel()]
    daily = pd.DataFrame(cols, copy=False)
    del cols
    firsts = daily[np.isin(sid, list(cut))].groupby("symbol").date.min() if cut else pd.Series(dtype=object)
    meta = TailMeta(rows=rows, data_end=daily.date.max() if len(daily) else None,
                    first_kept={str(s_): d for s_, d in firsts.items()})
    return daily, meta


def sessions_since(day: dt.date) -> int:
    """Sessions in the store dated on or after `day` (the index ETFs' dates; they trade every session)."""
    dates: set[dt.date] = set()
    for f in _chunk_files():
        t = pd.read_parquet(f, columns=["t"], filters=[("symbol", "in", list(INDEX_ETFS))]).t
        dates |= set(t.dt.tz_convert("America/New_York").dt.date)
    return sum(1 for d in dates if d >= day)


def tail_rows_for(day: dt.date, lookback: int, margin: int = TAIL_MARGIN) -> int:
    """Rows per symbol that make every lookback of `lookback` rows before `day`, or any later day, exact."""
    return lookback + sessions_since(day) + margin


if __name__ == "__main__":
    build_daily()
