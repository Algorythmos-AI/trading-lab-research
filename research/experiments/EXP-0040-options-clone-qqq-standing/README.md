# EXP-0040: the options clone with QQQ as a standing name, forward on paper

- **Decision:** DEC-0058.
- **Trials:** HYP-0029 (`retest`), HYP-0030 (`rejection`) and HYP-0031 (`nearest`), each run again under the new
  names as a new trial. Family O goes from 44 to 47.
- **Design only.** Nothing here is a result, and no session under the new rule existed when this was written.
- **The report is written once,** when a trial reaches 30 trades and 20 sessions, by:

  ```
  scripts/options_clone_verdict.py --rules qqq --trials retest,rejection,nearest \
      --out research/experiments/EXP-0040-options-clone-qqq-standing
  ```

  The script refuses to write over an existing report. Until then the nightly review shows trade and session counts
  only.
- **Start: 2026-11-19** (`wt.options.review.QQQ_START`). Trades up to 2026-11-18 stay in EXP-0039 and earlier.
- **Run:** job `paper-o` on the host, with `config/options_clone.yaml` and `config/risk.yaml` key `O`, as frozen by
  DEC-0039, DEC-0040, DEC-0056 and DEC-0058:
  - the focus names, then QQQ every session (`names.standing`), outside `max_names`;
  - the top-up and expiry rules unchanged;
  - the contract floors and caps as in EXP-0039.

  Every other rule is unchanged.
- **Trades, ledger, unit, verdict and exclusions:** as EXP-0028.
- A number changed after a result is seen means a new experiment and new trials.

## Amended by DEC-0058 (appended 2026-11-18, before any trade of that session was viewed)

- **Start: 2026-11-18** (`wt.options.review.QQQ_START`), not 2026-11-19. The rule reached the host before that
  session; DEC-0058's amendment gives the evidence.
- Trades up to 2026-11-17 stay in EXP-0029 and earlier. Every other line above is unchanged.
