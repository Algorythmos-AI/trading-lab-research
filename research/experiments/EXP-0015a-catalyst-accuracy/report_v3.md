# EXP-0015a — Catalyst classifier accuracy: classifier v3 on sample1

- **Sample:** 100 dev-span headlines (see `manifest.json`).
- **Reference labels:** claude 80, owner_blind 10, owner_review 10.
- **Headline-level exact accuracy:** **92%**.
- **Decision-level accuracy** (qualifying / excluded / non-qualifying, which is what the scanner uses): **95%**. Target ≥ 85%: **PASS**.
- **Claude vs owner on the owner's blind items:** 80% (10 items).
- **Classifier vs Claude disagreements:** 13 (the owner review queue: `disagreements_v3.csv`).

## Confusion matrix (rows = reference label, columns = classifier)

| reference \ classifier | breaking_news | buyout_offer | clinical_study_results | earnings_release | fda_approval | hype_only | none | offering_dilution | price_target_upgrade | unconfirmed_rumor |
|---|---|---|---|---|---|---|---|---|---|---|
| breaking_news | 14 |  |  |  |  | 1 |  |  |  |  |
| buyout_offer |  | 1 |  |  |  |  |  |  |  |  |
| clinical_study_results |  |  | 10 |  |  |  | 1 |  |  |  |
| earnings_release |  |  |  | 12 |  |  |  |  |  |  |
| fda_approval |  |  |  |  | 8 |  |  |  |  |  |
| hype_only |  |  |  |  |  | 6 | 3 |  |  |  |
| none | 1 |  |  |  |  |  | 30 |  |  |  |
| offering_dilution |  |  |  |  |  |  |  | 1 |  |  |
| price_target_upgrade |  |  |  |  |  | 1 |  |  | 6 |  |
| unconfirmed_rumor |  |  |  |  |  | 1 |  |  |  | 4 |
