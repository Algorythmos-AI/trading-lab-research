# How the posts were collected, and how to add more

**Collected:** 2026-11-05, in the owner's logged-in Chrome, at the owner's request. X's terms limit automated
collection; the owner decided to collect. Do not run it on a schedule or at scale.

## What was collected

Original posts by @Desi_Trade from 2025-10-30 to 2026-11-05: no replies, and no reposts of others' posts. Quote
posts are kept, with the quoted post's id and text. Images are referenced by X media id only; nothing was
downloaded.

| Window (UTC dates) | Source | Posts |
|---|---|---|
| 2025-10-31 to 2025-11-30 | search | 160 |
| 2025-12-01 to 2025-12-31 | search | 120 |
| 2026-01 to 2026-05, one search per month | search | 97, 78, 97, 112, 117 |
| 2026-06, 2026-07 | search | 119, 115 |
| 2026-08-01 to 2026-09-09 | search | 112 |
| 2026-09-07 to 2026-11-05 | profile timeline (search was rate-limited) | 216 |

Windows overlap by a day at the edges; `build` keeps one copy per post id. The result is **1,305 posts**.
Per-month counts are in [`stats.md`](stats.md).

## Steps

1. Open the search, one month at a time (wider windows truncate):
   `https://x.com/search?q=from%3ADesi_Trade%20since%3AYYYY-MM-DD%20until%3AYYYY-MM-DD%20-filter%3Areplies&f=live`.
   For the most recent weeks the profile page `https://x.com/Desi_Trade` also works.
2. Run [`collect.js`](collect.js) in the page. It scrolls until no new posts load, then shows a "Copy posts (N)"
   button. Click it to copy a JSON array.
3. Save it: `pbpaste > batch.json` (macOS; set `LC_ALL=en_US.UTF-8` so the text stays UTF-8).
4. Merge: `python scripts/external_posts.py build research/external/desi-trade batch.json`. New posts arrive with
   `kind: uncoded`.
5. Code the new posts by [`CODING.md`](CODING.md), write the codes as JSON lines keyed by `id`, and apply them:
   `python scripts/external_posts.py code research/external/desi-trade codes.jsonl`.
6. Run `make ci`. The record tests fail until every post is coded and `stats.md` is current.

If a search shows "Something went wrong", X is rate-limiting; wait 15 to 30 minutes.
