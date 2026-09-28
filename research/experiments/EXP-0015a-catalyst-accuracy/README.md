# EXP-0015a — Catalyst classifier accuracy (SPEC-0001, CAT-01)

**Status: pending owner review.** Not a strategy trial; no P&L involved.

| Step | Result |
|---|---|
| Sample 1 | 100 dev-span headlines, seed 15, stratified; `sample_blind.csv` |
| Classifier v2 on sample 1 | 67% exact, **74% decision level**, below the ≥ 85% target (`report_v2.md`) |
| One allowed revision → v3 | Category-level fixes (see `config/catalysts_spec.yaml` header); in-sample on sample 1: 92% decision level (optimistic, because it's in-sample) |
| Sample 2 (fresh) | 50 dev-span headlines, seed 1502, excluding sample 1; `sample2_sample_blind.csv` |
| **Classifier v3 on sample 2** | 76% exact, **82% decision level** against Claude's blind labels. Below target on these labels. n = 50, so the 95% CI is roughly 71–93% |
| Owner review | https://claude.ai/artifact/PntX9yqHQ3QGDzFmLL9QpB. Covers 20 blind labels (10 from sample 2, 10 from sample 1) and 19 disagreements; answers are stored in that page's `labels` collection |

- **Reference-label precedence:** owner review > owner blind > Claude (`scripts/exp0015a_catalyst_score.py`).
- **Known structural limit:** keywords can't tell the acquirer from the target in "X to acquire Y" headlines (S2H002). Fixing this needs the symbol's company name, which would be a new pre-registered change, not part of this experiment.
