# EXP-0058 report: classifier v3 on fiscal.ai headlines

- **Verdict:** **pass** (DEC-0082 point 6: pass at >= 85% on >= 80 labelled items, with the labeller check >= 85%).
- **Decision-level agreement (the figure):** 88.0% (88/100; Wilson 95% 80.2% to 93.0%).
- **Owner slots (blind labels and rulings) filled by:** an independent expert agent (DEC-0082 owner note 2026-11-27).
- **Labeller check (agent vs an independent expert agent (DEC-0082 owner note 2026-11-27), the 30 owner-blind items):** 96.7% (29/30; Wilson 95% 83.3% to 99.4%).
- **v3 vs an independent expert agent (DEC-0082 owner note 2026-11-27) alone (the same items):** 83.3% (25/30; Wilson 95% 66.4% to 92.7%).
- **Reference labels:** agent_blind 60, owner_slot_blind 25, owner_slot_review 15.

Reported only:

- exact-category agreement: 79.0% (79/100; Wilson 95% 70.0% to 85.8%);
- population-weighted decision-level agreement: 92.2%;
- confusion counts (reference label, v3 category, n):

| reference | v3 | n |
|---|---|---|
| breaking_news | breaking_news | 11 |
| breaking_news | fda_approval | 2 |
| breaking_news | hype_only | 1 |
| buyout_offer | breaking_news | 1 |
| buyout_offer | buyout_offer | 6 |
| clinical_study_results | clinical_study_results | 9 |
| clinical_study_results | none | 1 |
| earnings_release | earnings_release | 11 |
| earnings_release | fda_approval | 1 |
| fda_approval | fda_approval | 3 |
| hype_only | hype_only | 2 |
| none | breaking_news | 4 |
| none | buyout_offer | 1 |
| none | hype_only | 6 |
| none | none | 15 |
| none | price_target_upgrade | 1 |
| none | unconfirmed_rumor | 3 |
| offering_dilution | offering_dilution | 9 |
| price_target_upgrade | price_target_upgrade | 10 |
| reverse_split | reverse_split | 2 |
| unconfirmed_rumor | unconfirmed_rumor | 1 |

Benzinga reference: EXP-0015a, 84% at the decision level (CAT-01 target 85%).
