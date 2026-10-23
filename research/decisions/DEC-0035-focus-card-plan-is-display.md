# DEC-0035: The focus cards' entry, stop and targets are a display of the owner's plan, not a lab strategy

- **Status: ACCEPTED on 2026-10-23.** The owner chose this record on 2026-10-23, after an automated review of
  release #280 asked whether the focus cards added in #276 needed pre-registration. The merge of the pull request
  that carries this line accepts it.
- **Amends** nothing. No hypothesis, experiment or trial is added, and no strategy's frozen rules change.

## What #276 shows

Each focus card on the Options page now writes out a call plan and a put plan for its name
(`dashboard/src/lib/focus-plan.ts`):

- an entry `ENTRY_ATR` (0.01 ATR) past the level;
- a stop `STOP_ATR` (0.1 ATR) back;
- a first target at `MIN_ROOM_MULTIPLE` times the risk;
- the next named level after that.

It works these out from fields the options edition already publishes. The arithmetic is the same as the focus card
the owner's own thread already prints.

## Decision

1. **Display only.** The card plan helps the owner read the edition for **their own discretionary trades**. It is
   not a strategy of this lab.
   - No runner, backtest, forward test or verdict reads `focus-plan.ts` or its numbers.
   - The options clone (DEC-0030, DEC-0032, DEC-0033, DEC-0034) keeps its own frozen entry, exit and contract rules
     in `config/options_clone.yaml` and does not use these.
2. **No P&L is attributed to it.** Nothing in `research/` may report a result "of the focus-card plan" under this
   record.
3. **If the lab is ever to trade or evaluate the card plan** (paper, backtest or forward), that is a new strategy.
   It needs its own hypothesis, experiment and decision record **before** any result is viewed, as AGENTS.md rule 2
   requires. Its numbers are frozen at that point, not taken from the display.
4. Changing `ENTRY_ATR`, `STOP_ATR` or the target rule on the cards stays a display change under this record, while
   point 1 holds.
