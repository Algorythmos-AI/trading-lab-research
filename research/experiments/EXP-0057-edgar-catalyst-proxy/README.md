# EXP-0057: can SEC filings stand in for the lost 2019–2025 headlines?

- **Records:** decision DEC-0081 and hypothesis HYP-0074, both PROPOSED on 2026-11-26. This is a measurement, not a
  trial: no family, no R, no P&L.
- **Frozen:** `config.yaml`, together with DEC-0081, before any agreement figure or count is taken. A changed value
  is a new experiment.
- **Why:** Alpaca removed the Benzinga news history (ticket 402305), so the 2019–2025 pools carry no headlines.
  DEC-0068's funnel cannot be counted on those years without a stand-in.
- **Phase 1, the test.** It covers sessions 2026-04-30 to 2026-11-25, where fiscal.ai headlines and EDGAR filings
  both exist. Per (name, session), it compares the EDGAR proxy with classifier v3's reading of the headlines:
  - buyout recall and earnings recall, with Wilson 95% intervals;
  - pass: at least 0.80 each, on at least 20 name-days each.
- **Phase 2, counts.** It runs only after a pass. It gives DEC-0068's funnel and entry counts per year on 2019-01-02 to
  2025-09-25, with the proxy in place of the headline columns. Counts only.
- **Bias stated in advance:** the proxy cannot see FDA decisions, clinical results, upgrades, rumours or other
  breaking news. So it moves names to "no headline", where DEC-0068 asks for more relative volume. Names it cannot
  read are counted as "unknown", never as "none".
- **Code (to come, step 4 of the plan):**
  - `wt.scanner.edgar_catalyst`, the table as a pure function;
  - `scripts/annotate_edgar.py`, which writes sidecars `data/candidates_edgar/DATE.parquet` and never touches the
    pools;
  - `scripts/exp0057_overlap.py`, the phase-1 report, counts only.
- **Results:** `phase1_report.json` and `phase1_report.md` here, then `phase2_counts.json` here, each added by its own
  pull request.
