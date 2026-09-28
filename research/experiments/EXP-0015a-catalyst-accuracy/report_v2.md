# EXP-0015a — Catalyst classifier accuracy (SPEC-0001 v2 keywords)

- **Sample:** 100 dev-span headlines (seed 15; see `manifest.json`).
- **Reference labels:** claude 100.
- **Headline-level exact accuracy:** **67%**.
- **Decision-level accuracy** (qualifying / excluded / non-qualifying, which is what the scanner uses): **74%**. Target ≥ 85%: **FAIL**.
- **Claude vs owner on the owner's blind items:** pending (owner blind labels not yet in).
- **Classifier vs Claude disagreements:** 33 (the owner review queue: `disagreements.csv`).

## Confusion matrix (rows = reference label, columns = classifier)

| reference \ classifier | breaking_news | buyout_offer | clinical_study_results | earnings_release | fda_approval | hype_only | none | offering_dilution | price_target_upgrade | unconfirmed_rumor |
|---|---|---|---|---|---|---|---|---|---|---|
| breaking_news | 8 |  |  | 1 | 1 | 1 | 4 |  |  |  |
| buyout_offer |  |  |  |  |  |  | 1 |  |  |  |
| clinical_study_results |  |  | 10 | 1 |  |  | 1 |  |  |  |
| earnings_release |  |  |  | 11 |  |  |  |  |  |  |
| fda_approval |  |  |  |  | 8 |  |  |  |  |  |
| hype_only | 1 |  |  |  |  | 6 | 2 |  |  |  |
| none | 1 |  |  | 2 | 1 | 1 | 16 |  | 7 | 4 |
| offering_dilution |  |  |  |  |  |  | 1 |  |  |  |
| price_target_upgrade |  |  |  |  |  | 1 |  |  | 6 |  |
| unconfirmed_rumor | 1 |  |  |  |  | 1 |  |  |  | 2 |
