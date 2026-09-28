# EXP-0015a — Catalyst classifier accuracy (SPEC-0001, CAT-01)

**Status: complete (2026-09-29). CAT-01 recorded as a FAIL: 84% decision level on the fresh sample 2 against the 85% target. Owner blind labels in (20/20); disagreement verdicts in (19/19).** Not a strategy trial; no P&L involved. The owner chose to proceed with round 3 as written (DEC-0010, which lists the classifier's accuracy as an accepted limitation).

| Step | Result |
|---|---|
| Sample 1 | 100 dev-span headlines, seed 15, stratified; `sample_blind.csv` |
| Classifier v2 on sample 1 | 67% exact, **74% decision level**, below the ≥ 85% target (`report_v2.md`) |
| One allowed revision → v3 | Category-level fixes (see `config/catalysts_spec.yaml` header); in-sample on sample 1: 92% decision level (optimistic, because it's in-sample) |
| Sample 2 (fresh) | 50 dev-span headlines, seed 1502, excluding sample 1; `sample2_sample_blind.csv` |
| **Classifier v3 on sample 2** | 76% exact, **82% decision level** against Claude's blind labels. Below target on these labels. n = 50, so the 95% CI is roughly 71–93% |
| Owner review | https://claude.ai/artifact/PntX9yqHQ3QGDzFmLL9QpB. Covers 20 blind labels (10 from sample 2, 10 from sample 1) and 19 disagreements; answers are stored in that page's `labels` collection |
| Owner blind labels (2026-09-28) | 20/20 in: `owner_blind_labels.csv`, `sample2_owner_blind_labels.csv` |
| Owner disagreement verdicts (2026-09-29) | 19/19 in, exported from the review page: `owner_review.csv` (10, sample 1), `sample2_owner_review.csv` (9, sample 2) |
| Agreement on the owner's 20 blind items (decision level) | Classifier vs owner **85%** (17/20; misses H041, S2H002, S2H034). Claude vs owner **80%** (16/20; misses H020, H033, S2H034, S2H047). Claude's labels are therefore a noisy reference for the unreviewed items |
| **Classifier v3 on sample 2, final (owner verdicts > owner blind > Claude)** | 76% exact, **84% decision level (42/50): FAIL** against the 85% target (`sample2_report_v3.md`). All 8 misses are judged against the owner's own labels (6 verdicts, 2 blind labels). The owner sided against the classifier on all six decisive items |
| Classifier v3 on sample 1, final | 92% exact, 95% decision level. In-sample (v3 was revised on sample 1), so it can't decide CAT-01 (`report_v3.md`) |
| Pattern in the sample-2 misses | Company announcements called `none` (S2H024 vaccine development, S2H036 buyback, S2H043 "shares spike after PR"); SPAC commentary called `unconfirmed_rumor` (S2H025, S2H032); hype called `breaking_news` (S2H004); acquirer/target confusion (S2H002); an internal-review statement called `buyout_offer` (S2H034) |

- **Reference-label precedence:** owner review > owner blind > Claude (`scripts/exp0015a_catalyst_score.py`).
- **Known structural limit:** keywords can't tell the acquirer from the target in "X to acquire Y" headlines (S2H002). Fixing this needs the symbol's company name, which would be a new pre-registered change, not part of this experiment.
