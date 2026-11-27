"""Keep a local copy of Alpaca's news items (wt.data.news_archive). Market data only: no broker call.

  --backfill 2026-04-29..2026-11-25   every day in the range that has no done marker
  --day 2026-11-25                    one day, fetched again even if it is marked done
  --catch-up 30                       the last 30 finished New York days that have no done marker
  --force                             with --backfill or --catch-up, fetch marked days again too
  --publish                           then commit the archive folder and push it to the PRIVATE archive repository
                                      (refuses any other remote; docs/runbooks/news-archive.md). With
                                      NEWS_ARCHIVE_TOKEN set (the host), git authenticates with it and a missing clone
                                      is cloned first; with neither a clone nor the token, the run does nothing and
                                      exits 0 (a host not yet set up).

Prints counts only, never a headline (RESTRICTED). Exits 1 if any day failed; the other days still run, and a failed
day stays unmarked, so the next run tries it again. Join the shared rate limiter so a backfill cannot starve a job.

Usage: PYTHONPATH=src .venv/bin/python scripts/news_archive.py --catch-up 30 --publish
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
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
    ap.add_argument("--root", type=Path, default=na.DEFAULT_ROOT)
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--per-minute", type=int, default=120)
    a = ap.parse_args(argv)

    token = os.environ.get("NEWS_ARCHIVE_TOKEN") or None    # na.TOKEN_ENV; a literal so the env-var docs check sees it
    a.git = na.git_runner(token)
    if a.publish and not (a.root.parent / ".git").exists():
        if not token:
            print(f"news archive: no clone at {a.root.parent} and no {na.TOKEN_ENV}; not set up here, nothing done")
            return 0
        try:
            na.ensure_clone(a.root.parent, a.git)
        except Exception as e:  # noqa: BLE001 - report and exit nonzero; nothing was fetched
            print(f"news archive: clone FAILED {type(e).__name__}: {e if isinstance(e, na.ArchiveError) else ''}")
            return 1
        print("news archive: cloned the private archive repository")
    now = dt.datetime.now(dt.timezone.utc)
    if a.day:
        todo = [a.day]
    else:
        start, end = a.backfill if a.backfill else na.catch_up_range(now, a.catch_up)
        todo = na.days(start, end) if a.force else na.missing(a.root, start, end)
    if not todo:
        print("news archive: nothing to fetch")
        return _publish(a, []) if a.publish else 0

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
    code = 1 if failed else 0
    if a.publish:
        code = max(code, _publish(a, todo))
    return code


def _publish(a: argparse.Namespace, todo: list[dt.date]) -> int:
    span = f"{todo[0]}..{todo[-1]}" if todo else "no new day"
    try:
        pushed = na.publish(a.root.parent, f"alpaca-news: {span}", a.git)
    except Exception as e:  # noqa: BLE001 - report and exit nonzero; the files stay in the clone for the next run
        print(f"news archive: publish FAILED {type(e).__name__}: {e if isinstance(e, na.ArchiveError) else ''}")
        return 1
    print("news archive: pushed" if pushed else "news archive: nothing new to push")
    return 0


if __name__ == "__main__":
    sys.exit(main())
