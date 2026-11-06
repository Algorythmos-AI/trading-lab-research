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
