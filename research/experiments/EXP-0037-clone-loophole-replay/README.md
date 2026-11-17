# EXP-0037: three of the options clone's rule gaps, replayed against the frozen clone

- Decision: DEC-0054 (**PROPOSED**). Hypotheses: HYP-0062 CLONE-ROOM-OPEN-SKY, HYP-0063 CLONE-RETEST-FREE-CONFIRM,
  HYP-0064 CLONE-REJECTION-SPY-TREND (family O).
- **Design only.** Nothing has been replayed. The replay code (a switch per variant in `wt.options.dryrun`, all off
  for the control) is a later pull request, merged before the last session on the list.
- **Blind.** Only sessions after DEC-0054 is accepted are replayed, and none of them has been seen when the
  variants are frozen. What the author had seen before writing is listed in DEC-0054.
- **Changes nothing that trades.** The clone and EXP-0029 are untouched. A supported variant may only be proposed
  in a further record, for a new paper experiment.
- **Run once,** after the last session on the list, on all four configs at the same commit.

## Sessions

Written here as each session passes, before any replay. Empty until DEC-0054 is accepted.
