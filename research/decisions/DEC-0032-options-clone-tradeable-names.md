# DEC-0032: The options clone always has names it can trade

- **Status: ACCEPTED on 2026-10-20.** The owner asked for it on 2026-10-20 ("the record for tradeable names"), and
  the merge of the pull request that carries this line accepts it. It is written **before the clone's first paper
  trade**: no paper result of HYP-0029 or HYP-0030 exists when it is merged.
- **Amends** DEC-0030 and `config/options_clone.yaml` in one rule only: how the day's names are chosen. The setups,
  gates, contract rules, exits, limits and the verdict are unchanged.

## Why

The clone takes the after-close edition's four focus names, then drops any without a contract expiring that day.
Single stocks list same-day contracts only on some weekdays; SPY and QQQ list one every session. On Tuesday 20 October
the focus was AMZN, TSLA, META and SPY, and only SPY could be traded. On a day when none of the four has a same-day
expiry, the clone would trade nothing at all, while still reporting the focus as its source.

## Decision

1. The focus names are still taken first, in rank order, up to six, when the edition is for today's session.
2. Each is kept only if it can be traded today: a contract expiring today, and readable levels (as before).
3. **New:** if fewer than **two** names remain, `names.top_up` (SPY, then QQQ) are added in that order, each under the
   same test, until two can be traded or the list is used up. A name already present is not added twice.
4. The journal and the site say which happened: `focus`, `focus+top-up`, or `fallback` (no focus for today).

## Trials and the verdict

- **No trial is added:** the two setups and every number that decides an entry or exit are unchanged; only the set
  of names each day can change. The verdict (DEC-0030, section 6) reads every trade together, whatever its name.
- This rule is decided before any paper trade, so `since` for HYP-0029 and HYP-0030 stays the clone's first session.
- The historical dry run (EXP-0025) used SPY and QQQ only; it did not inform this rule beyond showing that those two
  names always have same-day contracts.
