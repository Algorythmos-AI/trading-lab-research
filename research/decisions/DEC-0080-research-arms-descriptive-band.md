# DEC-0080: The Research arms page may show a descriptive session-bootstrap band on two shadow arms' own trades

- **Status: PROPOSED on 2026-11-25 (Sydney; 2026-11-24 after the close, New York).** The owner asked, through the
  session building the Research arms page, for that page's verdict section to use the real shadow-arm trades and not
  illustrative numbers, and for a record to be proposed first if one is needed. It is accepted by the owner's merge
  of a pull request that changes this line to ACCEPTED. Until then the band's code ships switched off
  (`BAND_ACCEPTED = false` in `dashboard/src/lib/research-arms-band.ts`) and shows no number.
- **NOT blind, and it cannot be.** The four shadow arms' running dollar totals and trade counts have been on the
  Paper options page since DEC-0057, and the owner saw them on 2026-11-18 (DEC-0059 "Disclosure"). What this record's
  author saw is listed in "Disclosure".
- **Not a verdict, and it changes none.** The arms ended with at most 9 sessions (DEC-0056 point 6, DEC-0059). The
  test of DEC-0030 section 6 needs 30 units and 20 sessions. Every one of the 14 trials (HYP-0034 to HYP-0047,
  EXP-0030) still closes with **no verdict on 2027-11-05**, by `wt.options.arms_verdict`, which this record does not
  change. The band is a description of a small sample, shown beside the words "not a verdict".
- **Amends** DEC-0057 point 3 in one thing only: besides the page's running figures, the Research arms page may show
  this band for the two arms below. No rule, gate, exit, limit, latch, trial, count, verdict test or close date is
  changed. Family O stays as it is.
- **Depends on:** DEC-0030 section 6 (the test), DEC-0041 (the arms), DEC-0056 (their end), DEC-0057 (the running
  figures), DEC-0059 (the 2026-11-17 cut).
- **Experiment:** EXP-0056 (descriptive; no hypothesis, no trial, no family).

## Why

The Research arms page explains how a verdict would have been reached. Explaining it on made-up numbers would put
fabricated data on a page of real records, and the owner refused that. The only real data the page holds are the
shadow arms' simulated trades in the paper options document, already shown in dollars. Drawing the registered test's
range on them is a new way of looking at a result. AGENTS rule 2 asks for a record before that is shown, and this is
that record.

## Decision

1. **Which arms.** Only HYP-0046 and HYP-0047, whose quantity is their own mean (`arms_verdict` kind `own`).
   - HYP-0044 and HYP-0045 test a paired difference against the control's real trade. The paper options document
     does not say which real trade a virtual one is paired with, so their band reads "—".
   - **Why they are left out, and why this is not a choice by result.** The reason is missing data alone. Their
     quantity cannot be worked out from the document at all, and that was decided from the document's schema before
     the band code existed. No band, mean or total of any arm was looked at in choosing. The two arms left out are
     exactly the two whose quantity needs the pairing.
   - The pull request that brings this record proposes the missing field (the paired real trade's id, or its `rop`,
     on each runner row of `arms[].trades`). Once the document carries it, a new record may band HYP-0044 and HYP-0045
     with the same method.
   - The ten tag arms stay sealed: no split of the control's trades by tag is shown, as DEC-0041 point 7 says.
2. **Which trades.** The arm's closed virtual trades in the paper options document (`arms[].trades`), of sessions up to
   **2026-11-17** only. The host already cuts there (`paper_site.arms_block`, DEC-0059 point 2), and the page cuts
   again.
3. **The unit.** Each trade's `rop` as the document carries it: the result after $0.03 a contract each way, over the
   premium paid plus one fee (`paper_site.arms_block`). This is the document's own figure. It can differ from the
   shadow file's `rop`, which `arms_verdict` reads, in the fourth decimal; the page says so.
4. **The method.** `arms_verdict.bootstrap` and `decide`, ported unchanged:
   - Group by New York session.
   - Resample whole sessions with replacement, as many as there are sessions, **5,000** times.
   - Take the mean each time; the range is the 2.5th to the 97.5th percentile, interpolated linearly as numpy's
     default does.
   - The two halves are the units in session order, split at `n // 2`.
   - With fewer than 2 sessions there is no range.
   - The generator is a fixed, seeded one in TypeScript (mulberry32, seed 7). Its draws are not numpy's, so its range
     is close to, never equal to, what the verdict script would print.
5. **What the page shows**, once accepted:
   - per arm: the mean on the premium, the range, both halves, the counts of trades and sessions against 30 and 20;
   - the label **"Descriptive, not a verdict: 9 of 20 sessions at most"**;
   - no pass or fail word, and no colour that reads as one. The page draws the band, zero, and the counts.
6. **A rule taken from it pays for it.** No rule of the clone may be chosen from this band. A record that proposes one
   must say this band was visible, and must test the rule on sessions after its own registration, with its own
   trials (DEC-0057 point 3).

## Disclosure

- **Read in writing this:** the records DEC-0030, DEC-0041, DEC-0056, DEC-0057, DEC-0059, DEC-0060, DEC-0067, EXP-0030
  and EXP-0052, and the code of `wt.options.arms_verdict`, `wt.options.paper_site` and the dashboard's Paper page.
- **Seen:** the dashboard's synthetic test fixtures, whose arm trades are invented (September and October 2026).
- **Not seen:** no production paper options document, shadow file, journal or Paper page. **No production figure of
  any arm was seen** by this record's author. The owner saw the four shadow arms' running totals and trade counts on
  2026-11-18 (DEC-0059).

## Not changed

- `wt.options.arms_verdict`, its counts, seed, method and close date, and every trial of EXP-0030.
- The paper options document, its schema, the host and the ingest.
- The clone, its config and its order path.
