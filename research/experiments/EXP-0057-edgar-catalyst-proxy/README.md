# EXP-0057: can SEC filings stand in for the lost 2019–2025 headlines?

- **Records:** decision DEC-0081 and hypothesis HYP-0074, proposed on 2026-11-26; DEC-0081 ACCEPTED on 2026-11-26.
  This is a measurement, not a trial: no family, no R, no P&L.
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
- **Code (step 4, built before any count):**
  - `wt.scanner.edgar_catalyst`: the table as pure functions, with the window, the map check and the pool columns;
  - `wt.data.edgar_roles`: the subject role of a shared deal filing, read from its EDGAR index page and cached in
    `data/edgar/roles.json`;
  - `scripts/annotate_edgar.py`: writes sidecars `data/candidates_edgar/DATE.parquet`. It never touches the pools,
    checking their sha256 sums before and after, and prints no category tally;
  - `scripts/exp0057_overlap.py` with `wt.research.exp0057`: the phase-1 report, counts only. It refuses to run
    while DEC-0081 is not ACCEPTED or outside the frozen span.
  - `wt.data.edgar_events` keeps SC TO-C and SC14D9C and records its forms in `data/edgar/events_meta.json`. The
    annotator refuses a store built without them.
- **Running phase 1, once DEC-0081 is accepted:**
  1. Bring the pools for 2026-04-30 to 2026-11-25 to the Mac: copy the host's forward pools read-only, and build
     the rest with `scripts/build_pool.py`.
  2. Run `scripts/annotate_edgar.py 2026-04-30 2026-11-25`.
  3. Run `scripts/exp0057_overlap.py 2026-04-30 2026-11-25`, then commit its two report files by pull request.
- **Results:** `phase1_report.json` and `phase1_report.md` here, then `phase2_counts.json` here, each added by its own
  pull request.

## Phase 1 result (run once on 2026-11-26, integration 6c0e45af)

- **Verdict: not_decidable**, by the frozen rule. Buyout recall had 14 name-days, below the minimum of 20. The
  report is `phase1_report.json` and `.md`, both written by `scripts/exp0057_overlap.py` and committed unedited.
- **Earnings:** recall was 74.5% (536 of 719; Wilson 95% 71.2%–77.6%). That is below the 0.80 threshold on far more
  than 20 name-days, so the earnings half would fail even if the buyout half could be decided.
- **Buyout:** recall was 21.4% (3 of 14) and precision 8.6% (3 of 35).
- **Lag:** the report's lag is filing time minus headline time. Its median of −74 minutes means the earnings filing
  is usually accepted about 74 minutes before the first qualifying headline.
- **What follows:** phase 2 does not run. By DEC-0081, a result other than pass leaves the next step to the owner.
  This experiment is closed; any change to the table or the thresholds is a new EXP id.
