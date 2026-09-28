# EXP-0015a — Catalyst classifier accuracy: classifier v3 on sample1

- **Sample:** 100 dev-span headlines (see `manifest.json`).
- **Reference labels:** claude 90, owner_blind 10.
- **Headline-level exact accuracy:** **89%**.
- **Decision-level accuracy** (qualifying / excluded / non-qualifying, which is what the scanner uses): **94%**. Target ≥ 85%: **PASS**.
- **Claude vs owner on the owner's blind items:** 80% (10 items).
- **Classifier vs Claude disagreements:** 13 (the owner review queue: `disagreements_v3.csv`).

## Confusion matrix (rows = reference label, columns = classifier)

| reference \ classifier | breaking_news | buyout_offer | clinical_study_results | earnings_release | fda_approval | hype_only | none | offering_dilution | price_target_upgrade | unconfirmed_rumor |
|---|---|---|---|---|---|---|---|---|---|---|
| breaking_news | 13 |  |  | 1 |  | 1 |  |  |  |  |
| buyout_offer |  | 1 |  |  |  |  |  |  |  |  |
| clinical_study_results |  |  | 10 |  |  |  | 1 |  |  |  |
| earnings_release |  |  |  | 11 |  |  |  |  |  |  |
| fda_approval |  |  |  |  | 8 |  |  |  |  |  |
| hype_only | 1 |  |  |  |  | 5 | 3 |  |  |  |
| none | 1 |  |  |  |  | 1 | 30 |  |  |  |
| offering_dilution |  |  |  |  |  |  |  | 1 |  |  |
| price_target_upgrade |  |  |  |  |  | 1 |  |  | 6 |  |
| unconfirmed_rumor |  |  |  |  |  | 1 |  |  |  | 4 |
