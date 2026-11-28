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
| `--publish` | commits `alpaca-news/` in the clone, rebases on `origin/main`, pushes. It refuses any remote other than the private archive repository, and refuses to push unless GitHub, asked without credentials, says that repository is not found (private): DEC-0081, owner note 2026-11-28 |

- **Output:** counts only, never a headline.
- **Rate limit:** the script joins the shared Alpaca rate limiter at 120 requests a minute. A busy day is about 150
  pages.
- **When to run:** run a long backfill outside 08:00–16:30 ET.
- **Exit code:** 1 if any day failed or the push failed. A failed day stays unmarked, and the next run reads it again.

## Today and next

- **Runs from the Mac, by hand, until the host job is on.** The backfill from 2026-04-28 was run on 2026-11-26.
- **The host job:** `wt-news-archive` (`wt.ops.schedule`), Mon..Fri at 20:45 New York, runs
  `scripts/news_archive.py --catch-up 30 --publish`.
  - **What it fills:** the finished days with no done marker, up to 30 back, so Monday's run also fills the weekend.
  - **Its own failure domain:** its own log (`logs/news_archive_<date>.log`). A failure never stops another job.
  - **Not a trading job:** the deploy gate ignores it.
  - **Dormant until set up:** without a clone and without `NEWS_ARCHIVE_TOKEN` it prints one line and exits 0.
- **Turning it on (owner, once), in this order:**
  1. Create a fine-grained GitHub token. Give it the repository `Algorythmos-AI/trading-news-archive` only, with
     **Contents: read and write** and nothing else.
  2. **Release, then `sudo wt-install-units`.** This installs the unit and its timer, and the new `wt-set-secrets`
     and `wt-fetch-secrets`, which know the new name. The unit is new, so the unattended deploy waits for you.
  3. **Then `sudo wt-set-secrets`,** and paste the token as `NEWS_ARCHIVE_TOKEN`.
     - It writes `/etc/wt/secrets` and restarts `wt-secrets.service`.
     - That copies the value into `/run/wt-secrets/env`, which the unit reads as its `EnvironmentFile`.
  4. **First run:** with the token set and no clone, the job clones the private repository to
     `data/archive/trading-news-archive`, then fills and pushes the missing days.
     - **The token:** git sends it as a header from environment variables, never on a command line or in the
       clone's config.
     - **The remote:** `publish` still refuses any remote but the private repository.
     - **Visibility:** it pushes only while that repository is private. A log line `is public; nothing pushed` or
       `could not confirm the archive repository is private` means nothing left the host; the day files wait in the
       clone for the next run.
     - **Git identity:** the commit and the rebase carry the maintainer identity, since the host's git has none.
  5. **Check, the next morning:**
     - `logs/news_archive_<date>.log` on the host ends with `pushed` or `nothing new to push`.
     - The private repository has a new `alpaca-news:` commit.
     - **If the log says `not set up here`:** the token is not reaching the job. Run step 3 again, or check that
       `wt-fetch-secrets` was reinstalled in step 2.
- **The Mac and the host both push** to the same repository. `publish` rebases before it pushes, and a day file is
  the same on both (sorted, merged by id), so a run on either fills what the other missed.
- **Renewing the token:** run `sudo wt-set-secrets` again before it expires. A refused token makes the job fail with
  `publish FAILED CalledProcessError`; the day files stay in the clone until the next run.

## If something goes wrong

- **`publish FAILED ArchiveError: ... not the private archive repository`:** the clone's `origin` is wrong. Fix it
  with `git remote set-url origin https://github.com/Algorythmos-AI/trading-news-archive.git`. Never point it
  anywhere else.
- **`publish FAILED CalledProcessError`:** a rebase conflict or an auth failure. The day files are still in the
  clone. Check `git status` there, resolve the problem, and run again.
- **`FAILED` on a day:** usually a network error or a 5xx that outlasted the retries. Run the same command again.
- **The source changes** (items no longer say `fiscal.ai`, or the history shrinks): stop and compare the API against
  the archive for a few days before writing anything over them. A record (DEC) comes first.
