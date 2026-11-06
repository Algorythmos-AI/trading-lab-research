# DEC-0043: The owner's Options desk takes first entries from 09:35 New York, with a desk-only early caution to 10:00

- **Status: ACCEPTED on 2026-11-06.** approved_by: owner. The owner decided on 2026-11-06, reviewing the live
  Options page, that the desk's first entry is 09:35 New York, which is their own rule, and not 10:00. The merge of
  the pull request that carries this line accepts it.
- **Written before any result is viewed.** The author did not read the owner's journal results, the clone's results
  for EXP-0029 or EXP-0030, or any replay of entries between 09:35 and 10:00 while writing this record.
- **Amends DEC-0042 in one place only:** the time from which the advisory desk shows states other than no trade.
  Everything else in DEC-0042 stands. The owner's nine trade rules, the options clone (EXP-0029, frozen by DEC-0040)
  and the research arms (DEC-0041, EXP-0030) are unchanged.
- **Depends on:** DEC-0040, DEC-0041, DEC-0042.

## Why

DEC-0042's desk said "no trade" until 10:00 New York, while the owner's rules text on the same page said no entries in
the first five minutes (to 09:35). Two first-entry times on one page are a misread waiting to happen. The owner's rule
is 09:35, so the desk follows it. The clone's tested window still starts at 10:00, so entries before then are outside
what DEC-0041 tests, and the desk says so.

## Decision

1. **First entry 09:35 New York.** From the release that carries it, the desk's states (`FIRST_ENTRY_MIN`,
   `dashboard/src/lib/trade-state.ts`) begin at 09:35 New York on every session, full or half day. Before then the
   board reads "Opening range forming: first entries from 09:35 New York". The no-entry times shown on the page come
   from the same constant, in New York time.
2. **A desk-only early caution, 09:35 to 10:00.** On a full day, while the 2-minute bar forming now ends at or after
   09:35 and before 10:00 New York, a row in an active state carries the caution "Early: before 10:00". It is the
   desk's own caution, has no hypothesis id, and says that the clone's tested window starts at 10:00. Like every
   DEC-0042 caution, it never removes an entry and is never a rule break.
3. **The clone and its arms are unchanged.** The caution is computed apart from the checks that mirror the clone's
   `tag_decision` (`deskCautions`, beside `entryChecks`). DEC-0041's early window (`research_arms.tags.early_from`,
   10:00), the shared vectors (`dashboard/test/fixtures/entry-checks.vectors.json`) and their parity test
   (`tests/unit/test_entry_checks_parity.py`) stay as they are.
4. **What this does not start.** It starts no trial and adds nothing to `config/trial_registry.yaml`. Whether entries
   between 09:35 and 10:00 do better or worse is a separate question. It needs its own hypothesis and experiment,
   written before any such comparison is looked at.

## Consequences

- The board can show an entry zone from 09:35, 25 minutes earlier than before. The early caution keeps visible that
  this window is outside the clone's test.
- If a later verdict on the time arms (HYP-0042/43) bears on the early window, this record and the caution are
  revisited in the pull request that records the verdict.
