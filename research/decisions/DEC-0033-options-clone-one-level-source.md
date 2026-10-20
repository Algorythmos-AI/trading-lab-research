# DEC-0033: One source for the levels: the options clone marks the edition's levels

- **Status: ACCEPTED on 2026-10-20.** The owner asked for it on 2026-10-20 ("one source for levels and pre-market
  prices"), and the merge of the pull request that carries this line accepts it. It is written **before the
  clone's first paper trade**: no paper result of HYP-0029 or HYP-0030 exists when it is merged.
- **Amends** DEC-0030 in one point only: where the clone's day, week and month levels come from. Setups, gates,
  exits, limits and the verdict are unchanged.

## Why

The options edition (built after the close from IBKR daily bars, official closes) puts levels on the Options page
and the focus cards. The clone computed its own from the consolidated tape. Same code (`wt.options.levels`), two
feeds: the owner could read one break level on a card while the clone traded another. On 20 October the two agreed
within $0.02 for every focus name (audit of that day), and the pipeline check (`pipeline-check`, 08:55 and 18:30)
now verifies the edition against the tape every session.

## Decision

1. When the latest options edition is for today's session, the clone takes each name's levels and zones from it:
   what the owner sees is what the clone trades.
2. Otherwise (no edition, an edition for another session, or a name the edition does not carry), it computes them
   from the tape as before.
3. Whenever it uses the edition, it still computes the tape's levels and journals every marked level that differs
   by more than $0.05 (`names` event, `level_diffs`), with the source per name (`level_source`).

## Trials and the verdict

No trial is added: the level engine and every number that decides an entry or exit are unchanged, and the two
feeds' levels were verified to agree within cents. `since` for HYP-0029 and HYP-0030 stays the first session.

## Pre-market prices (no record needed)

The Radar page now shows the options desk's 08:50 focus refresh as the pre-market price when it is newer than the
radar's own (taken around 06:50), and says so. That changes a display, not a rule.
