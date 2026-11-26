# EXP-0057 phase 1: EDGAR proxy against classifier v3 on fiscal.ai headlines

- Sessions 2026-04-30 to 2026-11-25 with a pool and its sidecar: 146. Counts only.
- **Verdict: not_decidable** (recall at least 80% on at least 20 name-days, each). This is agreement with classifier v3 on fiscal.ai headlines, not accuracy.
- Name-days 7833; unknown (dropped) 67; compared 7766.

| Measure | Value |
|---|---|
| Buyout recall (the test) | 21.4% (3 of 14; Wilson 95% 7.6% to 47.6%) |
| Earnings recall (the test) | 74.5% (536 of 719; Wilson 95% 71.2% to 77.6%) |
| Buyout precision | 8.6% (3 of 35; Wilson 95% 3.0% to 22.4%) |
| Earnings precision | 75.5% (536 of 710; Wilson 95% 72.2% to 78.5%) |
| Presence agreement | 75.6% (5868 of 7766; Wilson 95% 74.6% to 76.5%) |
| Median lag, first qualifying headline to earnings filing (minutes) | -74.11666666666666 (n 536) |
