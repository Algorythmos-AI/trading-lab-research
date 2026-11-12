# DEC-0044: The owner's desk states may also be worked out on the site's server, logged, and later sent as phone alerts

- **Status: ACCEPTED on 2026-11-11.** approved_by: owner. The owner approved the plan on 2026-11-11 to have the
  site's server work out the Options desk's advisory states each settled 2-minute slot, log them, and, after a
  log-only shadow period whose numbers the owner sees first, send entry alerts to his phone. The merge of the pull
  request that carries this line accepts it.
- **Written before any affected P&L is viewed.** None of what is described below exists on the site yet: there is no
  server evaluator, no state log and no alert. The author did not read the owner's journal, the clone's results
  for EXP-0029 or EXP-0030, or any replay while writing this record; the one trade the owner showed in session that
  day is noted in DEC-0045.
- **Amends DEC-0042 in one place only:** section 1 said the desk is computed in the browser. The same states may now
  also be computed on the site's server, as below. Everything else in DEC-0042 and DEC-0043 stands. The owner's nine
  trade rules, the card plan's numbers (DEC-0035), the options clone (EXP-0029, frozen by DEC-0040) and the research
  arms (DEC-0041, EXP-0030) are unchanged.
- **Depends on:** DEC-0028, DEC-0035, DEC-0041, DEC-0042, DEC-0043.

## Why

The desk only helps while the Options page is open and in front. The owner trades from his phone as well, and a
state he does not see is no help. The same pure engine the page runs (`dashboard/src/lib/trade-state.ts`) can run on
the server from the same edition and the same 2-minute bars, so the phone can be told when a name reaches the entry
zone. A phone alert also invites a late chase, or a trade after the owner has stopped for the day, so what may be
sent and when is fixed here before any of it is built.

Two facts from the owner on 2026-11-11 shape it. Webull lets him rest a stop or stop-limit order on a long option;
the stop to place stays on the page's manage card, and ntfy carries no level. The lab's ntfy notes already reach his
iPhone, so ntfy is the first alert channel.

## Decision

1. **The server evaluator.** From the release that carries it, the site's server may run the desk's own pure
   functions (the board of `dashboard/src/lib/trade-now.ts` over `trade-state.ts`), unchanged, once a minute in
   session.
   - Each run evaluates **as of the last settled 2-minute slot**: a bar counts only once `SERVER_SETTLE_MS` (60 s)
     have passed since its end, as the page already reads the server's bars. Two runs inside the same slot give the
     same answer.
   - Each evaluated slot is written once to a state log (one file per slot, never overwritten): per focus name and
     side, the state word, the bar time and the evaluation time, enum values and numbers only.
   - It is not a host job. It runs on the site, places no order, stages no order and suggests no order, as DEC-0028
     section 1 and DEC-0042 require.
2. **Shadow first, logs only.** The evaluator writes its log and sends nothing for **at least 8 sessions and 10
   enter-zone events**. Then its numbers go to the owner: the share of slots logged, how often the server's states
   match the open page's, and the median and worst delay from bar end to evaluation. Alerts can be switched on only
   after the owner has seen them.
3. **What an alert may carry:**
   - the symbol, the side (call or put) and the state word;
   - the bar time the state comes from and the time the alert was sent;
   - the day's usage as last read from the journal (trades taken of 5, and the share of the day's loss limit used,
     in %) and the time of that read.

   Levels and prices go only over an end-to-end encrypted channel to the owner's own device. Through ntfy, the first
   channel, no level, price or dollar amount is sent, as the lab's ntfy notes already carry R and % only.
4. **Guards.** No entry alert is sent:
   - after the owner sets his "done for today" flag;
   - beyond **5 entry alerts in a session**, the day's most entries (rule 8, `MAX_TRADES_PER_DAY`);
   - when the journal is not current by the board's own test (`journalCurrent`), or shows a rule break today
     (`tradeBreaks`);
   - from degraded data: a gap in the bars, a break the page could not see the close of (`brokeEarlier`), or a stale
     quote;
   - in fixture mode, or anywhere but production.

   There are no "ended" messages: only the page shows that a state has ended. The flags that switch the evaluator and
   the alerts on and off are read every run from the site's own store and can be changed without a deploy, so either
   can be stopped at once.
5. **Manage alerts stay in the browser.** The manage card (stop, target 1, the trail, the five-minute rule, the close)
   stays on the page. Sending a position's entry or stop to the server, so the phone could also say "exit", is not
   allowed by this record and needs its own.
6. **What this does not start.** It starts no trial and adds nothing to `config/trial_registry.yaml`. Comparing the
   owner's trades by what the board showed is DEC-0045's, and the live log written here is not the source of its
   labels.

## Consequences

- A phone alert arrives a minute or more after the bar it comes from. The bar time and the send time it carries let
  the owner see how old it is; the shadow period measures the delay before the first one is sent.
- The server can differ from the page by a slot when the page saw a print the server's bars do not yet hold. The
  shadow comparison measures this. When in doubt the engine says get ready, never enter zone, on both.
- If a DEC-0041 arm's verdict removes a caution or line from the desk (DEC-0042, Consequences), it leaves the server's
  evaluation in the same pull request.

## Note on the engine label (added 2026-11-12; nothing above is changed)

Every record the evaluator and the page write to the state log carries an engine label: a hash of the code the
server's evaluation runs (`dashboard/scripts/gen-engine.mjs`, every file `desk-eval.ts` reaches). A new label means
a line of that code changed, not that a rule did. The next release to `main` changes it once:

| Release | Label before | Label after | Engine files changed | Change to a state, a level or a guard |
|---|---|---|---|---|
| Robustness wave 1 (#375 to #381) | `e-c0b7d260245b` | `e-5f6c5cbf0639` | `market-calendar.json`, `market-calendar.ts` (#376); `bars-feed.ts` (#378) | None |
| Session calendar to 2029 (#389) | `e-5f6c5cbf0639` | `e-0615f37ee2ba` | `market-calendar.json`, `market-calendar.ts` | None up to 2027-12-31: no session, holiday, half day or close time on or before that date changed (a per-year hash in `tests/unit/test_market_calendar.py` holds it). Only dates after 2027-12-31 were added: the range now ends 2029-12-31 (first new session 2028-01-03), and on those days `sessionOf` now gives the exchange's session, holiday or 13:00 close instead of out of range. The rows' quality field, the `checked_against` header and the month notes are not read by the evaluator |
| Edition build-age check | `e-0615f37ee2ba` | `e-3f82b5b4b3c0` | `options.ts` | None: the evaluator does not call `builtFromOld` or the functions added beside it (`builtFromProblem`, `builtFromNotice`, `builtFromDay`, `builtFromWords`); only the Options pages' warning and their "built from" lines read them. No other function in the file changed |
| Bad-data guards (B2) | `e-3f82b5b4b3c0` | `e-5e6df4f6a595` | `trade-state.ts`, `trade-now.ts`, `desk-eval.ts`, `options.ts`; joined: `quote-guards.ts`, `quote-shape.ts` | None while every guard is switched off, which is how it ships: no state, level, line or guard of section 4 changes (a test holds the rows, the board as drawn, the page surfaces drawn from it, the evaluation and the record's other engine fields byte-identical to `e-3f82b5b4b3c0` over every fixture). Each of the four data guards in DEC-0042's note, once the owner switches it on in `desk/guards.json`, pauses a name its check trips |
| Open-positions caution names options only | `e-5e6df4f6a595` | `e-28344e769752` | `trade-rules.ts` | None: only the text of the day check's open-positions caution changes (`openNote`: open shares are no longer named; an open option is named as before). The evaluator reads the day check's status, breaks and currency, none of which this touches; no state, level or guard of section 4 changes. Owner's decision, 2026-11-12 |

- `market-calendar.json` gained 2027 macro rows and three earnings rows, and one 2027 date was corrected. The
  evaluator reads only the session calendar from this file (`sessionOf`: holidays and half days), which did not
  change.
- `market-calendar.ts`: one function took a second argument for its tests. The evaluator does not call it.
- `bars-feed.ts`: the browser's polling loop moved to `bars-poller.ts`. The functions the evaluator uses were not
  edited.
- #375, #377, #379, #380 and #381 changed no file the label covers.

**For the owner to decide here:** whether the shadow count of section 2 (at least 8 sessions and 10 enter-zone
events) carries on across this label or restarts at it. Since no state, level or guard changed, the two labels
evaluate identically, and the proposal is that the count carries on, with both labels named in the shadow report.
Until the owner writes an answer under this note, the report keeps the two labels apart.

No state log, owner trade or result was viewed for this note.

## Note on DEC-0049 (added 2026-11-12)

DEC-0049, accepted before any alert has been sent, amends section 2 (the shadow count is per feed and restarts when
the board's feed changes) and section 3 (an ntfy alert carries no symbol and no share of the day's loss limit; those
go only over the encrypted channel). Section 4 is not amended: any further guard is named, with its file and pass
rule, in a dated note in DEC-0049 by the pull request that adds entry alerts. It does not answer the engine-label
question in the note above. The text above is otherwise unchanged.

## Note on the bad-data guards (added 2026-11-12; nothing above is changed)

- The slot record gained, after `probe`, the data guards' observe-mode counts (`guards`: how the switches read, which
  were on, and per focus name the guards that would have paused it, the 25% move on its own, and whether its row was
  paused and why, as enum
  words) and the run's count of HTTP 429 answers (`http_429`); the engine's fields are unchanged. A slot whose page and
  server ran with different switches, or that the page took while it could not confirm its switches
  (`guards_unsure`), is counted apart in the shadow numbers, not compared. These data guards are
  DEC-0042's; section 4's guards on alerts are not amended.

## Note on DEC-0051 (added 2026-11-13)

DEC-0051, proposed on 2026-11-13, amends section 1 once it is accepted: a signal word and its contract are the lab's
advisory reading, marked Testing, display only; nothing places, stages, routes or sizes an order, and the owner
decides and enters every order by hand. The alert word it adds amends DEC-0049 point 6, not section 3 here. Sections
2 to 6 are not amended: a "signal confirmed" alert is an entry alert under every guard of section 4, counts towards
its cap of 5, and a break sends at most one alert of either kind; there is still no "ended" message. The signal
record is written after this record's slot record and is not part of it: the record's bytes, timing and engine label
are unchanged. The exact wording is in DEC-0051, "Amendments to earlier records". The text above is otherwise
unchanged.

No owner trade, P&L, state log or result was viewed for this note.
