# EXP-0035: the board's break-and-retest ENTERs under the clone's retest and under the touch it replaces, replayed once

- Decision: DEC-0052 (accepted 2026-11-17). Trial: HYP-0060 BOARD-RETEST-CONFIRMED, family O (total 37 with this
  one).
- **Design only.** Nothing has been replayed. No count or outcome of either rule on any session exists.
- **Not blind.** Before this was written, one owner trade on the old rule and the clone's cumulative HYP-0029 figures
  had been seen (DEC-0052, "What has already been seen"). The report says so beside the verdict.
- **It gates nothing.** DEC-0052 section 1 holds on consistency grounds, whatever this finds.
- Every frozen definition is in `config.yaml`: the two engines, the inputs, the outcome on the stock from the card,
  the statistics, the seed and the read.
- **Run:** once, after the board's pull request for DEC-0052 merges.
  - Before the run, the session list, the bars' sha256s and engine a's label are written below.
  - Lapses with no verdict if that pull request is not merged by 2027-02-28.

## Before the run (to be filled in, in order)

- Engine a's label and commit:
- Session list (dates; the excluded session is not named here):
- Bars fetched (date, file, sha256):

## Result

None. Written once, by the run.
