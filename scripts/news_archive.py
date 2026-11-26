"""Keep a local copy of Alpaca's news items (wt.data.news_archive). Market data only: no broker call.

  --backfill 2026-04-29..2026-11-25   every day in the range that has no done marker
  --day 2026-11-25                    one day, fetched again even if it is marked done
  --catch-up 30                       the last 30 finished New York days that have no done marker
  --force                             with --backfill or --catch-up, fetch marked days again too

Prints counts only, never a headline (RESTRICTED). Exits 1 if any day failed; the other days still run, and a failed
day stays unmarked, so the next run tries it again. Join the shared rate limiter so a backfill cannot starve a job.

Usage: PYTHONPATH=src .venv/bin/python scripts/news_archive.py --catch-up 30
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import DATA_DIR  # noqa: E402
from wt.data import news_archive as na  # noqa: E402


def _range(text: str) -> tuple[dt.date, dt.date]:
    a, _, b = text.partition("..")
    if not b:
        raise argparse.ArgumentTypeError("a range is FROM..TO")
    return dt.date.fromisoformat(a), dt.date.fromisoformat(b)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--backfill", type=_range)
    g.add_argument("--day", type=dt.date.fromisoformat)
    g.add_argument("--catch-up", type=int, dest="catch_up")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--root", type=Path, default=DATA_DIR / "news")
    ap.add_argument("--per-minute", type=int, default=120)
    a = ap.parse_args(argv)

    now = dt.datetime.now(dt.timezone.utc)
    if a.day:
        todo = [a.day]
    else:
        start, end = a.backfill if a.backfill else na.catch_up_range(now, a.catch_up)
        todo = na.days(start, end) if a.force else na.missing(a.root, start, end)
    if not todo:
        print("news archive: nothing to do")
        return 0

    from wt.data.alpaca import AlpacaREST
    client = AlpacaREST(per_minute=a.per_minute, shared=True)
    failed = 0
    for d in todo:
        try:
            info = na.archive_day(lambda url, params: client.get(url, params), a.root, d, now)
        except Exception as e:  # noqa: BLE001 - one bad day must not stop the others
            failed += 1
            print(f"{d} FAILED {type(e).__name__}")
            continue
        print(f"{d} items={info['items_fetched']} pages={info['pages']} on_day={info['items_on_day']} "
              f"{'done' if info['complete'] else 'partial (day not over)'}")
    print(f"news archive: {len(todo) - failed} of {len(todo)} days read, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
