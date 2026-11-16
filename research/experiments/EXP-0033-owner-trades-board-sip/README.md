# EXP-0033: the owner's own option positions, labelled by the board on SIP, forward

- Decision: DEC-0050. Trials: HYP-0056 to HYP-0058, family M (total 6 with EXP-0031's three).
- **Design only.** Nothing here is a result. No label exists in code yet, on any feed, and no split of the owner's
  results by label, caution or window has been worked out or viewed when this was written.
- **EXP-0031's three questions asked again on SIP.** Every frozen value in `config.yaml` is EXP-0031's (DEC-0045 as
  amended by DEC-0049) except the feed (SIP bars asked for by name), the start, the early ends (none gives a
  verdict), the board-feed rule, the labeller rules, the seed (20261112) and the close date.
- Start: the first New York session after the release that first writes this experiment's labels reaches
  production. That release waits for the cutover note (DEC-0050 point 1). Before it no one runs the labeller on the
  owner's journal. Never backfilled.
- Close: **2027-11-12**, or earlier as `config.yaml` says.

## Trials

Every difference is a minus b.

| Trial | Hypothesis | Among | Compared (a minus b) |
|---|---|---|---|
| OWN-ONPLAN-SIP | HYP-0056 | focus names with a record | on-plan (in_zone, early) minus off_plan |
| OWN-CAUTION-SIP | HYP-0057 | on-plan | no DEC-0042 caution and no unknown check minus at least one caution |
| OWN-EARLY-SIP | HYP-0058 | on-plan, full sessions | mid window 10:00 to 11:30 minus open window 09:35 to 10:00 |

## Data

- Positions: the owner's journal, grouped exactly as EXP-0031's `config.yaml` says.
- Labels: the end-of-day replay of each session's stored edition and settled 2-minute **SIP** bars through a frozen
  copy of the desk's engine. Labels are written once per buy fill and never worked out again. No IEX bar is read for
  a label here.
- The board-feed stamps (DEC-0050 point 4, `config.yaml` `board_feed`) decide the feed. Any stamp after the start
  reading other than `sip`, a stamp gap over 10 minutes with a deployment change across it, or a broken stamp chain
  ends the window without a verdict. A position with neither a `sip` stamp in the 2 minutes before it nor `sip` stamps either side of it
  (`feed_unknown`), or
  just after a 10-minute run without a SIP answer (`board_off`), is `no_record` and counted.
- Cutover session (the first regular session whose stamps all read `sip`): not yet (DEC-0050 point 1; the date goes here).
- Board-feed stamp first running in production: not yet (DEC-0050 point 4; the date goes here).
- Switches away from SIP (rollbacks) and back: none (each one gets a dated line here and a dated note on DEC-0050).
- Entry alerts first switched on in production: not yet (as DEC-0049 point 8 sets it for EXP-0031; the date goes
  here).
- Signal words (DEC-0051) first shown on the page in production: not yet (DEC-0051 section 5; the date goes here).
  This is a dated note only, not one of the early ends in `config.yaml`: seeing signals can change which trades the
  owner takes, and the date lets a reader see it.

## Verdict

- Read once, by a verdict script added with the code, at the first of: both groups at 150 positions, the window
  ending, or the close date. It writes its report into this folder and refuses to write over an existing one.
- Only the verdict script computes group statistics. The site shows its report after the verdict. A pass changes
  nothing on the desk by itself.

## Note on DEC-0052 (added 2026-11-17)

DEC-0052, proposed on 2026-11-17, amends config.yaml frozen_numbers before this experiment's window starts, once it
is accepted: the retest touch becomes the clone's (RETEST_WITHIN_ATR 1.0 two-minute ATR and a confirming close), and
RETEST_ATR (0.1) is the card's stop band only. The frozen copy's hash is not pinned yet, so nothing else changes. The
in_zone label then covers one slot after a confirming close, which narrows what HYP-0056 measures. The text above is
otherwise unchanged.

Viewed before this note: one owner trade entered on the board's old retest and its result, the clone's decision lines for that session, and the clone's cumulative HYP-0029 figures (DEC-0052, "What has already been seen").
