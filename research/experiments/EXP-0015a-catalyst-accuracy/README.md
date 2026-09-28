# EXP-0015a — Catalyst classifier accuracy (SPEC-0001, CAT-01)

**Status: owner blind labels in (20/20); disagreement verdicts pending (0/19).** Not a strategy trial; no P&L involved.

| Step | Result |
|---|---|
| Sample 1 | 100 dev-span headlines, seed 15, stratified; `sample_blind.csv` |
| Classifier v2 on sample 1 | 67% exact, **74% decision level**, below the ≥ 85% target (`report_v2.md`) |
| One allowed revision → v3 | Category-level fixes (see `config/catalysts_spec.yaml` header); in-sample on sample 1: 92% decision level (optimistic, because it's in-sample) |
| Sample 2 (fresh) | 50 dev-span headlines, seed 1502, excluding sample 1; `sample2_sample_blind.csv` |
| **Classifier v3 on sample 2** | 76% exact, **82% decision level** against Claude's blind labels. Below target on these labels. n = 50, so the 95% CI is roughly 71–93% |
| Owner review | https://claude.ai/artifact/PntX9yqHQ3QGDzFmLL9QpB. Covers 20 blind labels (10 from sample 2, 10 from sample 1) and 19 disagreements; answers are stored in that page's `labels` collection |
| Owner blind labels (2026-09-28) | 20/20 in: `owner_blind_labels.csv`, `sample2_owner_blind_labels.csv` |
| Agreement on the owner's 20 blind items (decision level) | Classifier vs owner **85%** (17/20; misses H041, S2H002, S2H034). Claude vs owner **80%** (16/20; misses H020, H033, S2H034, S2H047). Claude's labels are therefore a noisy reference for the unreviewed items |
| **Classifier v3 on sample 2, owner labels first** | 76% exact, **84% decision level** (42/50). One headline short of 85%, so it doesn't pass yet (`sample2_report_v3.md`) |
| Classifier v3 on sample 1, owner labels first | 89% exact, 94% decision level (in-sample) |
| Still open | The 19 disagreement verdicts. Six of the nine sample-2 items change the decision: S2H004, S2H024, S2H025, S2H032, S2H036 and S2H043. Each one currently counts against the classifier. If the owner sides with the classifier on any one of them, sample 2 reaches 86% |

- **Reference-label precedence:** owner review > owner blind > Claude (`scripts/exp0015a_catalyst_score.py`).
- **Known structural limit:** keywords can't tell the acquirer from the target in "X to acquire Y" headlines (S2H002). Fixing this needs the symbol's company name, which would be a new pre-registered change, not part of this experiment.
