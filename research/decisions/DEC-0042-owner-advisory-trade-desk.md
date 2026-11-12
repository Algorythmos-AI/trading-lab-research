# DEC-0042: The owner's Options desk shows advisory trade states, cautions and a runner plan; rules unchanged

- **Status: ACCEPTED on 2026-11-06.** approved_by: owner. The owner approved the plan on 2026-11-06 to make the
  lessons of the options-trader study (`research/external/desi-trade/`, DEC-0041) usable in their own daily option
  trading: as advisory states and cautions on the dashboard's Options desk, with a second exit plan beside the
  current one. The merge of the pull request that carries this line accepts it.
- **Written before any affected P&L is viewed.** None of what is described below exists on the site yet. The author
  did not read the owner's journal results, the clone's results for EXP-0029 or EXP-0030, or any replay while writing
  this record.
- **Amends nothing.** The owner's nine trade rules (`dashboard/src/lib/trade-rules.ts`, the probation rules HYP-0025
  to HYP-0028 under DEC-0028), the options clone (EXP-0029, frozen by DEC-0040) and the research arms (DEC-0041,
  EXP-0030) stand as written. Nothing here changes what any job trades or how any trial is counted.
- **Depends on:** DEC-0028, DEC-0040, DEC-0041.

## Why

The study's rules are under test in the clone until DEC-0041's counts are reached. The owner trades by hand meanwhile
and asked to see the same ideas while trading, clearly and without clutter. Shown as advice and marked as untested,
they inform the owner's choices without becoming rules: adopting any of them as a rule needs that rule's verdict
first.

## Decision

1. **What the desk shows,** from the release that carries it, on the Options page only, computed in the browser from
   the edition, the live quotes and the owner's journal. There is no new host job and no order path.
   - **One state per focus name.** The states are no trade, watch, get ready, enter zone, plan off, missed and
     prices paused. Each comes with one instruction in plain words and the plan's prices.
   - **Cautions** beside an entry, mirroring DEC-0041's tag arms (`wt.options.setups.tag_decision`) on live prices:
     - the middle of the range (HYP-0034/35)
     - an unfilled gap (HYP-0036/37)
     - SMH against QQQ (HYP-0038/39)
     - rich implied volatility (HYP-0040/41)
     - after 11:00 New York (HYP-0042/43)
     - a winner already closed today

     All are marked as testing.
   - **Two further trigger lines**, shown only when they arise, mirroring the trap and fast-reclaim arms (HYP-0046,
     HYP-0047), marked as testing.
   - **A runner exit line** beside the current exit, mirroring the runner arm (HYP-0044/45), marked as testing.
   - **A manage card** for a position the journal shows open, or that the owner notes as entered in their own
     browser: the stop, target 1, the runner's trail, the five-minute rule and the close.
2. **Advisory only.** A caution never removes an entry and is never a rule break. The nine rules, their evidence and
   the day check are counted exactly as before. A state the page cannot see says so ("confirm on your chart").
3. **No research text on the site.** The desk's words are the lab's own. No post, no setup name and no prose from the
   study reaches the dashboard. The only references are the HYP ids, and a test guards the new strings.
4. **What this does not start.** It starts no trial and adds nothing to `config/trial_registry.yaml`. Comparing the
   owner's own trades by the state or cautions at entry is a separate question. It needs its own hypothesis and
   experiment, written before any such comparison is looked at.

## Consequences

- The owner sees untested ideas on the screen they trade from. The "testing" marks and this record keep that
  visible. If a DEC-0041 arm reaches a verdict that rejects its idea, its caution or line is removed from the desk in
  the pull request that records the verdict.
- Because the states are computed from IEX last trades in the browser, they can differ from the owner's broker by
  cents and by seconds. The desk is an aid to the owner's own chart, not a substitute for it.

## Note on the board's event line (added 2026-11-12; nothing above is changed)

From the release that carries it, the Options page shows one line, in one place at a time, with what the event
calendar schedules on the board's day: in the status rail, under its session bar, while the Trade now board is
folded into the rail (before the open, while connecting, and after the close) and whenever the cockpit is on (the
cockpit hides the board, not the rail); otherwise, once the board is drawn (from 09:35, the first entries, or
earlier when a manage card is open, and with live prices off), in the board, under its header and above its rows. It
says: each release the calendar lists for that day with its New York time ("in N min" from 30 minutes before it,
"now" in its minute, then that it was at that time), and, for each focus name, earnings after today's close (with
the close's time, 13:00 on a half day), during the session, before today's open (as still ahead until 09:30, then as
out), after the last session's close, or before the next session's open. A date the calendar does not mark as
confirmed is shown as expected. When the calendar does not cover the day, has no dates yet for a month's releases,
keeps no earnings dates for a focus name, or lists no upcoming earnings date for a single-stock focus name whose
last listed date is more than 75 days old (the host's own horizon, `EARNINGS_MAX_AGE_DAYS` in
`src/wt/risk/events.py`; SPY and QQQ report none), the line says so; it never says that a day has no event. At most
five items are drawn, the rest counted ("+N more"), and the notes on what the calendar does not cover are folded
before any event; the whole list is in the line's title and its screen-reader text. On a day the calendar lists
nothing for, nothing is drawn.

- **Display only.** No state, level, guard, caution or alert changes. The line is not read by the engine, the
  server's evaluation, the shadow comparison or any alert, and adds no ntfy notice. Its files
  (`dashboard/src/lib/board-events.ts`, `dashboard/src/components/board-events.tsx`) are outside the import closure
  of `desk-eval.ts`, so the engine label stays `e-3f82b5b4b3c0`; a test loads the engine on two calendars, one with
  releases and earnings on the fixture day and one without, and finds its output identical.
- **The calendar the repo already keeps.** It reads `dashboard/src/lib/market-calendar.json`, which
  `scripts/build_market_calendar.py` builds from `config/events/macro_events.csv` and `config/events/earnings.csv`.
  That file carries no severity, so the line ranks and filters nothing by one: every release it lists for the day is
  shown under its own label. It holds only CPI, the jobs report, Fed decisions and minutes, and quad witching
  among releases, and the desk names' earnings: other releases (PCE, PPI, GDP, retail sales, JOLTS) are not shown,
  and the line's title and screen-reader text say what it covers. The 30 minutes changes the wording only. Where an
  official release date differs from the repo's copy, the Calendar page may show the official one and says so; the
  line shows the repo's copy.
- **No advice.** The line says what, when and for whom. It does not say what to do and predicts nothing.
- **What this does not start.** It starts no trial and adds nothing to `config/trial_registry.yaml`. Comparing the
  owner's trades on days with and without such an event is a separate question, with its own hypothesis and
  experiment written before any such comparison is looked at.

No state log, owner trade or result was viewed for this note.

## Note on the bad-data guards (added 2026-11-12; nothing above is changed)

The desk now carries four data guards (`dashboard/src/lib/quote-guards.ts`). Each checks one focus name's snapshot
from the board's own feed:

- `bar-high-below-low`: the day's bar reads a high below its low;
- `bar-open-outside-range`: the day's bar reads an open below its low or above its high;
- `print-far-outside-day-range`: a bad print. The last trade is more than 25% from the prior session's close (exactly
  25% is not) and also outside today's day bar (above its high or below its low), with today's bar and today's trade
  readable. It is not a halt or price-band rule;
- `quote-crossed`: both sides of the quote are active, the bid is above the ask, and the quote is fresh by the trade's
  own rule (stamped no more than two minutes before the clock). A locked quote, a zero price or size on one side, or a
  stale or timeless quote never trips it.

The plan said that a last trade outside the day's range is not a guard on its own, because the day's bar leaves out
extended-hours and volume-only prints, so that happens in normal trading. That stands. A move of more than 25% from
the prior close is not a guard on its own either: a real earnings gap, or a split day read against an unadjusted
prior close, moves that far while the price stays inside the day's own range, and a guard on it alone would pause the
name all session. Only the two together mark a print that the day's own trading does not support. A guard reads only
inputs that are present and readable, so missing data never trips one; a missing or old price is already paused by
the stale check. A missing or unreadable day bar, prior bar or quote pauses nothing.

Each guard is off until the owner switches it on in the site's own store (`desk/guards.json`), which needs no release
and can be undone. The server check reads the switches every run it evaluates; the open page reads them with the page
and again each minute while its board is live, and keeps the last good read if a re-read fails. The plan is to switch
one on only after its counts show how often it would have fired on at least three normal sessions. The server check
records those counts, whatever the switches say, but only while its own switch (`desk/eval.json`) is on: per name and
guard, the slots it would have tripped and the separate runs of consecutive tripped slots, and the 25% fact on its own.

When a guard is on and trips, the name reads paused ("prices paused" and "check your platform", with the reason in
plain words), ahead of the clock gates and every state, so a paused name never shows an entry. The page judges its own
quote as it polls it, and its record is taken at the slot's close; the server judges the snapshot it reads when it
runs, a minute or more later. Both use the same definitions on their own data, so they can differ when the data does.
A guard can also turn a row from live to paused and back from one 2-second poll to the next; the run counts show how
often each would, and are among the things to look at before switching one on. While a name is paused by a guard its
level ladder shows no live price or distance, a kept entry notice for it is withdrawn at once, the manage card of an
open trade on it says "check" with the guard's reason and shows only the plan's own stop and target 1 and the flat
time (no exit, no moved stop, no trail, no five-minute judgment, no distance), and the board's paused line names the
guard.

With every guard off nothing on the desk changes. A test holds this byte for byte against the code before the guards
over 735 board inputs and 84 server slots (the plain, partial and v2 focus editions; every step of the scripted
morning; clock times across a full session and a half day; the fixture's plain, ticking and scripted prices, and the
suspect variant with each guard in turn): the board's states, the board as drawn, the hero, the glance chips and
tiles, the status rail, each level ladder, the manage card of an open trade, and the server's evaluation with its
record's engine fields. It does not cover a live session's data, which no one has yet seen with a guard on.

No owner trade, P&L, state log or result was viewed for this note.
