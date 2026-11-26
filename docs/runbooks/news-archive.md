# News archive (Alpaca news, fiscal.ai)

**You'll notice:** you need news items for a date in the past, an archive run printed `FAILED`, or Alpaca changed its
news provider again.

## Why it exists

Alpaca removed its Benzinga news history for every account in 2026. Its support team confirmed this on 2026-11-24
(ticket 402305): the history cannot be restored or exported, and `/v1beta1/news` now serves only fiscal.ai items, the
earliest at 2026-04-29T02:31Z. News had only ever been read at run time, so nothing kept the old history. The
archive keeps a copy of what the API serves now, so the next change of provider cannot remove it too (DEC-0003,
amendment of 2026-11-26).

## Where it is

- **Repository:** [`Algorythmos-AI/trading-news-archive`](https://github.com/Algorythmos-AI/trading-news-archive).
  It is **private** and must stay private: it holds headlines, which are RESTRICTED (AGENTS.md data classes) and
  Alpaca's licensed data. Its README carries the schema.
- **Never** copy its files, or any headline from them, into this repository (public), an issue, a log line, the
  dashboard or a radar edition.
- **Clone (git-ignored):** `data/archive/trading-news-archive`, the default of `scripts/news_archive.py`.
- **Code:** `src/wt/data/news_archive.py` and `scripts/news_archive.py`, tested in `tests/unit/test_news_archive.py`.

```
git clone https://github.com/Algorythmos-AI/trading-news-archive.git data/archive/trading-news-archive
```

## Layout and format

```
alpaca-news/YYYY/MM/YYYY-MM-DD.jsonl   one JSON object a line: id, created_at, updated_at, symbols, headline, source, url
alpaca-news/_done/YYYY-MM-DD.json      a finished day read in full: item count, pages, sha256 of the day's file
```

- Each item is filed under the New York date of its `created_at`, and lines are sorted by (`created_at`, `id`).
- When an item was edited, the copy with the latest `updated_at` is kept. For a causal read at time T, use items
  with `created_at` at or before T. An `updated_at` after T means the text may have changed since T.
- A rerun writes byte-identical files, so git shows a change only when the API's data changed.
- No article body is kept: the archive asks for `include_content=false`.

To read a span:

```python
from wt.data import news_archive as na
df = na.load(na.DEFAULT_ROOT, dt.date(2026, 5, 1), dt.date(2026, 5, 31))
```

## Running it

```
PYTHONPATH=src .venv/bin/python scripts/news_archive.py --catch-up 30 --publish
```

| Mode | What it does |
|---|---|
| `--catch-up N` | the last N finished New York days that have no done marker |
| `--backfill FROM..TO` | every day in the range without a marker (`--force` reads marked days again) |
| `--day D` | one day, read again even if marked |
| `--publish` | commits `alpaca-news/` in the clone, rebases on `origin/main`, pushes. It refuses any remote other than the private archive repository |

- **Output:** counts only, never a headline.
- **Rate limit:** the script joins the shared Alpaca rate limiter at 120 requests a minute. A busy day is about 150
  pages.
- **When to run:** run a long backfill outside 08:00–16:30 ET.
- **Exit code:** 1 if any day failed or the push failed. A failed day stays unmarked, and the next run reads it again.

## Today and next

- **Runs from the Mac, by hand.** The backfill from 2026-04-28 was run on 2026-11-26.
- **Next (owner):** run the same `--catch-up 30 --publish` daily after the close on the host. This needs a unit,
  which means a release and `sudo wt-install-units`. It also needs a write credential limited to this one
  repository (a fine-grained token or a deploy key) in the host's secrets. Until then, run the catch-up on the Mac.
  It fills any gap of up to 30 days.

## If something goes wrong

- **`publish FAILED ArchiveError: ... not the private archive repository`:** the clone's `origin` is wrong. Fix it
  with `git remote set-url origin https://github.com/Algorythmos-AI/trading-news-archive.git`. Never point it
  anywhere else.
- **`publish FAILED CalledProcessError`:** a rebase conflict or an auth failure. The day files are still in the
  clone. Check `git status` there, resolve the problem, and run again.
- **`FAILED` on a day:** usually a network error or a 5xx that outlasted the retries. Run the same command again.
- **The source changes** (items no longer say `fiscal.ai`, or the history shrinks): stop and compare the API against
  the archive for a few days before writing anything over them. A record (DEC) comes first.
