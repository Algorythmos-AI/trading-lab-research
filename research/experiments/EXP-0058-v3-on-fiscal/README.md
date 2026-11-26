# EXP-0058: does classifier v3 read fiscal.ai headlines as well as it read Benzinga?

- **Records:** decision DEC-0082 (ACCEPTED on 2026-11-27) and hypothesis HYP-0075 (pre-registered on 2026-11-27).
  This is a measurement, not a trial: no family, no R, no P&L.
- **Frozen:** `config.yaml`, together with DEC-0082, before any headline in the frame is read. A changed value is a
  new experiment.
- **Why:** since 2026-04-29 the only news Alpaca serves is fiscal.ai (DEC-0081). DEC-0068's live funnel reads that
  news through classifier v3. EXP-0015a measured v3 only on Benzinga (84% at the decision level, CAT-01 FAIL against
  85%). Nobody has measured it on fiscal.ai.
- **The sample:** 100 headlines, stratified by v3's category. They are fiscal.ai items for pool names in the pool's
  window (16:00 the previous session to the 09:25 cut), on the 43 post-holdout sessions 2026-09-28..11-25.
- **Labels:**
  - the agent labeller labels all 100 blind;
  - the owner labels 30 of them blind;
  - the owner then rules on every decision-level disagreement;
  - precedence: owner review, then owner blind, then agent blind.
- **The labeller check:** the agent labeller must match the owner on at least 0.85 of the 30 owner-blind items.
  Agreements between v3 and the agent are not reviewed, so shared errors would otherwise count as correct.
- **The verdict:** decision-level agreement on the stratified sample, with a Wilson 95% interval. It passes at ≥ 0.85
  on at least 80 labelled items, fails below that, and is not decidable under 80 or when the labeller check falls
  below 0.85. v3's agreement with the owner alone, on the 30, is reported beside it.
- **Where the text lives:** headlines are RESTRICTED and this repository is public. The blind file, the key and every
  label file stay in the private `trading-news-archive` repository. This folder gets only item ids, sha256 sums,
  counts and the report.
- **Code:** not written yet. A sampler and a scorer come in a later PR, after DEC-0082 is accepted and before any
  headline is drawn.
