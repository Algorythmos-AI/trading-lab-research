# DEC-0049: The owner's trade labels name their feed; a change of the board's feed ends EXP-0031; alerts narrowed

- **Status: ACCEPTED on 2026-11-12.** approved_by: owner. The owner approved the plan on 2026-11-12 to fix, before
  any label exists, which feed EXP-0031's labels are read from, what a change of the board's feed does to it, how the
  journal's fill time is checked, and what a phone alert may carry. The merge of the pull request that carries this
  line accepts it.
- **Written before any affected P&L is viewed.** No labeller exists, no label has been written and no alert has been
  sent. No result by board state, by caution or by window has been worked out or viewed by anyone. What the author
  did see is listed below.
- **Amends DEC-0045** point 3 (the labels' feed), point 5 (one more early end; the fill-time check gates when the
  window can start), point 7 (what the report holds; a feed-change end gives no verdict), point 8 (what the site may
  show) and its last consequence (the check is defined here). **Amends DEC-0044** sections 2 (shadow numbers per
  feed) and 3 (what an ntfy alert may carry). Everything else in both records stands as written. The owner's nine
  trade rules, the card plan's numbers (DEC-0035), the desk (DEC-0042, DEC-0043), the options clone (EXP-0029,
  frozen by DEC-0040) and the research arms (DEC-0041, EXP-0030) are unchanged.
- **Overrides, once,** the amendment rule at the head of EXP-0031's `config.yaml` (see "EXP-0031's amendment rule").
- **Fulfils** DEC-0045's last consequence, which asked for the journal's fill time to be checked before the first
  verdict.
- **Depends on:** DEC-0005, DEC-0035, DEC-0042, DEC-0044, DEC-0045.
- **Experiment:** EXP-0031 (amended in place). **Hypotheses:** HYP-0048, HYP-0049, HYP-0050 (their `since` lines
  only).

## Why

The owner has bought Alpaca's paid data plan: the consolidated tape (SIP) for stocks and OPRA for options. The
Options desk's board still reads IEX. The two feeds are being compared (`docs/runbooks/feed-agreement.md`), and the
owner will decide the board's feed with his own dated record. That choice is his and is not made here.

Four gaps would open if the board's feed changed before this record:

- DEC-0045 says the labels use "settled 2-minute IEX bars", but the site's shared bars fetch follows the
  `ALPACA_FEED` setting (`dashboard/src/lib/alpaca-feed.ts`: one place for the live prices, the session bars and the
  server's shadow check). DEC-0045's engine pin covers five files and not the bars source. A labeller built the
  obvious way would start labelling on SIP, without a word, on the day the board switched.
- No record says what a change of the board's feed does to EXP-0031.
- DEC-0045's last consequence asks for the journal's fill time to be checked, and no check is defined.
- DEC-0044 section 3 lets an ntfy alert carry the symbol and the share of the day's loss limit in %. The lab's ntfy
  topic is public, and the rule merged in #386 holds every dashboard page to fixed words, numbers and times, with no
  name the desk trades (`dashboard/src/lib/ntfy.ts`, `dashboard/test/ntfy-notices.test.ts`). The day limit ($100,
  `DAY_LOSS_LIMIT` in `dashboard/src/lib/trade-rules.ts`) is public, so a share of it is a dollar figure. DEC-0044
  section 2's shadow numbers could also pool slots from two feeds.

## What has already been seen

- **No journal, no owner trade and no result** was read by the author while writing this record. No label exists to
  be read.
- **Session 1 of the feed comparison,** as revision 3 of `docs/runbooks/feed-agreement.md` gives it (the only
  session that page reports as of 2026-11-12): 2026-11-11, 976 comparable units, 952 identical (97.541%); enter-zone
  events 5 on IEX and 3 on SIP, 3 matched, 2 on IEX only, 0 on SIP only. These are counts of state words. No price
  outcome, P&L or trade is in them.
- Those counts show that on one session the board on SIP would not have shown the owner what the board on IEX
  showed him, two of the five IEX enter-zone events among them. This is why a feed change is treated below as a
  change of what the board showed, and not as a change of data source alone.

## Decision

1. **The labels name their feed.**
   - The labeller asks Alpaca for IEX bars by name. It never reads the site's `ALPACA_FEED` setting, and never relies
     on any default.
   - Each label row stores the feed asked for, DEC-0045's `ENGINE_VERSION`, and the time the bars were fetched.
   - If IEX bars cannot be had for a session, its positions are `no_record`, under DEC-0045's existing rule for
     bars that are not complete.
   - A test in the labeller's pull request proves that a run with `ALPACA_FEED=sip` still asks for IEX.
2. **A change of the board's feed ends the window, with no verdict.** One more early end is added to DEC-0045
   point 5.
   - **The trigger** is the board's stock quotes and bars, that is, the `ALPACA_FEED` value of the production
     deployment resolving to `sip` under `dashboard/src/lib/alpaca-feed.ts` (case and surrounding spaces are not part
     of the value). The option chain's feed is not part of it. A refused or mistyped value, an outage, or a preview or
     staging deployment is not a change.
   - A production switch to `sip` for any part of a session ends the window, even if it is switched back.
   - The date is written as a dated line in EXP-0031's `README.md`, by the pull request or note that records the
     owner's feed decision.
   - **All three trials then close inconclusive.** No verdict is worked out, whatever the counts. If the change comes
     before the release that first writes labels, EXP-0031 closes with no session. Either way its three trials stay
     counted.
   - **Why no verdict.** During the window the owner sees each position's label and R (DEC-0045 point 8), and the
     feed decision is his. An end he can time must not produce a verdict.
   - **Why the window ends.** The three hypotheses ask about trades opened while the board showed a state. Once the
     board reads another feed, the IEX label no longer says what he saw.
   - **Why this differs from an engine change.** DEC-0045 says the labels follow the frozen engine, not the desk he
     sees later. That holds because the engine is pinned, and a change to it is known and recorded in advance. A feed
     change was measured to alter the board's events (the session 1 counts above). That is a change in what the board
     showed, not in the rules that read it.
   - Asking the same questions on another feed needs its own decision, hypotheses, experiment and trial rows. Nothing
     is registered for that here.
3. **No second set of labels.**
   - A past session is never labelled again (DEC-0045 point 3 already says labels are written once).
   - No label on another feed is worked out for these positions except under its own registered experiment, and none
     is shown on the site.
4. **The fill-time check.** It fulfils DEC-0045's last consequence. It is a check of timestamps, not a trial, and it
   works out no result.
   - **Unit:** each distinct (contract, `opened_at`, entry price) among the journal's long single-leg option pieces,
     so one buy sold in parts counts once. Closing sides are checked the same way, each distinct (contract,
     `closed_at`, exit price) of a piece closed by an order, and reported apart. A piece left to expire has no
     closing side.
   - Open lots, and any piece without the time field, are left out and counted.
   - **Contract:** the standard OCC symbol built from the symbol, expiry, kind and strike. Adjusted (non-standard)
     contracts are not checked, and are counted.
   - **Sessions,** fixed in advance and run once: the 10 most recent full New York sessions in the journal, at the
     time of the first run, that hold at least one opening side.
   - **Eligible print:** a trade of the same contract in Alpaca's historical option trades, whose condition code is
     not one of the codes Alpaca lists as a cancel, a late or out-of-sequence report, a multi-leg trade or a
     stock-option combination: A to G, f to m, and n to s. Alpaca has no historical option quotes, so the check uses
     trades only; their times are given to the nanosecond.
   - **Matched:** an eligible print within 10 s either side of the journal time, at a price within $0.01 of the
     unit's price.
   - **Control:** the same test with the window moved 5 minutes earlier, and again 5 minutes later. The control rate
     is the mean of the two.
   - **Reported,** per session and overall: the units checked; the share matched at the true time; the control rate;
     over the units matched at the true time, the median and the 10th to 90th percentile of the nearest matching
     print's time minus the journal time, in seconds; and the units not checked, each with its reason (open lot, no
     time, adjusted contract, no prints for the contract, Alpaca's answer incomplete). Rates are over the units
     checked.
   - **Counts and seconds only.** It works out and stores no P&L, R, win or loss. It asks only for the prints from
     5 minutes 10 s before to 5 minutes 10 s after each unit's own time, and reads no price after that. The raw
     prints fetched are not kept; only the counts and seconds are stored.
   - **Pass rule,** frozen here before any run: at least 30 opening sides checked, over at least 3 sessions, and the
     true-time match rate at least 50 percentage points above the control rate. Closing sides are reported, not
     part of the rule.
   - **Too few:** if the 10 sessions hold fewer than 30 opening sides checked or fewer than 3 sessions, the result is
     "too few". The check is then run again only on later sessions, under a dated note added to this record first.
     Any re-run for another reason needs a dated note here, written before it, saying why.
   - **It gates the window.** On a pass, the journal's time is taken as the fill time for DEC-0045, and the release
     that first writes labels may go ahead, so DEC-0045 point 5's window can start. On a fail, or with too few, that
     release waits, and this record is revisited.
   - It may run on sessions before EXP-0031's window. It is not the labeller, reads no edition or stock bar and works
     out no label, so DEC-0045 point 5's rule that no one runs the labeller before that release is kept.
   - Its output is PRIVATE (it is derived from the journal): behind the owner's login only.
5. **What the site may show** (adds to DEC-0045 point 8):
   - It may show, per position, the fill-time check's result as one of: yes, no, not checked.
   - It may not show, per position or grouped, how far the stock was from the card's entry level when he opened, on
     any feed. That is a label on another feed in continuous form (point 3).
   - It may not show whether a stop price traded before he closed. That is a what-if exit, which DEC-0045 point 8
     already bans.
6. **What an ntfy alert may carry** (narrows DEC-0044 section 3):
   - the state word and the side (call or put);
   - the bar time the state comes from and the time the alert was sent, as HH:MM New York;
   - the trades taken, as a count "of 5", and the time of that read from the journal.

   No symbol and no share of the day's loss limit go through ntfy. The symbol, the levels and the share go only over
   the end-to-end encrypted channel of DEC-0044 section 3, to the owner's own device. This puts the entry alert
   inside the rule merged in #386: a new notice kind in `NOTICE_KINDS`, driven by `ntfy-notices.test.ts` like every
   other, with its words added to that test's vocabulary and no exception. The line of
   `docs/runbooks/public-repo-guards.md` that names DEC-0044 section 3 as the one exception is corrected by the pull
   request that adds the entry alert.
7. **Shadow numbers are per feed** (adds to DEC-0044 section 2).
   - The 8 sessions and 10 enter-zone events are counted on one feed. The shadow report never pools two.
   - A change of the board's feed restarts the count on the new feed.
   - The engine-label question in DEC-0044's note of 2026-11-12 stays the owner's, and is not answered here.
8. **Alerts and EXP-0031** (adds to DEC-0045 point 7).
   - The date entry alerts are first switched on in production is written as a dated line in EXP-0031's
     `README.md`, by the pull request that switches them on.
   - The verdict is unchanged: it pools positions from before and after that date.
   - The verdict report also gives the number of positions in each group before and after that date. Nothing else
     is given by that split: no difference, mean, R or other result. Such a comparison would be new trials, and none
     is registered.
9. **No trial.** No group, measure, label rule, gate or frozen number changes, and nothing here is a configuration
   evaluated on data, so by DEC-0005 nothing is counted. Family M stays at **3** (`config/trial_registry.yaml`, no
   new row). The fill-time check is a test of the journal's timestamps against the tape. It compares no
   configuration's results and selects nothing.

## EXP-0031's amendment rule

The head of EXP-0031's `config.yaml` says a changed value is a dated amendment (the fees) or a new experiment and new
trials (everything else). Under that rule this change would call for a new experiment. DEC-0049 overrides it once,
by the owner's decision, because the window has not started and no label exists: no session has been counted and
nothing has been seen that the change could be fitted to.

What the amendment adds to EXP-0031:

- the feed rule for the labels' bars (point 1), and two stored fields on each label row: the feed asked for and the
  time the bars were fetched (`ENGINE_VERSION` was stored already);
- one early end, the feed change, which closes the three trials inconclusive with no verdict (point 2);
- the fill-time check as the gate on the release that first writes labels (point 4);
- what the site may and may not show about the check (point 5);
- one line in the report: the counts of positions per group before and after the alerts date (point 8).

The groups, the label order, the measure, the gate, the generator, the seed, the caps and the close date are as
frozen. The header of `config.yaml` now allows an amendment made by a decision record before the window starts.

## Consequences

- EXP-0031 will most likely not outlive a switch of the board to SIP. If the owner switches, it closes inconclusive,
  with or without sessions, and still counts its three trials. That cost is accepted: a label that no longer says
  what the board showed would answer a different question.
- The fill-time check cannot tell the owner's fill from another trader's print of the same contract at the same price
  in the same seconds. That is why the control windows exist: the pass rule asks for the true time to match far more
  often than five minutes away.
- A fill made of several prints, whose journal price is their average, may match no single print. This can only lower
  the true-time rate, so it can make the check fail, never pass it wrongly.
- Entry alerts may move when the owner enters. The verdict does not separate this from the board's own effect. The
  counts of point 8 show how many positions fall on each side of the date and test nothing.
- DEC-0044 section 4 already refuses an entry alert on a gap in the bars or a stale quote. Any further guard is named,
  with its file and its pass rule, in a dated note here by the pull request that adds entry alerts.
- With fewer fields, a phone alert says less. The symbol and the levels stay on the site, behind the login, and go
  on the encrypted channel once it exists.

## Note on how the fill-time check reads point 4 (added 2026-11-12; nothing above is changed)

Written before any run of the check. Where point 4 is silent, the code (`dashboard/src/lib/fill-check.ts` and
`fill-check-run.ts`) reads it as follows.

- A session is picked when it holds at least one opening side that can be checked, that is, a standard contract with
  a readable time and price; a day holding only open lots or adjusted contracts is not picked.
- "Full" means a regular session of `market-calendar.json` that has ended at the time of the first attempt, and not a
  half day.
- A unit belongs to the New York day of its own time, and closing sides are checked only on the picked sessions.
- A contract is adjusted when its multiplier is not 100, its symbol is not 1 to 6 capital letters, or it cannot be
  written in the standard OCC form.
- A side with no time is counted on the New York day of the piece's other time, only when that day is a picked
  session; a piece with neither time usable is counted once, overall, under a reason of its own.
- The excluded condition codes are exactly the letters point 4 names (A to G, f to m, n to s); any other single letter
  is eligible whatever its description, and a code that is not a single letter is not eligible and is counted.
- "No prints for the contract" means no print of any code in the span; a unit whose prints all carry excluded codes is
  checked and not matched.
- "At least 3 sessions" counts the sessions with at least one opening side checked.
- Prices are compared exactly in whole millionths of a dollar and times in whole nanoseconds, and the median and the
  10th and 90th percentiles use linear interpolation between the nearest ranks (numpy's default method).
- The session list is fixed and stored at the first attempt; an attempt that fails on transport, a rate limit or time
  stores no result and is not a run, and no outcome of it is logged or shown.
- Each span is read in pages of at most 10,000 prints and at most 5 pages; a span still paging after 50,000 prints is
  "Alpaca's answer incomplete", and that unit is not checked.

No journal, print or result was viewed for this note.
