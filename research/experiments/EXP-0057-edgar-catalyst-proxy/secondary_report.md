# EXP-0057 phase 1, secondary: EDGAR proxy against classifier v3 on the 2018-12 and 2025-09 Benzinga pools

- Sessions 2018-12-01 to 2018-12-31 and 2025-09-01 to 2025-09-25 with a pool and its sidecar: 21. Counts only.
- Reported only, not part of the pass (the rule's reading would be not_decidable) (recall at least 80% on at least 20 name-days, each). This is agreement with classifier v3 on fiscal.ai headlines, not accuracy.
- Name-days 1158; unknown (dropped) 15; compared 1143.

| Measure | Value |
|---|---|
| Buyout recall (the test) | no name-days |
| Earnings recall (the test) | 40.0% (2 of 5; Wilson 95% 11.8% to 76.9%) |
| Buyout precision | 0.0% (0 of 4; Wilson 95% 0.0% to 49.0%) |
| Earnings precision | 8.0% (2 of 25; Wilson 95% 2.2% to 25.0%) |
| Presence agreement | 86.6% (990 of 1143; Wilson 95% 84.5% to 88.5%) |
| Median lag, first qualifying headline to earnings filing (minutes) | 5.583333333333333 (n 2) |
