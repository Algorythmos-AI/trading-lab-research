# EXP-0036: the board's break-and-retest ENTERs with and without the failed-break lock, replayed once

- Decision: DEC-0053 (accepted 2026-11-17). Trial: HYP-0061 BOARD-FAILED-BREAK-LOCK, family O (total 38 with this
  one).
- **Design only.** Nothing has been replayed. No count or outcome of either engine on any session exists.
- **Not blind.** Before this was written, one owner trade on a side the board had re-armed after a failed break, and
  that session read by DEC-0052's rule, were seen (DEC-0053, "What has already been seen"). The report says so
  beside the verdict.
- **It gates nothing by itself.** DEC-0053 section 1 holds unless the ENTERs it removes did clearly better, and then
  only the owner withdraws it, by a further record.
- **Possibly too few** (a guess, made with no count). Below the thresholds in `config.yaml` the report is an
  exploratory mark, not proof.
- Every frozen definition is in `config.yaml`: the two engines, the inputs, the groups, the outcome on the stock from
  the card, the statistics, the seed and the read.
- **Run:** once, after the release that ships DEC-0053 section 1 reaches production, on the same inputs as EXP-0035
  where they overlap.
  - Before the run, the session list, the bars' sha256s and the with-lock engine's label are written below.
  - Lapses with no verdict if that pull request is not merged by 2027-02-28.

## Before the run (to be filled in, in order)

- With-lock engine's label and commit:
- Session list (dates; the excluded session is not named here):
- Bars fetched or reused (date, file, sha256):

## Result

None. Written once, by the run.
