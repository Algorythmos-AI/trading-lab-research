# DEC-0076: Gap Hunter moves to the highest-ranked tier-2 name with a valid order, in shadow first

- **Status: ACCEPTED** by the owner's merge of the pull request that changed this line; written and merged as
  proposed on 2026-11-23, after the US close. The owner chose the rule's three main points in chat that evening
  (below). The points marked **(set here)** were accepted as written (see "Notes").
- **Builds on:** DEC-0068 (the selection, the score, Tier 2, the registered gap entries and their musts; all
  unchanged) and DEC-0066 (the book, limits, day stop and stop rule; unchanged).
- **Does not amend:** DEC-0068. HYP-0071 keeps trading exactly as registered: the primary only, no rotation. This
  record adds a second rule beside it, run in shadow.
- **Trial:** 1 new, HYP-0072, in family **S** of `config/trial_registry.yaml` (now 4). Forward only. The global
  count stays at 87.
- **Experiment:** EXP-0054.

## Why

On 2026-11-23, HYP-0071's first live paper session, the primary was MEDS (rank 1 of four tier-2 names). Its four
gap entries never had a valid order between 09:30 and 11:00: price levels a few cents over every trigger left no
2:1 room. The desk does not rotate (DEC-0068, "The trade"), so it made no trade.

The owner's description of the method has rotation in it: a primary for the open, then other names in play.
DEC-0068 left rotation out to keep one trade a day simple. This record tests it without touching HYP-0071.

## The owner's choices (chat, 2026-11-23)

1. **Which name:** every minute, the highest-ranked tier-2 name that has a valid order at that minute. The desk
   may go back to a higher name when it becomes valid again.
2. **How it runs:** in shadow first. HYP-0071 keeps the desk's orders. The rotation rule journals what it would
   have done and places nothing. It is switched on only by a dated note in this record.
3. **Which names:** Tier 2 only (DEC-0068's top 4 by score), never further down Tier 1.

## The rule (frozen)

- **Names.** The tier-2 names of `wt.scanner.gap_hunter.select` on the 09:25 pool, ranks 1 to 4, as HYP-0071
  reads them. Each has its own context (`runner_s.gap_selection(day, open, symbol=...)`: its pool row and its saved
  pre-market bars). Nothing read after 09:30 changes the names or their order.
- **Each name's order.** The registered gap entries ENT-GG-1 to ENT-GG-4 in that name, exactly as HYP-0071 reads
  them in the primary: `wt.live.setups_live.gap_orders`, then `gap_choose` (the lowest trigger, ties to the lower
  rule number), with every rule's window, first-minute volume, 2:1 room and stop as registered.
- **The one order that rests.** At each minute, of the names whose own order is valid, the one with the best rank.
  When that changes (a higher name becomes valid, or the resting name's order goes), the resting order is
  replaced: cancel, confirm, then place, as DEC-0068's note of 2026-11-20, item 1.
- **The day's one attempt.** The first closed bar, in the name whose order was resting for that minute, that
  reaches that order's trigger. Filled or not, that ends the day (DEC-0068's note, item 2). A bar in another name
  reaching that name's own order (one that was not resting) is not an attempt.
- **Everything else** as HYP-0071: the spread must at the decision (at most US$0.05, unknown fails), the strict
  10%-of-R collar, the size, the exit, the 11:00 end of the entries, one trade a day, the US$600 book. No new
  number is introduced.

## In shadow (until it is switched on)

- **What runs.** The paper-s session computes the rule each minute beside HYP-0071 and journals, for each change of
  the resting name or order: the minute, the name's rank, the rule code, the trigger and the stop. At the attempt
  it journals the bar and whether `setups_live.engine_entry` would fill it. At the decision it journals the NBBO
  and whether the spread must passes. **(set here)**
- **What it never does.** It places no order, changes no HYP-0071 order, and computes no R, no P&L and no exit.
  Shadow reports carry counts only.
- **How long.** Until the owner switches it on, or 20 sessions, whichever comes first **(set here)**. At 20
  sessions without a switch-on note, the shadow stops and this record gets a dated note saying so.
- **Code.** A pull request of its own adds the shadow to `wt.live.runner_s`, with replay tests. It switches
  nothing on.

## Switching it on

- A dated note in this record, in one pull request with `S.switched_on` set to HYP-0072 in place of HYP-0071. Only
  one trial places orders in a session (DEC-0068's note, item 8).
- Before that note the owner sees the shadow's counts (EXP-0054 "shadow") for at least 10 sessions **(set here)**.
  No outcome of any shadow attempt is computed or shown first.
- From the switch-on, HYP-0072 is judged as HYP-0071 is: mean R per closed paper trade, with DEC-0074's haircut
  beside it. HYP-0071's sample ends at the switch-on and is reported as it stands.

## Disclosure

- Seen before this record was written, all on 2026-11-23 (counts only):
  - HYP-0071's session: the primary, its zero valid orders, no trade.
  - For each tier-2 name, replayed on the host after the close: the minutes each rule had a valid order, whether a
    bar reached the order, and whether the engine would have filled it. MEDS: 0 minutes; DWTX (rank 2): one e4
    minute, reached, the engine would fill; MSS and GENI: 0 (first-minute volume under 100,000).
- Not seen: the price path after any attempt, any R, P&L or exit. Under this rule 2026-11-23 would have had one
  attempt, in DWTX; its outcome was never computed.
- The rule was chosen because of 2026-11-23. It is therefore not blind to that day. 2026-11-23 is not counted in
  EXP-0054: the shadow starts at its first session after the shadow's code reaches the host.
- This rule cannot be checked on past years, for the reason given in DEC-0068 "Disclosure" (no headlines before
  2026-04-28). Its evidence is forward sessions only.

## Notes

### Accepted, before the shadow's first counted session

- Accepted by the owner's merge of the pull request that set the status line to ACCEPTED and the family S row of
  `config/trial_registry.yaml` to `accepted` (family S: 4). The global count stays at 87.
- The **(set here)** points are kept as written: the shadow journals each change of the resting name or order, and
  the attempt with the engine's fill verdict, the NBBO and the spread must; it runs at most 20 sessions; the owner
  sees at least 10 sessions of counts before a switch-on note.
- The shadow's code is in `wt.live.runner_s` (journal rows `rotation_shadow`), merged to `integration`. EXP-0054
  counts from the first session at or after this acceptance in which that code runs on the host.
- Nothing about any shadow attempt's outcome had been computed or seen when this was accepted.

### 2026-11-25: HYP-0072 is switched on in place of HYP-0071

The owner switched the rotation rule on in chat on 2026-11-25 (New York; 26 Nov in Sydney), choosing "Switch rotation
on now" on a decision card that recommended waiting for the 10 sessions of shadow counts this record sets. Shown first:
HYP-0071's three sessions on the host (23, 24 and 25 Nov), each ending `no_signal` with a primary and no valid or
reached order (25 Nov: 2 tier-2 names, 0 shadow changes). The 24 Nov primary was shut all day by the first-minute
volume must; the owner was advised against loosening that must and did not.

**What this note changes:**

- `S.switched_on` is `[HYP-0072]` (config/risk.yaml), in place of `[HYP-0071]`, in one pull request with this note.
- **The 10-session wait is waived** by the owner: the shadow ran 2 counted sessions (24 and 25 Nov). This is the
  owner's choice against the (set here) point above, recorded as such. No outcome of any shadow attempt was computed
  or shown: there was none to show.
- `wt.live.runner_s` trades the rule: the day's tier-2 names are journaled once (`gap_names`); each minute
  `rotation_walk` (the shadow's own walk, unchanged) says which one order rests, and the desk's one resting order
  follows it in that name, replaced after a confirmed cancel (`rotation_live` rows). The first closed bar in the
  resting name to reach its trigger spends the day. Every order still passes `gap_stage`, the spread must, the collar,
  the quote-age and clock gates and the size; the exit, the 11:00 end, one trade a day, the book, the day stop and
  the stop rule are HYP-0071's. The shadow does not run while HYP-0072 trades.
- **DEC-0073's X4** (off-rule entry) reads a day with a `gap_names` row as allowing any of that row's tier-2 names,
  once. Another name, or a second entry, still latches the desk. Nothing else in DEC-0073 changes.
- Trades are booked with trial HYP-0072 and the dashboard's Gap Hunter block counts both gap trials' sessions and
  trades. HYP-0071's sample ends here with 3 sessions and no trade, reported as it stands.
- Not yet done: the DEC-0074 cost haircut report (`wt.risk.cost_haircut`) still reads HYP-0071's trades only. A
  follow-up adds HYP-0072 beside it; it gates nothing.

**When it takes effect:** once merged into `integration`, carried to `main` by a Release PR the owner merges, and
deployed to the host. Until then the host keeps trading HYP-0071 with the shadow beside it. The 26 Nov holiday means
the first possible session is 27 Nov (a half day; the entry windows end at 11:00, before its close).

**Risk taken, stated plainly:** lower-ranked names may carry a weaker edge than the primary, and resting whichever
name has a valid order first can lean toward the fastest, noisiest names. The book's 1% risk, the day stop and the
-6.0R stop rule are the limits on that; HYP-0072 is judged on its own trades from here.
