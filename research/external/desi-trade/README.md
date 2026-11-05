# @Desi_Trade: a year of an options and futures day trader's posts

**Data class: RESTRICTED (verbatim third-party).** The `posts/` files hold another person's posts word for word.
They stay in this private repository and never go to the dashboard, issues or logs; the publisher's leak check
reads them (`corpus_files` in `src/wt/ops/publish.py`). See `NOTICE.md`.

Vincent Desiano (@Desi_Trade) day-trades /NQ, /ES and index and single-name options off levels he marks before the
open, and posts his trades, plans and results. This record holds his **1,305 original posts from 2025-10-30 to
2026-11-05**, cleaned, coded and summarised, so no one has to collect or read them again.

**Read his results as claims.** He sells a levels product, a mentorship and prop-firm codes. He also posts his
losing periods (a red February, six flat weeks in late 2025, two large red days in July and August). His stated
win rate is about 50%. Yet when he names a setup, the post is nearly always a win (in `stats.md`, 37 of 38
break-and-retest posts that state an outcome are wins): he names the setup mostly when it worked. **Never read a
win rate or an edge out of this record.** It describes a method; it does not show that the method pays. The lab
tests the parts it adopts (DEC-0041).

## Start here

1. [`method.md`](method.md): how he trades, in one page, with post citations.
2. [`rules.md`](rules.md): the method as 33 numbered rules, each marked testing, have, deferred or rejected.
3. [`options-playbook.md`](options-playbook.md): his options handling set against our clone, part by part.
4. [`comparison.md`](comparison.md): every gap between him and the lab, and the action for each.
5. [`timeline.md`](timeline.md): month by month, the market, what he did and what he claimed.
6. [`glossary.md`](glossary.md): his terms and our codes. **His "PMH" is our `PMKH`; our `PMH` means previous
   month.**
7. [`stats.md`](stats.md): generated counts by month, kind, setup, vehicle, level and time.

## The data

`posts/YYYY-MM.jsonl` holds one post per line, one file per New York calendar month, sorted by time. The fields are
defined in [`schema.json`](schema.json):

- **As collected:** `id`, `url`, `ts_utc`, `text` (verbatim), `quoted_id`, `quoted_text`, `image_ids`,
  `has_video`.
- **Computed** by `scripts/external_posts.py`, never hand-edited:
  - `ts_et` (New York time) and `month`.
  - `session`: when the post was made, not when he entered.
  - `text_clean`: the text without links.
  - `symbols`: canonical tickers, so $NQ, /NQ, MNQ and NQZ5 are all `NQ`.
- **Coded** by [`CODING.md`](CODING.md):
  - `kind`, and `signal`, which is true for trade, plan, level_call, lesson, recap and swing.
  - `setups`, `vehicle`, `direction` and `levels`.
  - `entry_time_et`, `outcome_claim` and the `*_claim` numbers.
  - `lesson`: one line in our words for every signal post.

**Filter on `signal == true` to drop the noise** (promotions, sport, food, travel). Nothing is deleted.

Example queries (run from this folder):

```bash
# every trap / pop-and-fade post, oldest first
jq -c 'select(.signal and (.setups|index("POP_FADE"))) | {ts_et, text_clean, lesson}' posts/*.jsonl
# his stated losses
jq -c 'select(.outcome_claim=="loss") | {ts_et, pnl_usd_claim, lesson}' posts/*.jsonl
# all levels he wrote for NQ in October 2026
jq -c '.levels[] | select(.symbol=="NQ")' posts/2026-10.jsonl
```

## Quality

Every post was coded by the rules in `CODING.md`. After the rules were tightened, every early batch was reviewed
against the final rules.

Two random samples of 130 posts each (10% of the record each, seeded draws) were coded a second time, blind.
Agreement on the second sample, after the rules were tightened:

| field | agreement |
|---|---:|
| `signal` (trading content against noise) | 96% |
| `setups` | 98% |
| `vehicle` | 98% |
| `outcome_claim` | 97% |
| `direction` | 96% |
| `kind` | 87% |

The first sample was the same except `setups` (96%) and `vehicle` (95%).

Almost every `kind` disagreement fell between neighbouring trading kinds: a plan against a level call, a trade
against a swing. Each disagreement led to a written tie-breaker in `CODING.md`, and every post on those boundaries
was then reviewed again. **Use `signal`, `setups` and the claim fields with confidence. Treat `kind` as
approximate between plan and level_call.**

Where the rules left doubt, the field is empty; nothing is guessed. The tests in
`tests/unit/test_external_posts.py` check:

- Every row against the schema.
- Ids, sort order and months.
- That the computed fields match the code.
- That every post id cited in these documents exists.
- That `stats.md` is current.

## Extending it

[`COLLECT.md`](COLLECT.md) covers collecting newer posts, merging them, coding them and passing the tests.
