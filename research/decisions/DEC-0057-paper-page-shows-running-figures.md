# DEC-0057: The dashboard's Paper options page shows the clone's and the arms' running results in dollars

- **Status: ACCEPTED on 2026-11-17 (New York).** approved_by: owner. The owner asked on 2026-11-17 for a page of
  their paper option trades with results and charts, and chose in chat, from three options (counts until the report;
  show everything; each day's result only), to show everything. The merge of the pull request that carries this
  line accepts it.
- **Written before any trade under EXP-0039 exists** (its first session is 2026-11-18) and before the page exists.
  What the author had seen is listed in "Disclosure".
- **Amends** DEC-0056 point 3 and DEC-0041 in one thing only: where a running figure of an open trial may be shown.
  No rule, gate, exit, limit, latch, trial count, verdict test or report is changed.
- **Depends on:** DEC-0005 (trial accounting), DEC-0030 (the clone, its SAFE document and its verdict test),
  DEC-0041 (the research arms), DEC-0056 (EXP-0039).
- **Experiment:** none. No trial is added; family O stays at 44.

## Why

The owner trades options by hand and wants to see, on one page, what the paper option trades are doing: the
clone's, their own hand-placed paper trades, and the arms' virtual ones. A page that hid dollar results for the
window now running would be empty for the weeks that matter to them.

The counts-only rule was also not applied everywhere. The clone's own document (`wt.options.clone_site`) already
sends, and the Trades page already shows, today's result in dollars and a total of every trade so far, which
includes the open window. Only the nightly review held to counts.

## Decision

1. **The Paper options page (`/paper`) shows every closed paper trade with its result in dollars and on premium,**
   and the totals, curves and breakdowns built from them, including trades of the window EXP-0039 is measuring and
   the virtual trades of the DEC-0041 arms. The three sources (clone, hand-placed, arms) are shown apart and are
   never added together. Arms figures sit in the simulated evidence class.
2. **The blind is given up for display, and only for display.** From the page's first release the owner and any
   contributor can see EXP-0039's running figures and the arms' figures before a report exists.
3. **What stays fixed, so that seeing a figure cannot move a verdict:**
   - Each trial's verdict is still computed once, by the registered script, at the registered counts (30 trades and
     20 sessions, DEC-0030 section 6), over the registered window. The page computes no verdict.
   - The nightly review (`scripts/options_clone_review.py`) and `wt.options.arms_verdict` keep printing and storing
     counts only until each report, as DEC-0056 and DEC-0041 wrote them.
   - **No rule of the clone may be chosen from a figure of an open trial.** A rule change still needs its own
     record, written before the change, and that record must say that these figures were visible. A number changed
     after a result is seen means a new experiment and new trials, as EXP-0039 says.
   - Stopping a trial early because of what the page shows is a rule change under the line above.
4. **Published data class.** The page's document carries SAFE fields only (ids, dates, times, contract symbols,
   prices of the trades, results, counts, hypothesis ids). No setup name, no account number, no balance. It is
   sent with the host's key and is read behind the owner's login.
5. **The hand-placed paper trades are no trial.** They are the owner's own practice record, read only, and count
   toward nothing.

## Disclosure

- The author read, in planning this page: the clone's and the dashboard's code on `origin/integration`, the
  synthetic test fixtures, the field names of the host's records, and this repository's decision and experiment
  records by title and rule. **No journal, plan, decision line or review file of the host was read, and no figure
  of the clone or of an arm was seen in this work.**
- One figure of another repository was seen: the public card ledger's summary of modelled option results for the
  focus cards (a count and a dollar total). It is not a clone trial and is not shown on this page.
- Memory notes of earlier sessions of the same author say that EXP-0029's running figures were seen on 2026-11-16
  (DEC-0056 discloses this). EXP-0029 closed on 2026-11-17 with no verdict.
- The owner chose "show everything" knowing that it ends the blind on EXP-0039 as displayed, from the three options
  above, before any trade under EXP-0039 existed.

## Not changed

- The clone (`wt.live.runner_o`), its config, risk limits and order path.
- The clone's own document and the Trades page's clone panel.
- The owner's Options desk, Robot B and every other desk.
