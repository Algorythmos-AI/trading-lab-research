"""A local archive of Alpaca news items (DEC-0003 amendment of 2026-11-26).

Alpaca dropped its Benzinga news history in 2026 (support ticket 402305, answered 2026-11-24): `/v1beta1/news` now
returns only fiscal.ai items, the earliest dated 2026-04-29, and nothing before. News had only ever been read at run
time, so no copy of the old history exists. This module keeps one of what the API serves now, so the next change of
provider does not take the history with it.

Layout under `root` (default `data/news`, git-ignored):
  YYYY/MM/YYYY-MM-DD.parquet   one row per item whose `created_at` falls on that New York date
  _done/YYYY-MM-DD.json        written last, only when every page of a finished day was read

A day is fetched as one window (00:00 to 24:00 New York time, all symbols, ascending, 50 a page). Each item is filed
under the New York date of its own `created_at`, so an item the API returns in a neighbouring window still lands on
its own day. Files are merged by item id, keeping the copy with the latest `updated_at`, and written atomically.
Headlines are RESTRICTED (AGENTS.md): this module stores them and never prints or logs them.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

import pandas as pd

from wt.core.clock import ET, et, to_utc_iso

NEWS_URL = "https://data.alpaca.markets/v1beta1/news"
FIRST_DAY = dt.date(2026, 4, 28)          # New York date of the earliest item, 2026-04-29T02:31:18Z (22:31 ET)
COLUMNS = ["id", "created_at", "updated_at", "symbols", "headline", "source", "url"]
PAGE = 50
MAX_PAGES = 2000                          # 100,000 items in one day: far above the ~2,000 seen; a loop guard

Getter = Callable[[str, dict[str, Any]], Any]


class ArchiveError(RuntimeError):
    """A day could not be read in full; nothing is marked done for it."""


def day_window(day: dt.date) -> tuple[str, str]:
    """The UTC bounds of one New York calendar day (23 or 25 hours on a DST change)."""
    nxt = day + dt.timedelta(days=1)
    return to_utc_iso(et(day, "00:00")), to_utc_iso(et(nxt, "00:00"))


def et_date(ts: str) -> dt.date:
    d: dt.date = pd.Timestamp(ts).tz_convert(ET).date()
    return d


def _row(item: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(item, Mapping) or item.get("id") is None or not item.get("created_at"):
        raise ArchiveError("a news item without an id or a created_at")
    syms = item.get("symbols") or []
    if not isinstance(syms, list):
        raise ArchiveError("a news item whose symbols are not a list")
    return {"id": int(item["id"]), "created_at": str(item["created_at"]),
            "updated_at": str(item.get("updated_at") or item["created_at"]),
            "symbols": ",".join(str(s) for s in syms), "headline": str(item.get("headline") or ""),
            "source": str(item.get("source") or ""), "url": str(item.get("url") or "")}


def fetch_day(get: Getter, day: dt.date) -> tuple[list[dict[str, Any]], int]:
    """Every item of one New York day, all pages. Raises ArchiveError on a malformed answer or a runaway loop."""
    start, end = day_window(day)
    params: dict[str, Any] = {"start": start, "end": end, "limit": PAGE, "sort": "asc",
                              "include_content": "false"}
    rows: list[dict[str, Any]] = []
    seen_tokens: set[str] = set()
    for pages in range(1, MAX_PAGES + 1):
        body = get(NEWS_URL, dict(params))
        if not isinstance(body, Mapping) or not isinstance(body.get("news"), list):
            raise ArchiveError("a news answer without a list of items")
        rows.extend(_row(i) for i in body["news"])
        token = body.get("next_page_token")
        if not token:
            return rows, pages
        if token in seen_tokens:
            raise ArchiveError("the API repeated a page token")
        seen_tokens.add(str(token))
        params["page_token"] = token
    raise ArchiveError(f"more than {MAX_PAGES} pages in one day")


def day_path(root: Path, day: dt.date) -> Path:
    return root / f"{day:%Y}" / f"{day:%m}" / f"{day.isoformat()}.parquet"


def marker_path(root: Path, day: dt.date) -> Path:
    return root / "_done" / f"{day.isoformat()}.json"


def _atomic(path: Path, write: Callable[[Path], None]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp{os.getpid()}")
    try:
        write(tmp)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def read_day(root: Path, day: dt.date) -> pd.DataFrame:
    p = day_path(root, day)
    return pd.read_parquet(p) if p.exists() else pd.DataFrame(columns=COLUMNS)


def merge(old: pd.DataFrame, new: Iterable[dict[str, Any]]) -> pd.DataFrame:
    """Union by id; for a repeated id the copy with the latest updated_at wins (the newest edit)."""
    add = pd.DataFrame(list(new), columns=COLUMNS)
    frames = [f for f in (old, add) if len(f)]
    if not frames:
        return pd.DataFrame(columns=COLUMNS)
    df = pd.concat(frames, ignore_index=True)
    df["_u"] = pd.to_datetime(df["updated_at"], utc=True)
    df = df.sort_values(["id", "_u"]).drop_duplicates("id", keep="last").drop(columns="_u")
    df["_c"] = pd.to_datetime(df["created_at"], utc=True)
    return df.sort_values(["_c", "id"]).drop(columns="_c").reset_index(drop=True)[COLUMNS]


def store(root: Path, rows: Iterable[dict[str, Any]]) -> dict[dt.date, int]:
    """File rows under the New York date of their created_at, merged into what is there. Returns rows per day."""
    by_day: dict[dt.date, list[dict[str, Any]]] = {}
    for r in rows:
        by_day.setdefault(et_date(r["created_at"]), []).append(r)
    counts: dict[dt.date, int] = {}
    for d, rs in sorted(by_day.items()):
        df = merge(read_day(root, d), rs)

        def write(p: Path, df: pd.DataFrame = df) -> None:
            df.to_parquet(p, index=False)

        _atomic(day_path(root, d), write)
        counts[d] = len(df)
    return counts


def is_done(root: Path, day: dt.date) -> bool:
    return marker_path(root, day).exists()


def archive_day(get: Getter, root: Path, day: dt.date, now: dt.datetime) -> dict[str, Any]:
    """Fetch one day, store it, and mark it done when the day is over in New York. Returns the marker's content
    (counts only). A day still running (today, or later) is stored but never marked done."""
    rows, pages = fetch_day(get, day)
    store(root, rows)
    finished = now.astimezone(ET).date() > day
    info: dict[str, Any] = {"day": day.isoformat(), "items_fetched": len(rows), "pages": pages,
                            "items_on_day": len(read_day(root, day)), "complete": finished,
                            "fetched_at": to_utc_iso(now)}
    if finished:
        text = json.dumps(info, sort_keys=True)
        def write(p: Path) -> None:
            p.write_text(text)

        _atomic(marker_path(root, day), write)
    return info


def days(start: dt.date, end: dt.date) -> list[dt.date]:
    if end < start:
        raise ValueError("the range ends before it starts")
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def missing(root: Path, start: dt.date, end: dt.date) -> list[dt.date]:
    return [d for d in days(start, end) if not is_done(root, d)]


def catch_up_range(now: dt.datetime, n: int) -> tuple[dt.date, dt.date]:
    """The last n finished New York days, never before FIRST_DAY."""
    yesterday = now.astimezone(ET).date() - dt.timedelta(days=1)
    return max(FIRST_DAY, yesterday - dt.timedelta(days=n - 1)), yesterday
