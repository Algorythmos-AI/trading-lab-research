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
- **Code (DEC-0082 point 9):** `src/wt/research/exp0058.py`, with `scripts/exp0058_sample.py` (the draw) and
  `scripts/exp0058_score.py` (the review queue and the verdict), tested in `tests/unit/test_exp0058.py`.
  - **The sampler** refuses unless DEC-0082 is ACCEPTED and the classifier file is v3 by its sha256, and it draws
    once. It needs all 43 pools and a complete archive for every day of the window.
    - **Private:** it writes the blind file, the key, the owner-blind file and an empty agent-label file to the
      archive clone's `experiments/EXP-0058/`.
    - **Public:** it writes `sample_manifest.json` to this folder (ids, counts and sha256 sums only).
  - **The scorer** checks the sample against the manifest and that v3 still gives the key's categories.
    1. It scores nothing until all 100 agent labels and all 30 owner-blind labels are in and valid. Every item
       gets a label, with `none` as the fallback, so the 80-item floor does not bind in practice.
    2. It then locks both label sets (a digest of the sorted item-label pairs) and writes the owner review queue.
    3. `--final` writes `report.json` and `report.md` here, once, and only when every ruling is in.
- **Blindness:** the agent labeller reads `sample_blind.csv` only. The key and the manifest's category counts are
  not read before the labels are locked; the sampler prints no category tally. The archive keeps only an item's
  latest edit, so an item updated after its session's cut is left out of the frame (config `frame.time`: later
  edits are ignored) and counted in the manifest (`frame_left_out_edited_after_cut`).
- **Disclosure (2026-11-27):** while reading the archive's file format for this code, the agent saw one archived
  item's headline (a 2026-10-01 file, created before that session's cut). It may fall in the frame. No other
  headline text, and no v3 category tally for the frame, was seen before the draw.
- **The draw (2026-11-27, Sydney; 2026-11-26 evening in New York):** `scripts/exp0058_sample.py --publish` ran
  once, after the archive catch-up had marked 2026-11-25 done.
  - **Frame:** 880 items over 43 sessions; 100 drawn, and 30 owner-blind ids.
  - **Files:** `sample_manifest.json` is committed unedited. The private files went to `trading-news-archive`
    (`experiments/EXP-0058/`, commit 76c5382).
  - **Not yet read:** the manifest's category counts and the key, which wait until the labels are locked.
