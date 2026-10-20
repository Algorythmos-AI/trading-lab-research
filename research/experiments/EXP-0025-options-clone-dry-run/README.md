# EXP-0025: the options clone, one historical dry run on SPY and QQQ

- Decision: DEC-0031 (how it is run, written before it was run). Hypotheses: HYP-0029, HYP-0030 (family O).
- **Design only until the report exists.** `scripts/options_clone_dry_run.py` writes `report.md` and `result.json`
  here once, and refuses to write over them.
- Exploratory: it informs; it changes no number of the clone and is not evidence for DEC-0030's verdict.
