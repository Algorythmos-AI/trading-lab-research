# DEC-0051: The Options desk's server adds a signal word beside each side's state, logs it sealed, and tests it once

- **Status: PROPOSED on 2026-11-13.** The owner approved the plan on 2026-11-12, in chat, to add a signal layer to
  the Options desk: one of CALL, PUT, WAIT or NO TRADE per focus name and side, worked out on the server from the
  board's own state and a fixed list of gates, logged sealed, and tested once, forward. It is accepted by the owner's
  merge of the pull request that changes this line to ACCEPTED ("Accepting this record" lists what that pull request
  changes). Acceptance registers the test and fixes the definitions below; it builds nothing, switches nothing on and
  starts no window. The gates' numbers are not frozen by this record: they are frozen once, by its Amendment 1, under
  the rule section 2 states now.
- **Written before any affected P&L is viewed.** No signal exists, in code or anywhere else: no gate has been worked
  out on any session, no signal has been logged and no outcome of any board state, gated or not, has been worked out
  or viewed by anyone. The author read records, configs and code only. The author opened no journal, owner trade,
  ledger, clone result, state log, shadow log, feed-comparison report or experiment result while writing this record.
- **Rests on DEC-0035 section 3 and amends nothing in DEC-0035.** DEC-0035 section 3 allows an evaluation of the card
  plan that is registered, with its own hypothesis, experiment and decision record, before any result is viewed,
  with its numbers frozen at that point and not taken from the display. This record is that registration for
  EXP-0034, as DEC-0047 is for EXP-0032. The card numbers the test reads are frozen in section 8. DEC-0035's numbers
  and its section 1 stay as they are, so no early end that names an amendment to DEC-0035 (EXP-0032, EXP-0033) is
  triggered.
- **Amends DEC-0028** section 1 (what the desk may say), **DEC-0042** section 1 (a signal word is shown beside the
  fixed state list), **DEC-0044** section 1 (what "suggests no order" covers) and **DEC-0049** point 6 (one more
  alert word). Each amendment is worded in full under "Amendments to earlier records", and a dated note in each of the
  four records points here. Everything else in them stands as written.
- **Registers** EXP-0034 with HYP-0059 (SIG-CONFIRMED): one new trial in family O, which becomes **36**
  (`config/trial_registry.yaml`, a `proposed` row until this record is accepted). Section 9 gives the reason for the
  family.
- **Unchanged:** the owner's nine trade rules (`dashboard/src/lib/trade-rules.ts`), the card plan's numbers
  (DEC-0035), the board's states and its engine (DEC-0042, DEC-0044 and the engine label of DEC-0044's note),
  DEC-0043, the two-stage selection and its forward test (DEC-0046, DEC-0047), DEC-0050 as written, the options clone
  (EXP-0029, DEC-0030 to DEC-0040), the research arms (DEC-0041, EXP-0030), paper B (DEC-0037) and the forward test
  (DEC-0009).
- **Depends on:** DEC-0005, DEC-0028, DEC-0035, DEC-0042, DEC-0044, DEC-0045, DEC-0046, DEC-0047, DEC-0049,
  DEC-0050.
- **Experiment:** EXP-0034. **Hypothesis:** HYP-0059.

## Why

The board says where a name stands against its card: watch, get ready, enter zone and the rest. It does not say
whether the market around that moment is one the owner would want to trade into: whether SPY and QQQ lean against
the side, whether the break came on real volume, whether the stock's quote is tight, whether a shock or a release is
under way, and whether a contract inside his own rules can be had at a fair price. Those facts are on the page in
pieces (the market bar, the flow measures, the chain). The owner asked for them to be put together, per side, as one
plain word, with the facts behind it.

A word like CALL invites trust it has not earned. So the word is built only from the board's own state and gates
whose definitions are fixed here, its numbers are frozen by a rule fixed here from how often each gate fires before
any outcome is seen, it is worked out in one place (the server) and sealed, and one registered test decides what the
word's tag may say.

## What has already been seen

- No signal, gate value or outcome. Nothing in this record was chosen from a result.
- The code the definitions describe: `dashboard/src/lib/flow.ts` (on `origin/integration` at
  `66c5efc8e09fd2289e64bd85c531aa9c6305fae8`), `dashboard/src/lib/context.ts` as pull request #422 proposes it (not
  merged; its definition is copied into EXP-0034's `config.yaml` in words and numbers, and its code pin is written
  into EXP-0034's `README.md` by a dated line once #422 is merged), `focus-plan.ts`, `trade-state.ts`,
  `desk-eval.ts`, `trade-rules.ts`, `ticket.ts`, `premium-stop.ts`, `chain.ts`, `ntfy.ts` and `owner-positions.ts`
  (its fees).
- The records listed under "Depends on", and EXP-0032's and EXP-0033's configs and READMEs.

## Decision

### 1. The signal word

For each focus name of the session's edition and each side (call, put), the server works out one signal word on each
settled 2-minute slot that it evaluates under DEC-0044 section 1. The side's state is the one DEC-0044's record holds
for it (`stateRows` in `desk-eval.ts`: the row's `no_trade` or `paused` on both sides, otherwise the side's own
state). The first that applies:

1. **NO TRADE** when:
   - the side's state is `no_trade`, `watch`, `plan_off`, `missed` or `paused`;
   - the side's state is `get_ready` with `brokeEarlier` or `gap` set;
   - the break bar exists and the volume gate fails: it cannot pass later for the same break, so the break reads NO
     TRADE from then on;
   - two or more of the four market gates (section 2: market direction, volume, stock bid–ask, shock) fail;
   - no contract passes the contract check (section 2). On the page, when every market gate passes and only the
     contract check fails, the reason reads "no contract inside your rules"; or
   - an input is not usable: the slot's DEC-0044 record has a status other than `ok`, or lists the name in
     `degraded_names`; the edition is missing or for another session; the parameter hash or the signal code's hash in
     force differs from the one Amendment 1 freezes; an answer names a feed other than SIP for the stock or OPRA for
     the option; or the slot has no usable board-feed stamp: a board-feed stamp (DEC-0050 point 4) reading `sip`,
     with SPY answering (`answered` `ok`), whose `at` lies in the two minutes up to the slot's evaluation time t0,
     both ends included (EXP-0033's covering rule, `EDGE_MS`, without bracketing). Without one the board's state
     cannot be shown to come from SIP. (A stamp reading other than `sip` is not only this: it ends the window,
     section 8.)
2. **CALL** (call side) or **PUT** (put side) when the side's own state is `enter_zone` for the card's break and
   retest, with neither `brokeEarlier` nor `gap` set, and all four market gates pass, and a contract passes.
   (`trade-state.ts` never gives `enter_zone` with either flag set; the condition is kept so that a later change to
   the engine cannot let one through.)
3. **WAIT** when the side's state is `get_ready`, or `enter_zone` with exactly one of the market direction, stock
   bid–ask and shock gates failing. The failing gate is named on the card. Before the break bar exists the volume gate
   reads "not yet" and is not counted as a fail for WAIT.

- **Alternatives and the runner plan never produce a signal.** A side's `alt` (the trap and fast-reclaim lines of
  DEC-0042 section 1) and the runner exit line are not read. A new pattern enters only through its own hypothesis,
  registered before it is shown.
- **`watch` reads NO TRADE.** The break has not happened.
- **The words never change a state.** The board's state, its line and its cautions are worked out as before; a
  signal word is shown beside them. A signal word is never a rule break, as DEC-0042 section 2 says of a caution.

**The lifecycle**, shown beside the word, reads the current slot and the session's own sealed signal records of the
same break (same name, side and `brokeAt`). Those records were sealed before the slot and hold no outcome, so reading
them leaks none. A break is "confirmed earlier" when one of those records holds CALL or PUT; a missing record counts
as not confirmed. The first that applies:

- **invalidated** (only for a break confirmed earlier): the side's state is `plan_off` or `missed`, or the word is
  NO TRADE;
- **weakening:** the break was confirmed earlier and the word is now WAIT; or the word is CALL or PUT and two slots or
  fewer remain in the retest window;
- **confirmed:** the word is CALL or PUT;
- **developing:** the word is WAIT;
- no lifecycle word otherwise.

"Two slots or fewer remain" means `MAX_BARS_TO_RETEST + 1 − k ≤ 2`, where `k` is the number of 2-minute bars from
the start of the side's break bar (`brokeAt`) to the start of the bar forming at the evaluation, as `trade-state.ts`
line 395 counts the window (`MAX_BARS_TO_RETEST` is 6). The lifecycle is display only: no test reads it.

### 2. The gates

The definitions are frozen here. The numbers marked *candidate* are not: each is frozen once, by Amendment 1 to this
record, under the rule below, before the signal log is first switched to `log`. A gate whose value cannot be worked
out ("not available", for any reason) **fails** for the word; section 8 says how such a slot is treated in the test.

1. **Market direction.** SPY and QQQ each read `up`, `down` or `range` by the definition copied into EXP-0034's
   `config.yaml` (`gates.market_direction.definition`) from `direction()` in `context.ts` as #422 proposes it. In
   short: up when the price is above session VWAP outside a dead band of the larger of the stock's spread and 3 basis
   points, AND the last five consecutive completed 10-minute closes rise, the last above the first and at least three
   of the four steps up; down mirrored; range otherwise. No direction when the price or the answer is older than
   20 s by checked age, when one of the five 10-minute blocks has fewer than 4 of its 5 bars or none in its last
   slot, and for the other reasons the config lists. These numbers are part of the definition and are frozen here,
   as `context.ts`'s own header asks ("frozen in a decision record before any signal uses them"). If the merged
   `context.ts` differs from the copy, the copy governs the signal and the difference is a defect of the code.
   - The call side fails when both read `down`; the put side fails when both read `up`. Any other pair passes.
   - When the name is SPY or QQQ, the other index alone is the context: the call side fails when it reads `down`,
     the put side when it reads `up`.
   - A reading with no direction fails the gate.
2. **Volume.** The volume of the 2-minute bar ending at the side's `brokeAt` boundary, the break bar, divided by the
   20-session median volume for its New York slot (`barSurge` in `flow.ts`), is at least **1.5** (*candidate*). Not
   available, and so failing: before 09:35; no baseline, a baseline for another session, or fewer than 10 sessions
   behind the name (`MIN_BASELINE_SESSIONS`); the last five slots of a half day (`HALF_DAY_CLOSE_SLOTS`); a slot
   median of zero; the bar missing.
3. **Stock bid–ask.** The name's own NBBO, `(ask − bid) ÷ mid × 10,000` (`spreadBps` in `flow.ts`), is at most
   **5** basis points (*candidate*). A locked, crossed or one-sided quote fails, and so does a quote older than 20 s
   by checked age.
4. **Shock.** Both of:
   - none of the last three completed 2-minute bars of the name has a range (high − low) above **3** (*candidate*)
     times the 20-session median range for its slot. The baseline does not hold ranges yet (`flow.ts`'s `NameStats`
     holds volume medians only); a range median per slot is added to it by its own pull request, built from the same
     20 sessions in the same way as `slot_median`. It is a precondition of Amendment 1 and of the window (section 8);
   - no scheduled event inside its window: no release the event calendar lists for the day (`market-calendar.json`,
     the calendar the board's event line already shows, DEC-0042's note of 2026-11-12) with its New York time from
     **30** minutes (*candidate*) before the slot's end to **30** minutes (*candidate*) after it, and no earnings for
     the name during the session. A day or a month the calendar does not cover is not available.
5. **The contract check.** It is not one of the four market gates: no contract passing makes the word NO TRADE
   whatever the gates say (section 1).
   - **The chain:** OPRA, asked for by name (section 4), for the side's kind.
   - **The expiry** (decided by the owner on 2026-11-13, asked directly): the nearest listed expiry from 1 to 5
     sessions out; the same day is excluded, so a same-day contract is never named and the delta check stays. No
     listed expiry in that range is "no contract". It lives in one place, `parameters.expiry_rule` in EXP-0034's
     `config.yaml`.
   - **The strike:** the listed strikes of that expiry in the order `strikesByDistance` gives them (nearest the
     stock's price first, the lower of two equally near first, at most 6). The first strike whose contract passes
     every check below is the one named; none passing is "no contract".
   - **Premium inside the rules:** at the ask, the ticket sizes at least one contract (`sizeTicket` in `ticket.ts`
     with `OWNER_LIMITS`, `contracts ≥ 1`). That is: 100 × ask at most `MAX_PREMIUM` ($200), and one contract's loss
     at the rule 5 stop (`stopCents`, the price less `PREMIUM_STOP`, 25%, rounded up to the tick) plus the owner's
     round-trip fees (`OWNER_FEES`, $0.55 to open and $0.56 to close a contract) at most `RISK_PER_TRADE` ($50), with
     a stop below the price.
   - **Its bid–ask:** `ask − bid` at most **20%** (*candidate*) of the distance from the mid to the premium stop,
     that distance being `PREMIUM_STOP × mid`; so at the candidate, at most 5% of the mid.
   - **A two-sided quote** (bid and ask above zero, ask not below bid) whose checked age is at most **10 s**
     (*candidate*), and whose own time (`chain.ts` `at`, the snapshot's `latestQuote.t`) is at most **60 s**
     (*candidate*) before the answer's `served_at` (else `as_of`). The checked age is the chain's: its newest quote,
     across all strikes, against when the answer was served (`contract.ts` `chainAge`). The contract's own time is
     this contract's. Both must hold: a chain whose newest quote is a second old can still carry, for this
     contract, a quote from hours earlier.
     **A quiet contract** (its quote, prices and sizes, unchanged for longer than the limit, so it keeps an older
     time) fails this check and is "no contract", even when its quote is still the market: the record cannot tell a
     quote that has not changed from one that has stopped arriving, and it takes the cautious reading. A break whose
     contract check fails is counted, not scored, in either group (section 8). That is not independent of the market
     gates: a quiet stock makes a quiet option, so this check is likely to take more of *b*'s volume-gate failures
     than its others. The sensitivity table reports it. Amendment 1 sets the limit by the freeze rule from how often
     it fails in the `dry` log.
   - **Volume today** (the snapshot's daily bar, `chain.ts` `volume`) at least **100** contracts (*candidate*).
   - **Delta present from the feed** (`chain.ts` `delta`, from the snapshot's greeks). A missing delta fails, and so
     does any delta the site works out itself.

   No contract passing is expected to be common: a tight premium cap, a fresh two-sided quote and a day's volume
   together rule out many contracts, most of all early in the session and on dearer names.

The board's existing cautions (DEC-0042 section 1, `entryChecks`) are shown beside the word as reasons against. They
are not gates and change no word.

**Amendment 1: how the numbers are frozen, stated now.** This is the pattern of DEC-0046 section 5 and its
Amendment 1 (whose heading still reads PROPOSED; it took effect on the merge of #409, as that heading says).

- **What it reads:** the `dry` log only (section 3), over at least 10 full sessions recorded after the preconditions
  of section 8 are in production: for every focus-name slot, whatever the board's state, the inputs each gate reads.
- **The rule:** each candidate number is kept unless the share of those slots on which its gate or check would fail
  is above 80% or below 5%. Then it moves to the grid value nearest the candidate whose fail share lies inside 5% to
  80% (the stricter of two equally near); if none does, the candidate is kept and Amendment 1 says so. The grids are
  in EXP-0034's `config.yaml` (`parameters.grid`). The two event-window numbers are exempt: their fail share comes
  from the release schedule, not the market, so they stay at their candidates.
- **What it may not use:** any board state, `brokeAt` or other conditioning on an entry zone; any bar after the slot;
  T1, the stop, `plan_off` or `missed`; the feed reports' enter-zone counts; any journal, the ledger or the clone.
- **What it states:** each frozen value beside its candidate and its fail share, the sessions read, the hash of the
  frozen block (the parameter hash) and of the signal code (the signal-code hash), and that no outcome was read.

### 3. Only the server works out a signal, and it seals it

- **Where and when.** Signals are worked out only on the site's server, once per settled slot, in the same run as
  the DEC-0044 evaluation and after that run has written the slot's DEC-0044 server record. The page never works one
  out.
- **Sealed.** Each slot's record is written once to `desk/signal/<New York date>/<HHMM New York>.json` in the PRIVATE
  store, create-only: a second write for the same slot is refused and nothing is ever overwritten.
- **DEC-0044 is untouched.** The signal record is written after the DEC-0044 record and is not part of it. The
  DEC-0044 record's bytes, its timing and the engine label stay as they are: the signal code is outside the import
  closure of `desk-eval.ts`, and a test proves the DEC-0044 record byte-identical with the signal switch in every
  mode over every fixture.
- **Its own switch.** `desk/signal.json`, read every run, parsed as strictly as `desk/eval.json`:
  `{ "v": 1, "signal": "off" | "dry" | "log" | "show" }`. Anything else, or nothing, is off. It is off by default and
  the owner sets it.
  - `dry` writes the gate inputs only (section 2's list, with the OPRA quotes of the strikes considered and both
    indexes' quotes, which are otherwise not saved): no word, no lifecycle, shown nowhere, outside the window. It
    exists so that Amendment 1's frequencies can be counted.
  - `log` writes the full record and shows nothing; `show` also lets the page show what the log holds.
  - With the DEC-0044 switch off there is no DEC-0044 record and so no signal record: a gap.
- **Its own time budget.** The signal step has its own time limit inside the run, after the DEC-0044 record is
  written. A step that cannot finish inside it, or inside the slot, writes nothing for that slot: a gap. It never
  delays or retries the DEC-0044 write.
- **What each record stores.** Every input that cannot be rebuilt from the settled bars: per side, the word, the
  lifecycle, `brokeAt`, each gate's pass or fail with its value and reason; the card's level, entry, stop and T1 for
  the side; the indexes' readings with the values that produced them (price, VWAP, the five closes, spread, age); the
  stock's bid, ask and age; the named contract (its OCC symbol), its bid, ask, checked age, own quote time, delta and
  day volume, and for every strike considered its quote time and the check it failed; the chain answer's
  `served_at`; the baseline's `for_session` and build time; the parameter hash; the signal-code hash; the feed names
  each answer gave; the engine label; the evaluation time; the key and SHA-256 of the slot's DEC-0044 record; and
  the key, `feed` and `answered` of the board-feed stamp the slot was judged by. The contract check is run and
  stored whatever the market gates read: group *b* needs it. For every side whose word was CALL or PUT earlier in
  the session, each later record also stores that contract's bid, ask and age (`follow`), up to the session's close.
- **The page shows only the log.** With the switch at `show`, the page shows a side's word only as the sealed log
  holds it, stamped with the bar time it comes from and its age. A slot with no record reads "not logged", never the
  previous word. A missed tick leaves a gap; nothing is filled in afterwards.
- **The strings test.** DEC-0042 section 3's test of the desk's strings is extended to every signal word, lifecycle
  word and gate reason the page can draw.

### 4. Feeds

- The signal asks for SIP stock bars and quotes and OPRA option quotes by name. Nothing in the signal reads
  `ALPACA_FEED` or `ALPACA_OPTION_FEED`, and a test proves a run with `ALPACA_FEED=iex` still asks for SIP.
- IEX never enters a signal, a gate or a lifecycle word (DEC-0050 point 5).
- An answer that names another feed, or none, makes the input not usable (section 1).

### 5. The blinds are kept

1. **EXP-0032** (DEC-0047 section 8). Until EXP-0032 is read, signals, lifecycle words, gate values, outcomes and any
   replay cover the edition's focus names only. Nothing is worked out, logged or shown for a name that is not a
   focus name. SPY and QQQ as context show direction, never an outcome.
2. **EXP-0033** (DEC-0045 point 8, as amended by DEC-0049 point 5, and EXP-0033's `site_before_verdict`). Until
   EXP-0033 is read, the site shows no result grouped by signal word, by gate, by caution or by time window, and
   nothing joins the owner's journal to the signals: no trade is shown with the signal at its time, and no count or
   result of trades by signal is worked out.
   - **The date signals first appear on the page** (the first session with the switch at `show` in production) is
     written as a dated line in EXP-0033's `README.md` by the pull request or note that records it. Seeing signals can
     change which trades the owner takes.
   - **It is not an early end of EXP-0033.** Its `config.yaml` (`window.ends_early_on`) lists nine early ends: an
     amendment to DEC-0035; a change to the value of a rule limit in `trade-rules.ts`; a change to the importer's
     matching; a journal with `fees_included` true; a stamp reading other than `sip`; a stamp gap with a deployment
     change; a bars fetch still failing 5 sessions later; a change to the frozen engine copy's hash or to a past
     session's calendar entry; a broken stamp chain or missing manifest. Signals appearing is none of these. Its
     labels come from a frozen copy of the engine, which no signal touches. The date is recorded as the entry-alert
     date is (DEC-0049 point 8), so that a reader can see it; nothing in EXP-0033's frozen rules changes.
3. **HYP-0059's own report** is never shown on the site. After both reads, this one and EXP-0033's, the site may show
   its SAFE figures only: the counts, the estimate, its range and the verdict.

### 6. Wording and data class

- Setup names are RESTRICTED and never shown. A card uses the lab's own words and the hypothesis id, tagged
  "Testing HYP-0059", as DEC-0042 section 3 requires.
- No percentage, score or confidence. A signal's strength is shown as its list of gates, each pass or fail with its
  value, and the board's cautions as reasons against.
- The signal log is PRIVATE: behind the owner's login only. The staging site shows fixture signals only.

### 7. Alerts

One new alert type, "signal confirmed", sent through ntfy when a break's word first becomes CALL or PUT:

- **Counts only,** under DEC-0049 point 6 as amended below: "confirmed", the side (call or put), the bar time and the
  send time as HH:MM New York, and the trades taken "of 5" with the time of that read. No symbol, level, price,
  contract, dollar amount or share of the day's limit.
- **The fixed vocabulary.** The new kind joins `NOTICE_KINDS` (`dashboard/src/lib/ntfy.ts`) and its words join the
  vocabulary `dashboard/test/ntfy-notices.test.ts` pins, driven by that test like every other kind, with no exception
  to the counts-only rule.
- **The guards and the cap.** It is an entry alert under DEC-0044 section 4: every guard there applies unchanged (the
  "done for today" flag, the journal test, degraded data, production only), and it counts towards the 5 entry alerts
  a session.
- **One alert per break.** A break sends at most one alert of either kind. If DEC-0044's enter-zone alert has been
  sent for the break, no "signal confirmed" alert follows, and if a "signal confirmed" alert has been sent, no
  enter-zone alert follows for that break. Each alert sent counts once towards the cap.
- **When.** It can be switched on only after the DEC-0044 shadow gate (section 2, at least 8 sessions and 10
  enter-zone events, counted on SIP as DEC-0049 point 7 requires) has been met and the owner has seen its numbers, by
  its own switch, in the pull request that adds it. That pull request names any further guard in a dated note in
  DEC-0049, as DEC-0049's consequences ask.
- There is no "ended", "weakening" or "invalidated" alert. Only the page shows that a signal has ended. No version
  of this alert goes over the encrypted channel of DEC-0044 section 3 without its own dated note.

### 8. The test: HYP-0059 SIG-CONFIRMED

**The question.** On forward sessions, do breaks the server confirms when they first reach the entry zone do better
on the stock than breaks that reach it while a market gate fails?

- **The unit: a break.** One per (session, focus name, side, `brokeAt`) whose side reads `enter_zone` in the
  DEC-0044 log. It is scored once, from its **scoring slot**: its first `enter_zone` slot. A break that confirms only
  later is scored by its first slot's word all the same.
- **Its group is the word at the scoring slot**, in this order:
  1. counted, not scored: `not_logged` (the slot has no signal record), `not_usable` (an input not usable: a status
     other than `ok`, a parameter-hash, signal-code-hash or feed mismatch, or no usable board-feed stamp),
     `gate_unavailable` (a market gate that could not be read: a thin, stale or missing baseline, a stale quote, a
     calendar gap, lagging bars);
  2. **a**, confirmed: CALL or PUT;
  3. counted, not scored: `contract_failed` (the contract check did not pass, whatever the market gates read);
  4. **b**, not confirmed: WAIT or NO TRADE because at least one market gate was read and failed, and the contract
     check passed. So group *b* differs from group *a*, by rule, in the market gates only: a break that also had no
     contract inside the owner's rules is not in either group. (Second round, 2026-11-13, the owner's choice: the
     proposal kept such breaks in *b* and split *b* by contract result in the report.)
  5. counted, not scored: `other`, any break none of the above fits (for example a word of NO TRADE at a clean
     scoring slot because `brokeEarlier` or `gap` was set). Any count here is written as a defect line in EXP-0034's
     `README.md`.
- **The card numbers, frozen here** under DEC-0035 section 3 (not an amendment), from `focus-plan.ts` as it stands:
  `ENTRY_ATR` 0.01, `STOP_ATR` 0.1, `MIN_ROOM_MULTIPLE` 2; the call side's level is the edition's `breakout_above`
  (else `resistance.price`), the put side's `hold_above` (else `support.price`); entry = level ± 0.01 ATR, stop =
  level ∓ 0.1 ATR, T1 = entry ± 2 × |entry − stop|, each rounded to the cent, with the edition's ATR. The test reads
  these, as the signal record logs them for the side, not the display.
- **The outcome.** The entry is the OPEN of the first 2-minute bar that starts at or after the scoring record's
  evaluation time (`entry_open`), never the settled bar that put the side in the entry zone. From that bar, as the
  fill bar, the exit is EXP-0032's `config.yaml` `outcome.after_fill` (DEC-0047 section 3, exit policy `card`),
  applied unchanged with the frozen T1 and stop. R = sign × (exit − `entry_open`) ÷ |card entry − card stop|, sign
  +1 for a call and −1 for a put, rounded to 2 decimals. The bars are fetched and joined as EXP-0032's `config.yaml`
  `bars` says (SIP 1-minute bars by name, joined into 2-minute bars, fetched after the close, saved with their
  SHA-256, the same usable rule). Counted, not scored: `bars_incomplete`, and `no_entry_bar` (no bar starts after the
  evaluation time before the close).
- **A counted session** is one in the window on which at least 90% of the session's expected slots (`expectedSlots`
  in `desk-eval.ts`) hold a signal record and have a usable board-feed stamp (section 1); otherwise it is
  `log_incomplete`, and its breaks are counted, not scored.
  This one definition is used everywhere below.
- **The measure:** mean R of group *a* minus mean R of group *b*.
- **Supported** only if the 95% bootstrap range of that difference (5,000 resamples of counted sessions with
  replacement, every break of a drawn session coming with it, mulberry32 seeded 20261159, numpy's linear
  percentiles, as EXP-0034's `config.yaml` gives them) lies wholly above zero AND the difference is above zero in
  each half of the window (the counted sessions in date order, the first `floor(n/2)` then the rest; a half with an
  empty group fails).
- **Preconditions,** each recorded with its commit by a dated line in EXP-0034's `README.md`. Amendment 1 is not
  written, and the window does not start, before all four are in production or merged:
  1. the per-slot range baseline in production (the shock gate cannot be read without it);
  2. the read script, merged with synthetic-data tests, including the generator's test vectors;
  3. the outcome code (the bar fetch and join, the usable test, `entry_open`, the exit and R), merged and frozen; a
     later change other than a defect fix recorded by a dated README note before the read is an early end;
  4. board-feed stamps written in production for every minute of one full (not half-day) regular session, each
     reading `sip` with SPY answering, and that session sealed. (The owner reported on 2026-11-13 that no stamp had
     been written since the open on 2026-11-12, and that the cron fires at second 47 to 49 of its minute; the writer
     writes nothing past second 45 of the minute (`board-feed-stamp.ts`). Until that is fixed and a full session is
     stamped, Amendment 1 is not written and no window starts.)
- **The window.** It starts at the first regular session that opens after: the preconditions are met, Amendment 1
  is merged and in production, and the switch first reads `log` or `show` in production. Forward only, never
  backfilled. No `dry` session is ever in it.
- **Read once,** by the read script, at the first of: 100 scored breaks in group *a*, or the fixed close date one
  year after the date this record is accepted (written into EXP-0034's `README.md` by the pull request that accepts
  it). The read uses the breaks up to that point; later ones are not taken.
- **Too few to judge:** fewer than 30 scored breaks in either group, or fewer than 20 counted sessions, when it is
  read. That is an exploratory mark, not evidence either way, and it counts as not supported for the pre-set action.
- **Secondary, descriptive only:** for each break in group *a*, the option result from the logged quotes: in at the
  named contract's logged ask at the scoring slot, out at its logged bid in the first record at or after the stock
  exit bar's end (`follow`), less the owner's fees ($0.55 to open, $0.56 to close a contract), in R25 as EXP-0033
  measures it. A break with no logged exit quote is counted, not valued. Its mean and range are reported; nothing is
  tested on it.
- **Sensitivity table, report only.** It changes no verdict: the difference within the windows 09:35 to 10:00, 10:00
  to 11:30 and 13:00 to the close; SPY and QQQ against the single names; group *b* re-weighted to group *a*'s mix
  of name and window; `contract_failed` counts by the contract check that failed and by the market gates that
  failed; and the difference with *b* as first proposed (every market-gate failure, whatever the contract check
  read), which also shows what leaving out expensive names and high-IV days did to *b*. Each line gives the estimate
  and the group sizes; none is tested.
- **The selection switch (DEC-0048) has no effect on EXP-0034.** The unit is the board's own break on whatever names
  are picked, and the test compares breaks with breaks on the same names. The report gives each group's count before
  and after the switch date. DEC-0048 should say so as DEC-0046 section 6 asks.
- **Every threshold variant counts as a trial.** Amendment 1 freezes one set of numbers, without reading an
  outcome: that set is this trial. Any other set tried, before or after, is a new trial with its own record.
- **The pre-set action.** Supported: the tag changes from "Testing HYP-0059" to "Stock test passed (HYP-0059);
  option result not tested", by the pull request that records the verdict (the owner's choice on 2026-11-13, asked
  directly). It is not removed, and nothing is called proven for options. Not supported (falsified, too few, or an early end): the signal words are withdrawn by the pull
  request that records the verdict; the gates stay on the page as plain facts, each pass or fail with its value.
- **Early ends.** The window ends at the last session before any of these reaches production, and **every early end
  closes the trial with no verdict**, whatever the counts; the trial stays counted, and the date and cause go in
  EXP-0034's `README.md`:
  - an amendment to DEC-0035 that changes a card number, or a change to the numbers frozen above;
  - a change to a trade-rule limit the contract check reads: `MAX_PREMIUM`, `RISK_PER_TRADE`, `PREMIUM_STOP` or the
    owner's fees (`OWNER_FEES`);
  - an engine change that the identity check finds (below);
  - a change to a gate's definition, or to a number Amendment 1 froze (a new parameter hash);
  - a change to the signal code's own hash, stored in every record, other than a defect fix recorded as above;
  - an edit to a past or the current session's row of `market-calendar.json` (adding later sessions is not one);
  - a change to a feed: the signal reading anything but SIP for the stock or OPRA for the option, or a board-feed
    stamp (DEC-0050 point 4) reading other than `sip`;
  - a gap in the board-feed stamps over 10 minutes across which the deployment changed (EXP-0033's
    `hidden_change`): a change of `ALPACA_FEED` needs a redeploy, so a flip between stamps shows here;
  - a change to the frozen outcome code other than a recorded defect fix;
  - a breach of either blind of section 5, or of section 3's rule that the page shows only the log.
- **The engine identity check.** Before a release that changes the engine label (DEC-0044's note) reaches production,
  every fixture and the last 10 logged sessions are run through the old and the new engine. The window ends only if
  any row's state, `brokeAt` or card numbers differ. The check prints yes or no and counts only, and its result is a
  dated line in EXP-0034's `README.md`. A label change shipped without it is an early end.
- **What it cannot show.**
  - R on the stock is not option P&L. A gated break that does better on the stock may still lose on the option, after
    the spread and the fees.
  - Group *b* is smaller than first proposed, since every break without a contract inside the owner's rules leaves
    it. That raises the chance of fewer than 30 breaks in a group, which reads as too few to judge.
  - There is no point-in-time history to test on. The levels were built from another provider's bars, the editions
    exist only since 2026-10-09, and the owner has seen rebuilt sessions. So the only evidence is forward and sealed.
  - The labels and the evidence come from one feed, SIP. It says nothing about what the board would have shown on
    another.
  - The groups are not random: a break that confirms differs from one that does not in more than the gates. The test
    asks whether the word picks the better breaks, not why; the sensitivity table shows how much time of day and name
    could account for.

### 9. Trials

One new trial, in **family O**, which becomes **36** (`config/trial_registry.yaml`).

- **Why O.** Family O (DEC-0028) counts the options desk's own entry rules and the filters tried on them: the four
  level rules, the clone's setups and the research arms of DEC-0041, whose tag arms ask this kind of question (the
  same level entries, with and without a condition, mirrored on the desk as its cautions). HYP-0059 asks whether a
  set of conditions picks the better of the board's level entries, on the stock's R. Counting it beside them is what
  DEC-0005 asks: the same idea tried another way is another trial against the same family.
- **Why not M.** Family M (DEC-0045) is the owner's own trades split by what the board showed. HYP-0059 reads no
  trade of his and no journal.
- **Why not F.** Family F (DEC-0047) is the selection's accuracy: which names are picked. HYP-0059 takes the names
  as given.
- **Why not a new family.** A family of one would hide that the board's entries have already been tried many ways.
- The global count and families C, M and F are unchanged.

## Amendments to earlier records

Each takes effect when this record is accepted. A dated note in each amended record points here.

1. **DEC-0028 section 1.** The sentence "It never says buy or sell, and nothing in it places, stages or suggests an
   order." stands for everything but DEC-0051's signal words, and gains: "The signal words of DEC-0051 (CALL, PUT,
   WAIT, NO TRADE) and the contract named beside them are the lab's advisory reading, marked Testing, display only.
   Nothing places, stages, routes or sizes an order. The owner decides and enters every order by hand."
2. **DEC-0042 section 1.** The sentence "One state per focus name. The states are no trade, watch, get ready, enter
   zone, plan off, missed and prices paused." stands, and gains: "Beside each side's state the page may show the
   signal word the server logged for it under DEC-0051 (CALL, PUT, WAIT or NO TRADE), with its lifecycle and gates.
   The states, their order and their rules do not change, and a signal word never changes a state." Section 1's
   "computed in the browser" (already amended by DEC-0044) is not widened: a signal is never worked out in the
   browser. Sections 2, 3 and 4 stand; section 3's strings test is extended as section 3 above says.
3. **DEC-0044 section 1.** The sentence "It is not a host job. It runs on the site, places no order, stages no order
   and suggests no order, as DEC-0028 section 1 and DEC-0042 require." stands for the state log, and gains: "A
   signal word and its contract are the lab's advisory reading, marked Testing, display only. Nothing places, stages,
   routes or sizes an order. The owner decides and enters every order by hand."
4. **DEC-0049 point 6.** Its first item, "the state word and the side (call or put);", reads on a "signal confirmed"
   alert: "the word confirmed and the side (call or put);". Nothing else in point 6 changes: no symbol and no share of
   the day's loss limit go through ntfy, and the new kind joins `NOTICE_KINDS` and the test's vocabulary with no
   exception.
5. **Left alone in DEC-0044:** section 2's "Alerts can be switched on only after the owner has seen them" (section 7
   keeps it); section 3's own list ("the symbol, the side (call or put) and the state word", for the encrypted
   channel, as DEC-0049 point 6 narrowed it for ntfy), which this alert does not use; every guard of section 4;
   section 4's "There are no "ended" messages: only the page shows that a state has ended"; section 5; and section
   6's "It starts no trial", since this record, not DEC-0044, registers HYP-0059.

## Not decided here (the owner's steps)

- **The expiry rule** (section 2.5), before acceptance.
- **Switching the log to `dry`**, once the range baseline is in production.
- **Amendment 1:** the frozen numbers, by the rule of section 2, from at least 10 `dry` sessions.
- **Switching the log to `log`**, after Amendment 1 is in production.
- **Showing the words** (`show`), only after the DEC-0044 shadow gate is met on SIP and the owner has seen its
  numbers; the date goes into EXP-0033's and EXP-0034's READMEs.
- **The "signal confirmed" alert**, by its own pull request and switch, after the same gate.

## Accepting this record

The pull request that accepts it changes, as #412 did for DEC-0047, and nothing else:

- the Status line above, to ACCEPTED with the date and `approved_by: owner`;
- the DEC-0051 row of `config/trial_registry.yaml`, from `proposed` to `accepted`;
- `status: proposed` in EXP-0034's `config.yaml` to `registered`, and the acceptance date and the close date in its
  `README.md`;
- the eight assertions that pin family O at 35, to 36, with their comments naming DEC-0051: one in
  `tests/unit/test_options_records.py` (`test_the_registry_counts_family_o_as_the_decision_states`) and seven in
  `tests/unit/test_options_clone_records.py`. While the row is `proposed` they stay at 35 and pass.

## Consequences

- The board's states do not move. What changes is a word beside them, which the owner may read as an instruction.
  The "Testing" tag, the gates shown with their values and this record are there to keep it from being read as more.
- NO TRADE will be common, mostly from the contract check. That is the rule working, not a fault.
- A missed run leaves a gap, and the page says "not logged". It never shows yesterday's or the last slot's word.
- The log holds option quotes that the board's own log does not. It is PRIVATE and stays behind the owner's login.
- If the test is not supported, the words go and the gates stay as facts. If it is supported, the tag says the stock
  test passed and the option result was not tested; a rule built on the words would need its own record.
