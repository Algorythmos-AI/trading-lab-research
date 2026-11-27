# DEC-0082: measure classifier v3 on fiscal.ai headlines before relying on it further

- **Status: ACCEPTED on 2026-11-27.** The owner accepted it by merging the pull request that changed this line
  from PROPOSED (2026-11-27), with the owner readings as set below. The sampler and scorer come next, in their own
  pull request (point 9); nothing in EXP-0058 is sampled or labelled before that pull request merges.
- **What it settles:**
  - how v3's accuracy on the news source DEC-0068 now reads is measured;
  - what each outcome does.
- **What it changes:** no live rule, no gate, no trial and no live job. DEC-0068 runs as it does.
- **Depends on:** DEC-0068 (the funnel that reads v3), DEC-0081 (fiscal.ai as the forward source), DEC-0010 (the
  holdout, and v3's accuracy as an accepted limitation), EXP-0015a (v3 on Benzinga).
- **Records:** HYP-0075 and EXP-0058 (`research/experiments/EXP-0058-v3-on-fiscal/config.yaml`).

## Why

- **The live rule reads v3 on fiscal.ai.** DEC-0068's catalyst step reads classifier v3's category for each pool name's
  headlines. Since 2026-04-29 those headlines are fiscal.ai items, not Benzinga (DEC-0081).
- **v3 was measured on Benzinga only.** EXP-0015a scored it at 84% at the decision level, against CAT-01's 85% target.
  DEC-0010 accepted that as a known limitation.
- **fiscal.ai is a different feed,** with its own sources and wording. So the 84% may not carry over, in either
  direction.
- **The only measurement so far is indirect.** EXP-0057 compared SEC filings with v3's readings of these headlines.
  That measured agreement with v3, not v3's accuracy, and it took v3 as the reference.

## Decision

1. **Classifier v3 is frozen for this test.** The test reads `config/catalysts_spec.yaml` version 3 by its sha256,
   and the sampler refuses any other file. v3 is not revised inside this experiment. A v4 would be a new record with
   a fresh sample.
2. **The frame is post-holdout only.**
   - **Sessions:** the 43 sessions 2026-09-28 to 2026-11-25. The holdout (DEC-0010) ends 2026-09-25.
   - **Items:** fiscal.ai items in the private archive whose symbols include a name in that session's pool.
   - **Window:** from 16:00 on the previous session to the 09:25 cut, with `created_at` no later than the cut. That
     is what the pool could see.
   - **Repeats:** syndicated repeats count once per session (normalised headline), and the lowest id is kept.
3. **The sample.** 100 items, seed 5801, stratified by v3's category: up to 9 per category first, then the rest at
   random from what is left. The headline figure is the stratified sample's decision-level agreement, comparable
   with EXP-0015a. Three figures are reported only:
   - exact-category agreement;
   - the population-weighted decision-level figure;
   - the per-category confusion counts.
4. **Reference labels**, highest precedence first:
   - **owner review:** the owner's ruling on every item where v3 and the best label so far disagree at the decision
     level;
   - **owner blind:** 30 items drawn by the same seed, which the owner labels without seeing any other label;
   - **agent blind:** all 100 items, labelled by the agent labeller from the blind file only, before the key is
     opened.
5. **The labeller check.** Where v3 and the agent labeller agree, no owner review is triggered, so an error the two
   share would count as correct. The 30 owner-blind items guard against that.
   - **The check:** the agent labeller must agree with the owner on at least 0.85 of them, at the decision level.
     Below that, the mixed reference is not trusted.
   - **The owner-only figure:** v3 against the owner on the same 30 items, with its Wilson interval. It is reported
     with the verdict.
6. **The verdict** (decision level is qualifying, excluded or non-qualifying, as `wt.scanner.catalyst` defines it):
   - **Pass:** agreement of at least 0.85 on at least 80 items with a reference label, and a labeller check of at
     least 0.85.
   - **Fail:** below 0.85 on at least 80 items, and a labeller check of at least 0.85.
   - **Not decidable:** fewer than 80 items with a reference label, or a labeller check below 0.85.
   - **The figure:** the Wilson 95% interval is reported with it. The verdict reads the point figure, as CAT-01 did.
7. **What each outcome does.** No live rule changes on any of them.
   - **Pass:** DEC-0068 gets a dated note giving the measured figure.
   - **Fail:** DEC-0068 gets a dated note giving the figure and the pattern of the misses. Whether to revise the
     classifier (v4) is then a new record. DEC-0010's acceptance of the limitation stands until such a record says
     otherwise.
   - **Not decidable:** the owner decides by a dated note here.
8. **No headline text enters this repository.** Headlines are RESTRICTED, and this repository is public.
   - **Private:** the blind file, the key, both label files and the review are kept in the private
     `trading-news-archive` repository under `experiments/EXP-0058/`.
   - **Public:** `research/experiments/EXP-0058-v3-on-fiscal/` gets only item ids, sha256 sums of the private files,
     counts and the report.
   - **EXP-0015a:** it committed its sample files with headline text. This record does not repeat that, and leaves
     those files for the owner to decide on.
9. **Code comes after acceptance and before the draw.** A sampler and a scorer, each with tests, come in their own
   pull request. Nothing is drawn until that pull request is merged.

## Owner readings (each is his to change before acceptance)

1. **The frame (set here): post-holdout only.** Buyouts will be thin. EXP-0057 found 14 v3 buyout name-days across
   all 146 sessions, so the 43 forward sessions hold only a few. The alternative is to add 2026-04-30 to 2026-09-25.
   That means reading headline text from the holdout span, which DEC-0081's reading did not cover.
2. **The target and size (set here):**
   - 0.85 at the decision level, CAT-01's target;
   - 100 items;
   - at least 80 labelled.
3. **The owner's labelling load (set here):** 30 blind items, plus a ruling on each disagreement. In EXP-0015a the
   rulings came to 9 to 10 per sample.
   - **Why 30:** the labeller check needs enough items to catch shared errors.
   - **Residual risk:** an error v3 and the agent share on items outside those 30 still goes unreviewed. The
     labeller check bounds that risk; it does not remove it.
   - **The alternative:** owner labels for all 100. That costs more and leaves no shared-error gap. Labelling is done in a local file in the private repository. The alternative is a hosted
   review page, as EXP-0015a used, which would put the headlines on a page outside the repositories.
4. **The licence:** DEC-0081's open question about keeping fiscal.ai text in a private repository covers this sample
   too.

## Disclosure (what was seen before this record)

- **EXP-0015a in full:** v3's misses on Benzinga and their pattern.
- **EXP-0057's counts on fiscal.ai** (146 sessions): v3 found 14 buyout name-days and 719 earnings name-days. The
  presence agreement with SEC filings was also seen. Those counts were not split by the 43 forward sessions.
- **Not seen:**
  - any fiscal.ai headline text, for this record or EXP-0057;
  - any v3 category tally for this frame;
  - any accuracy figure for v3 on fiscal.ai.

## Dated notes

### 2026-11-27: the owner hands his labelling slots to an independent expert agent (owner's note)

The owner did not label the 30 owner-blind items. On 2026-11-27 he asked for an independent expert agent to fill the
owner's slots in point 4, and the agent labeller set one up. This note records the change before any label is
compared with v3.

- **What changes:**
  - **Owner blind:** the 30 owner-blind items are labelled by an independent expert agent.
    - It was started fresh, with no access to the agent labeller's labels, v3's output, the key or the keyword file.
    - It saw only the 30 items, a category guide and the owner's own EXP-0015a labels and rulings, which were its
      calibration.
  - **Owner review:** the rulings on disagreements are made by an expert agent, which sees each item's v3 category
    and best label, as the owner would.
  - **The report:** `owner_slots.json` in the private folder says who filled the slots, and the scorer refuses to
    score without it. The report names the filler, and its JSON fields name the slots by role (`v3_vs_owner_slot`,
    `owner_slot_blind`, `owner_slot_review`), not as the owner's.
- **What this costs:**
  - **The labeller check no longer bounds shared error as point 5 intended.** It now compares two AI labellers. An
    error both make, such as one from the same model family or from the category guide, which the agent labeller
    wrote, passes unseen. It still catches errors the two do not share.
  - **v3 against the expert alone** is an agent-only figure, not an owner figure.
- **How the verdict is read:** the thresholds in point 6 are unchanged.
  - **What is added:** the result is reported as **agent-referenced**. A pass or a fail does not carry the owner's
    reading.
  - **DEC-0068:** the dated note it gets under point 7 says so.
  - **Upgrading the result:** the owner may still rule on any item himself, and a later record may ask him to label
    the 30.
- **One input error, corrected:** the expert's first input file was cut wrongly by the agent labeller, which
  truncated three headlines that contain commas (F022, F029, F049). The expert found the fault itself. It then
  relabelled from a corrected file that was checked against the source; no label changed.
- **Where its labels are:** `expert_blind_labels.csv` in the private folder. They are copied into the owner-blind
  slot only after this note is merged.
- **Disclosure:** the agent labeller labelled all 100 items before this note (private repository commit cd622dc). No
  label has been compared with v3's category, and the key has not been opened.
