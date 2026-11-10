# DEC-0045: Automatic attribution of the owner's trades to the board; three comparisons registered before any exists

- **Status: ACCEPTED on 2026-11-11.** approved_by: owner. The owner approved the plan on 2026-11-11 to label each of
  his own option trades with what the Options desk's board showed when he opened it, and to compare his results by
  those labels under three tests fixed here. The merge of the pull request that carries this line accepts it.
- **Written before any affected P&L is viewed.** No label exists yet, in code or anywhere else, so no result by
  board state, by caution or by the windows below has been worked out or viewed by anyone. The author did not read
  the owner's journal, the clone's results for EXP-0029 or EXP-0030, or any replay while writing this record. What
  the author did see is listed below.
- **Amends DEC-0035 section 1 for EXP-0031 only:** its replay and verdict read `dashboard/src/lib/focus-plan.ts`
  through the desk's engine, as DEC-0035 section 3 allows for an evaluation registered here. The card plan's numbers
  and the engine's are frozen at the values in section 3 below, not taken from the display. Nothing else is amended.
  The owner's nine trade rules, the desk (DEC-0042, DEC-0043, DEC-0044), the options clone (EXP-0029, frozen by
  DEC-0040) and the research arms (DEC-0041, EXP-0030) stand as written.
- **Fulfils** DEC-0042 section 4 and DEC-0043 section 4, which left these comparisons to their own hypothesis and
  experiment, and DEC-0035 section 3, which requires any evaluation of trades against the card plan to be registered
  before a result is viewed.
- **Depends on:** DEC-0005 (every configuration tried counts as a trial), DEC-0030, DEC-0035, DEC-0042, DEC-0043.
- **Experiment:** EXP-0031. **Hypotheses:** HYP-0048, HYP-0049, HYP-0050.

## Why

The owner trades by hand with the desk beside him. Whether his trades do better when they follow the board is the
question that matters for his next session, and it can be answered only from his own trades. Asked after the
results are in view, any split would find something. So the labels, the unit, the groups and the test are fixed here
first, and only the verdict script ever works out a group result.

## What has already been seen

This is honest about what is not new:

- **The owner's reconstructed record:** about 1,245 round trips, 56% wins, a dollar-weighted profit factor of 0.90,
  noted in DEC-0030. It was seen in full before this record. None of it enters the comparisons below.
- **The Trades page already shows dollars by the hour a trade was opened** (`hourKey` in
  `dashboard/src/lib/journal.ts`), including the 9:30 to 10:00 band and the 10 to 11 band. That table has been on the
  site and seen. HYP-0050's windows overlap it, and its direction was chosen knowing the record's open was its
  weakest hour (DEC-0030).
- **One trade, shown by the owner in session on 2026-11-11** to give his fees: the two fill confirmations of a call
  bought and sold on 2026-11-10, with its prices and result. It is before the window, carries no label, and enters
  nothing below.
- **No P&L by board state, by caution at entry or by the board's windows has been viewed by anyone,** because no
  such label exists yet.

## Decision

1. **Positions, not pieces.** The journal (`dashboard/src/lib/journal.schema.json`) holds matched pieces, first in,
   first out, not trades. A **position** is the long call or put pieces of one contract (symbol, kind, strike,
   expiry) opened on one New York day. Stock and short pieces are left out.
   - Pieces of one contract and day, sorted by `opened_at`, join the current group while their `opened_at` is
     strictly before the group's latest `closed_at` so far (an expired piece's `closed_at` as the journal gives it).
     A piece opened at or after it starts a new position, so a re-entry after a full exit is its own position.
   - A position counts only once no lot of that contract opened that New York day remains in the journal's `open`.
     One still open when the verdict is read is left out and counted.
   - A position with cost 0, or with a piece the journal lists in `gaps`, is left out and counted.
2. **The unit, net of fees.**
   - cost = the sum of entry × multiplier × qty over the position's pieces. Premium only: fees are not added to it.
   - gross pnl = the sum of the pieces' `pnl`, as the journal reports it (before fees).
   - fees = $0.55 per contract opened and $0.56 per contract closed. A piece left to expire (`close: expired`)
     pays no closing fee. These are the owner's own Webull figures, given on 2026-11-11 (commission $0.50 plus
     regulatory, OCC and SEC fees, about $1.11 a round trip). They are an estimate and can drift by a cent.
   - The fee subtraction assumes the journal's `fees_included` is false or null. A journal with it true ends the
     window, as a change to the importer (point 5).
   - net pnl = gross pnl minus fees.
   - **R25** = net pnl / (0.25 × cost): rule 5's cap, so −1 is the −25% stop (a little below it, by the fees).
     **R50** = net pnl / $50: rule 4's risk. **R25 is the primary measure for every verdict**; R50 is reported beside
     it, and both again before fees, labelled "before fees".
   - A change to the fee figures is a dated amendment to this record. It does not restart the window, because both
     the net and the gross figures can be worked out again from the journal.
3. **Labels by end-of-day replay.** After each session, the stored edition for that session and that session's
   settled 2-minute IEX bars are run through a frozen copy of the desk's engine. The live server log of DEC-0044 is
   **not** the source of labels.
   - **The engine.** `ENGINE_VERSION` is a content hash of `trade-state.ts`, `trade-now.ts`, `entry-checks.ts`,
     `focus-plan.ts` and `options.ts` (in `dashboard/src/lib/`) in the release that first writes labels. The replay
     runs a frozen copy of those files, so later changes to the desk, a DEC-0041 removal among them, do not reach
     the labels. Labels are written once per session and never worked out again.
   - **Frozen numbers** (the values in that code today): `ENTRY_ATR` 0.01, `STOP_ATR` 0.1, `MIN_ROOM_MULTIPLE` 2,
     `RETEST_ATR` 0.1, `MAX_BARS_TO_RETEST` 6, `ALT_LIVE_BARS` 3, `ALT_MAX_ATR` 1, `FAIL_WITHIN_BARS` 3,
     `SWEEP_MIN_ATR` 0.25, `FIRST_ENTRY_MIN` 09:35, lunch 11:30 to 13:00, `FLAT_MIN` 15:10, `CLOSE_GRACE_MS` 5 s,
     `IV_CAP_INDEX` 0.35, `IV_CAP_SINGLE` 0.70, late from 11:00 to 14:30, `MAX_TRADES_PER_DAY` 5.
   - **Evaluation.** The replay evaluates `nameState` once per 2-minute bar, at now = the bar's end +
     `CLOSE_GRACE_MS`. Its inputs are built only from bars that ended at or before now:
     - quote = {day: the session, price: the last close, open: the first bar's open, high and low: the highest high
       and lowest low since the open, prev_close: null, at: now};
     - the leader quote is built the same way from SMH's bars, with vwap the volume-weighted mean of the bars'
       own VWAPs; stored bars without volume leave the leader check unknown;
     - the 2-minute bars (`Bars2m`) come from the settled bars alone; receivedAt = now;
     - wonToday comes from the journal pieces closed before now that New York day, and dayLimitUsed from the
       journal pieces closed (for the loss) or opened (for the cap) before now that day.
   - **A side's state** at an instant is `nameState(...)[side].state` while the row's state is neither `no_trade`
     nor `paused`, and `no_trade` otherwise. It holds from now (the bar's end + 5 s) until the next evaluation.
     Intervals are half-open, [from, until).
   - t0 is the position's first `opened_at`. The position is read on its own side (a call on the call side, a put on
     the put side).
   - **The label is the first that applies, in this order:**
     - **no_record:** the session's stored edition is missing; or the symbol's (or, for the leader check, SMH's)
       settled bars from 09:30 to the bar holding t0 are not complete (`since` after the open, or `gaps` above 0);
       or the position's side at t0 carries `gap` or `brokeEarlier`;
     - **not_focus:** the symbol was not a focus name in that session's edition;
     - **in_zone:** t0 lies in an enter_zone interval extended by 60 s at its end, [from, until + 60 s);
     - **early:** t0 lies in a get_ready interval. (The word is the label's, not the desk's "Early: before 10:00"
       caution.)
     - **alt:** some side of that name at t0 has `alt` non-null with `alt.side` equal to the position's kind, live as
       `altAt` with its live check;
     - **off_plan:** none of the above.
   - **On-plan** means in_zone or early.
   - **Cautions at t0** are `entryChecks(input, kind)` with now = t0 and the inputs built as above. All the checks it
     returns count, not only the two the desk shows.
4. **Three comparisons, one trial each,** frozen in their hypothesis records. Each difference is a minus b:
   - **HYP-0048 (OWN-ONPLAN):** on-plan positions (a) against off_plan positions (b).
   - **HYP-0049 (OWN-CAUTION):** among on-plan positions, those with no DEC-0042 caution and no unknown check at t0
     (a) against those with at least one caution (b). The desk-only early caution of DEC-0043 is left out of this
     test. A position with no caution but an unknown check is in neither group and is counted.
   - **HYP-0050 (OWN-EARLY):** among on-plan positions on full sessions, those opened from 10:00 to before 11:30
     New York (a) against those opened from 09:35 to before 10:00 (b): late minus early. A half day is one that
     `dashboard/src/lib/market-calendar.json` marks as one.
5. **Forward only.**
   - Each trial counts sessions from the first New York session after the release that first writes labels reaches
     production. Before that release no one runs the labeller on the owner's journal.
   - It is never backfilled from earlier sessions.
   - A session replayed under a different engine version is left out and counted.
   - Any amendment to DEC-0035, any change to the value of a rule limit in `dashboard/src/lib/trade-rules.ts` (the
     numbers of the nine rules; a rename or moved code is not a change), or any change to how the journal's
     importer matches fills ends the window with what it has. The last session counted is the last full session
     before the change reaches production.
6. **The gate,** the same for all three:
   - at least 30 positions in each group, and 20 sessions, counting the distinct New York days of t0 of the
     positions in either group;
   - the 95% range of the difference a minus b in mean R25, resampled by session (5,000 resamples, a fixed seed and
     a portable random number generator, so that the result can be reproduced), lies wholly above 0;
   - the difference a minus b is above 0 in each half of the positions taken in order of t0.

   The resampling, the generator, the percentiles and the halves are spelled out in EXP-0031's `config.yaml`. Each
   trial is read on its own at a one-sided 2.5% level, with no correction across the three. The report gives the
   sign of the point estimate beside the verdict, so a falsified trial says whether the difference was small or
   reversed.
7. **When it is read.** A group's members are its first 150 positions by t0; later ones are not taken. The verdict
   is worked out once, by a script, at the first of: both groups at 150, the window ending (point 5), or the close
   date **2027-11-11**. With fewer than 30 positions in a group or fewer than 20 sessions at that point, the trial
   closes **inconclusive**, neither passed nor failed. Otherwise it passes the gate or is falsified. Only the
   verdict script computes group statistics; the site shows its report after the verdict.
8. **What the site may show before a verdict:** each position's label and R, the count of positions per label, the
   owner's overall mean R (only once there are 20 positions over 10 sessions), a rules-kept score, and progress
   toward the gate ("off-plan 12 of 30"). It may also show, over all positions together and never by label, how
   the exits kept the rules: the count of losers closed past the −25% stop, the count of losers held past the chart
   stop, the count of winners closed before target 1, and the dollars lost beyond the −25% stop (rule 5 applied
   to each loser, as the Trades page already replays the day stop).

   It may **not** show the mean R, dollars, win rate or profit factor by label, by caution or by time window, or any
   what-if P&L of an exit not taken beyond the rule 5 figure above: in particular no dollar figure for what a
   winner would have made if held. Per-trade labels and R let anyone add them up by hand, and next to the counts
   per label, the shown figures, including the overall mean, let a group's result be guessed. Only the aggregate is
   sealed, and this record says so rather than pretending otherwise.
9. **Trials.** Three new trials in a new family **M**, the owner's own trades, counted apart from the global, crypto
   and options families: total **3** (`config/trial_registry.yaml`).
10. **A pass changes nothing on the desk by itself.** A rule, a gate or a change to the board built on a result needs
    its own record.

## Consequences

- At about five trades a day, at most, the gate is months away; groups that stay small close inconclusive.
- The replay needs the session's edition and bars to be kept. A session where either is missing labels its positions
  no_record, and they are counted, not guessed.
- The labels follow the frozen engine, not the desk the owner sees later. If the desk changes, the labels still say
  what the board of this record would have shown.
- The fill time in the journal is the broker's. If it proves to be other than the fill (an M0 question), the labels
  are wrong by that much, and the record is revisited before the first verdict.
