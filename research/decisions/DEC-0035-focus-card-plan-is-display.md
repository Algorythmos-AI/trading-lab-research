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
4. **Only presentation is exempt.** Wording, layout, the glossary and how levels are named can change under this
   record. Changing a number the card plan uses (`ENTRY_ATR`, `STOP_ATR`, `MIN_ROOM_MULTIPLE`, the trigger, or which
   level is the target) changes what the owner is told to do, so it needs a dated amendment to this record
   **before** the change is merged.
   - The amendment gives the old and new values and the reason.
   - It must say that no result of the owner's trades with the card plan was viewed to choose them.

## Note on DEC-0052 (added 2026-11-17)

DEC-0052, proposed on 2026-11-17, amends point 4 once it is accepted: the card's trigger for a break and retest
becomes the options clone's retest (a touch within 1.0 two-minute ATR, then a 2-minute close beyond the touch bar's
close), replacing a touch within 0.1 daily ATR with ENTER while the price is beyond the level. The reason is
consistency with HYP-0029's registered rule. Point 4's statement that no result of the owner's trades with the card
plan was viewed to choose it cannot be made, and is not made: the owner approved that exception in chat on
2026-11-17 (approved_by: owner). ENTRY_ATR, STOP_ATR (0.1), MIN_ROOM_MULTIPLE and the target are unchanged. The text
above is otherwise unchanged.

Viewed before this note: one owner trade entered on the board's old retest and its result, the clone's decision lines for that session, and the clone's cumulative HYP-0029 figures (DEC-0052, "What has already been seen").

## Note on DEC-0053 (added 2026-11-17)

DEC-0053, proposed on 2026-11-17, amends point 4 once it is accepted: after a side's counted break fails (a 2-minute
close back through the level), that side reads plan_off and never enter_zone for a break and retest until the end of
its entry window: until 13:00 for a failing bar ending at or before 13:00 on a full day, otherwise until the flat
time, and until the flat time on a half day. This replaces DEC-0052's trigger, under which the side was free to arm on
any new break. The reason is that a failed break is a warning about that side. Point 4's statement that no result of
the owner's trades with the card plan was viewed to choose it cannot be made, and is not made: the owner approved that
exception in chat on 2026-11-17 (approved_by: owner). ENTRY_ATR, STOP_ATR (0.1), MIN_ROOM_MULTIPLE and the target are
unchanged. The text above is otherwise unchanged.

Viewed before this note: the owner trade DEC-0052 names, entered on a side the board had re-armed after a failed break
at the same level, and its result; that session's 2-minute bars and the board's recorded states; that session read by
DEC-0052's rule as written; everything DEC-0052 lists as seen (DEC-0053, "What has already been seen").
