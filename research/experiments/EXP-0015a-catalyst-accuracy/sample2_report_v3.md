# EXP-0015a — Catalyst classifier accuracy: classifier v3 on sample2

- **Sample:** 50 dev-span headlines (see `sample2_manifest.json`).
- **Reference labels:** owner_blind 10, claude 40.
- **Headline-level exact accuracy:** **76%**.
- **Decision-level accuracy** (qualifying / excluded / non-qualifying, which is what the scanner uses): **84%**. Target ≥ 85%: **FAIL**.
- **Claude vs owner on the owner's blind items:** 80% (10 items).
- **Classifier vs Claude disagreements:** 12 (the owner review queue: `sample2_disagreements_v3.csv`).

## Confusion matrix (rows = reference label, columns = classifier)

| reference \ classifier | breaking_news | buyout_offer | clinical_study_results | earnings_release | fda_approval | hype_only | none | offering_dilution | price_target_upgrade | unconfirmed_rumor |
|---|---|---|---|---|---|---|---|---|---|---|
| breaking_news | 3 | 1 |  |  |  |  | 3 |  |  |  |
| buyout_offer | 1 |  |  |  |  |  |  |  |  |  |
| clinical_study_results |  |  | 4 |  | 1 |  |  |  |  |  |
| earnings_release |  |  |  | 6 |  |  |  |  |  |  |
| fda_approval |  |  | 1 | 1 | 3 |  |  |  |  |  |
| hype_only | 1 |  |  |  |  | 4 |  |  |  |  |
| none |  |  |  |  |  |  | 9 |  |  | 2 |
| offering_dilution |  |  |  |  |  |  |  | 1 |  |  |
| price_target_upgrade |  |  |  |  |  |  |  |  | 6 |  |
| unconfirmed_rumor |  | 1 |  |  |  |  |  |  |  | 2 |
