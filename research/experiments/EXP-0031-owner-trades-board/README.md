# EXP-0031: the owner's own option positions, labelled by the board, forward

- Decision: DEC-0045. Trials: HYP-0048 to HYP-0050, family M (new, total 3).
- **Design only.** Nothing here is a result. No label exists in code yet, no position has been labelled and no split
  of the owner's results by label, caution or window has been worked out or viewed when this was written.
- Every frozen value is in `config.yaml`: the position grouping, the unit (R25 and R50, net of the owner's fees of
  $0.55 a contract to open and $0.56 to close, and before fees beside them), the labels and how the replay builds
  its inputs, the engine's frozen numbers, the window, the gate, the generator, the seed and the exclusions.
- Start: the first New York session after the release that first writes labels reaches production. Before that
  release no one runs the labeller on the owner's journal. Never backfilled.
- Close: **2027-11-11**, or earlier as `config.yaml` says. A trial short of its minimums when read closes
  inconclusive.

## Trials

Every difference is a minus b.

| Trial | Hypothesis | Among | Compared (a minus b) |
|---|---|---|---|
| OWN-ONPLAN | HYP-0048 | focus names with a record | on-plan (in_zone, early) minus off_plan |
| OWN-CAUTION | HYP-0049 | on-plan | no DEC-0042 caution and no unknown check minus at least one caution |
| OWN-EARLY | HYP-0050 | on-plan, full sessions | mid window 10:00 to 11:30 minus open window 09:35 to 10:00 |

OWN-EARLY is named for the open window it questions; it tests late minus early.

## Data

- Positions: the owner's journal, long call and put pieces grouped into positions as `config.yaml` says.
- Labels: the end-of-day replay of each session's stored edition and settled 2-minute IEX bars through a frozen copy
  of the desk's engine, whose `ENGINE_VERSION` is a content hash of its files in the release that first writes
  labels. Labels are written once per session and never worked out again. Not the live server log of DEC-0044.

## Verdict

- Read once, by a verdict script added with the code, at the first of: both groups at 150 positions, the window
  ending, or the close date. It writes its report into this folder and refuses to write over an existing one.
- Only the verdict script computes group statistics; the site shows its report after the verdict. A pass changes
  nothing on the desk by itself.
