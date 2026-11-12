# DEC-0050: The owner's board reads SIP; EXP-0031 ends without a verdict and EXP-0033 asks its questions on SIP

- **Status: ACCEPTED on 2026-11-12.** approved_by: owner. On 2026-11-12, in chat, the owner decided that SIP becomes
  his primary live market-data feed straight away:
  - the board, the price ladders, the live indicators, the candles, the volume and the signal calculations read SIP;
  - IEX keeps running beside it for comparison only;
  - EXP-0031 is closed formally and a new SIP-based experiment is registered;
  - IEX and SIP observations are never mixed in one experiment;
  - options data comes from OPRA;
  - there is a way back if SIP fails;
  - the trading rules, stops, targets and levels do not change.

  This withdraws, for the board, the plan that the switch would wait for the feed comparison's five-session report.
  The merge of the pull request that carries this line accepts it.
- **Written before any affected P&L is viewed.** No labeller exists and no label has been written on any feed. No
  result by board state, by caution or by window has been worked out or viewed by anyone. The author read no journal,
  no owner trade and no clone result while writing this record. The only comparison numbers seen are session 1 of
  the feed comparison, as DEC-0049 gives them: 2026-11-11, 97.541% identical state words; 5 enter-zone events on IEX
  and 3 on SIP, 3 matched. These are counts of state words, not outcomes.
- **Triggers** DEC-0049 point 2 (the board's feed change ends EXP-0031) and point 7 (the DEC-0044 shadow count
  restarts on the new feed).
- **Registers** EXP-0033 with HYP-0056, HYP-0057 and HYP-0058: EXP-0031's three questions on SIP bars, as DEC-0049
  point 2 requires ("its own decision, hypotheses, experiment and trial rows").
- **Unchanged:** the owner's nine trade rules, the card plan's numbers (DEC-0035), the desk (DEC-0042, DEC-0043), the
  shadow evaluator's rules (DEC-0044), DEC-0045 and DEC-0049 as written, the options clone (EXP-0029, DEC-0030 to
  DEC-0040), the research arms (DEC-0041, EXP-0030), paper B (DEC-0037) and the forward test (DEC-0009).
- **Depends on:** DEC-0005, DEC-0035, DEC-0042, DEC-0044, DEC-0045, DEC-0049.

## Decision

1. **The board reads SIP.**
   - `ALPACA_FEED=sip` is set on the production deployment (`dashboard/src/lib/alpaca-feed.ts`). That one setting
     moves the live prices (`/api/quote`), the session bars (`/api/bars`) and the server evaluator (`/api/cron/desk`)
     to SIP.
   - Setting it is the owner's own step, done after the US close and followed by a redeploy
     (`docs/runbooks/board-feed.md`).
   - No engine file changes, so `ENGINE_VERSION` is the same before and after.
   - **The cutover session** is the first New York regular session in which every board-feed stamp (point 4) reads
     `sip`. It sets where the DEC-0044 shadow count restarts (point 7). The stamp therefore reaches production before
     or with the switch. A cutover note (a dated note here and a dated line in EXP-0033's `README.md`) records it.
     EXP-0031's `README.md` gets the date of the first session with any `sip` stamp, or the owner's dated switch if no
     stamp was running (DEC-0049 point 2's trigger).
2. **EXP-0031 ends without a verdict.**
   - This follows DEC-0049 point 2. A production switch to `sip` for any part of a session ends its window, and all
     three trials (HYP-0048, HYP-0049, HYP-0050) close inconclusive.
   - The switch comes before the release that first writes labels, so EXP-0031 closes with no session.
   - Its three trials stay counted (family M). Its records and `config.yaml` are kept as written, and nothing in them
     is deleted.
   - If the switch never reaches production, EXP-0031 stays open, and this record's points 1, 2 and 3 do not take
     effect.
3. **EXP-0033 asks the same three questions on SIP.**
   - HYP-0056 OWN-ONPLAN-SIP, HYP-0057 OWN-CAUTION-SIP and HYP-0058 OWN-EARLY-SIP each carry over EXP-0031's frozen
     definitions unchanged except as listed next: groups, label order, engine files and frozen numbers, measure,
     fees, gate, caps, generator, percentiles, site rules and the fill-time check gate.
   - These change:
     - **the feed:** labels from settled 2-minute SIP bars, asked for by name and never through `ALPACA_FEED`; a test
       proves a run with `ALPACA_FEED=iex` still asks for SIP;
     - **the start:** the first session after the release that first writes EXP-0033's labels; that release waits for
       the cutover note;
     - **the early ends:** every one closes the trials with no verdict (point 4);
     - **the feed rule:** point 4;
     - **the seed:** 20261112;
     - **the close date:** 2027-11-12;
     - **the labeller's rules,** settled at registration where EXP-0031's text left a gap (`labeller_rules` in the
       config):
       - one row per buy fill, lots still held included, storing the cautions at t0;
       - extra evaluations at 09:35, 11:30, 13:00 and 15:10;
       - alternatives masked like side states;
       - each position labelled against the edition copy the store received last by t0 (by receipt time, not
         `as_of`);
       - the calendar frozen by hash with the engine copy; a change to either for a past session ends the window;
       - `no_record` for a half-day mismatch;
       - bars fetched after the close and again at later closes, and a fetch still failing 5 sessions later ends
         the window with no verdict (an empty slot inside a full answer is final);
       - the verdict read on the registered fees, with any amended fees reported beside it;
       - DEC-0045's five-file version.
   - **No mixing.** No IEX bar is read for an EXP-0033 label, and no SIP bar for an EXP-0031 label. No position is
     labelled on both feeds. No label or board state worked out on IEX is shown per position or grouped (DEC-0049
     point 3).
   - **The fill-time check** (DEC-0049 point 4) is not run again for EXP-0033. Its one result gates the release that
     first writes EXP-0033's labels exactly as it gates EXP-0031's.
4. **The board-feed stamp, and the way back.** EXP-0033's `config.yaml` (`board_feed`) holds the frozen rule. In
   short:
   - **The stamp.** From the release that adds it onward, whatever the window's state, the production desk cron
     writes one stamp a minute over each session's regular hours. Each stamp holds the board's resolved stock feed,
     whether one SPY read on it answered, the time and the deployment. The cron writes it before, and independently
     of, the DEC-0044 eval switch and every early return of the evaluator. Preview and staging deployments write none.
   - **Every regular session counts**, full or half, whatever the owner's positions.
   - **A setting change ends the window.** Any stamp after the start that reads `iex` or refused ends EXP-0033's
     window at once. All three trials then close inconclusive with no verdict, whatever the counts. The owner can time
     a rollback, so it must not produce a verdict (DEC-0049 point 2's reason).
   - **Position by position.** A position is covered by a `sip` stamp in the 2 minutes before t0, or by two
     consecutive `sip` stamps either side of t0. Otherwise it is `no_record` (`feed_unknown`): this happens only before
     the session's first stamp or after its last. It is also `no_record` (`board_off`) when
     t0 falls within 2 minutes after a 10-minute run in which SIP did not answer. Both are counted. Deleting or withholding
     stamps after a trade cannot remove it. The next stamp still brackets it, and with no further stamp there is no
     manifest, which ends the window. An outage does not end the window.
   - **The stamps are chained.** Each stamp carries the hash of the one before, and a manifest closes each session. A
     broken chain or a missing manifest ends the window with no verdict. The owner holds every key, so this catches
     deletions and edits inside the chain, not a deliberate forgery, and an edit to the store is a breach of this record.
   - **A hidden change ends the window.** Two stamps more than 10 minutes apart with a different deployment on each
     side end the window with no verdict, because a switch could hide in the gap. No production promote is made during
     a session.
   - **Every early end has no verdict.** The four early ends carried over from EXP-0031 (an amendment to DEC-0035, a
     change to a rule limit, a change to the importer's matching, a journal with fees included) close EXP-0033 with
     no verdict as well. Each can be timed after the site shows per-position results.
   - **The way back (rollback).** If SIP fails for more than a passing outage, the owner may set `ALPACA_FEED=iex`
     (or remove it) on production and redeploy, after the close where he can. The runbook gives the steps. Each
     switch, either way, is recorded by a dated note here. A rollback after the start ends EXP-0033's window, as
     above.
   - **No silent fallback.** When SIP answers badly, the board does what it does today: it greys and pauses with its
     age shown, retries, and shows prices as off on a refusal by the plan. It never reads IEX in SIP's place.
5. **IEX is comparison only.**
   - The feed comparison (`docs/runbooks/feed-agreement.md`) keeps running with SIP as the board's feed and IEX as the
     comparison. Its reports stay data-quality measurements: counts, ages and differences, with no trade, P&L or
     setup outcome.
   - During a session the site shows only SIP's prices, bars, ladders, candles and states. IEX's numbers are
     collected but not drawn. A second picture of the market could sway trades in EXP-0033's window.
   - After a session's close the site may show that session's comparison as counts and differences: price
     differences in basis points, volume ratios, ages, and the number of slots and enter-zone events that agree. It
     never shows an IEX state or label per symbol and slot, which could be matched to a position by time (DEC-0049
     point 3). The per-slot list stays in the PRIVATE report file.
   - IEX never drives a board state, a notice, an alert, the ticket or the manage card.
   - The stored IEX comparison data and every report from before the switch are kept.
6. **Options from OPRA on the site.** The Options page's chain and contract quotes may read OPRA
   (`ALPACA_OPTION_FEED=opra`, added by its own pull request). Each answer names its feed and its delay. This changes
   no rule and no number. The options clone's quotes (DEC-0030 section 4) are not moved by this record.
7. **The DEC-0044 shadow count** restarts on SIP from the cutover session (DEC-0049 point 7). Slots from before it
   are never pooled with slots after it.
8. **Trials.** EXP-0033 adds three trials to family M, which becomes **6** (`config/trial_registry.yaml`). This
   follows DEC-0039 and DEC-0040, where the same trials asked again under a change of data were counted again
   (DEC-0005). They stay counted even if the switch never reaches production and EXP-0033 never starts: counting
   them errs on the side of more trials. The global and the C and O families are unchanged.
9. **The editions** are built by the routine that publishes them, on its own feeds (`docs/runbooks/keys-and-feeds.md`).
   EXP-0033 uses them as EXP-0031 would have. They are inputs fixed before the session, not board observations, and
   this is accepted as no mixing of the board's feed.

## Consequences

- The questions EXP-0031 asked are now answered, if at all, on SIP sessions only, starting no earlier than the
  cutover session. Nothing is lost: no EXP-0031 session was ever counted.
- On session 1 of the comparison, SIP showed fewer enter-zone events than IEX (3 against 5). The owner will see what
  the board shows on SIP. This is a change in what he sees, which is why the experiment restarts and does not
  continue.
- A rollback after the start ends EXP-0033 with no verdict. That is the price of keeping the feeds apart.
- A known asymmetry: the owner, who sees per-position results, can end the window before a falsification he sees
  coming, and no verdict is then read. The trials stay counted, which bounds the cost. He cannot turn an end into a
  pass.
- The owner's labeller (not built yet) reads its feed from the experiment, iex for EXP-0031 and sip for EXP-0033, and
  never from `ALPACA_FEED`.

## Note on the server comparison (added 2026-11-12; nothing above is changed)

From the release that adds it, the IEX/SIP comparison of point 5 runs on the server: a paired sampler once a minute
in the session and one report a day after the close (`docs/runbooks/feed-agreement.md`, "Server comparison"). It is a
data-quality measurement only: counts, ages and differences, with no trade, no P&L and no setup outcome. The per-slot
state list stays in the PRIVATE report file and is never shown on the site. Nothing in it is a trial (DEC-0005): it
adds none to any family, and no reading of it starts or ends EXP-0033.
