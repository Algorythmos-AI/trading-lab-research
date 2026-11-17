# EXP-0038: whether the pre-market Radar's listed names beat a fixed fund from the open, forward

- Decision: DEC-0055 (proposed 2026-11-17). Trials: HYP-0065 to HYP-0067, family R (new, total 3).
- **Design only.** No session is counted and no statistic of this experiment exists.
- **Not blind.** The Radar's own scorecards (close to close, by list) were seen before this was written; DEC-0055 lists
  exactly what, with no figure.
- **The scored edition** is the first one the dashboard received for the session between the previous close and 09:30
  New York, by the store's receipt time, as the daily receipt listing sealed in trading-options-funnel records it; at the
  read the store's never-deleted copies must match that listing exactly. Counting is decided every day from the sealed
  files and sets the read date; the checks at the read only take sessions out of the analysis.
- **Desk names, GOOG, exchange-traded products (by the sealed Nasdaq Trader directory) and unknown symbols are taken
  out** for the whole window, so that nothing here is
  an outcome of a desk name while EXP-0032 is blind (DEC-0047 section 8).
- Every frozen value is in `config.yaml`. The registration lapses if the six preconditions are not all met by
  2027-02-28.

## Trials

| Trial | Hypothesis | List | Window | Compared (a minus b) | Decided by |
|---|---|---|---|---|---|
| RADAR-DAILY-1D | HYP-0065 | DAILY RADAR | open to close of S | listed names minus RSP | 2.5th percentile above 0, both halves above 0 (primary) |
| RADAR-DAILY-5D | HYP-0066 | DAILY RADAR | open of S to close of S+4 | listed names minus RSP | Holm (of two) p at or below 0.025, both halves |
| RADAR-SMALL-1D | HYP-0067 | SMALL CAP MOMENTUM | open to close of S | listed names minus IWM | Holm (of two) p at or below 0.025, both halves |

## Dates (each written by the pull request or note that records it)

- trading-options-funnel private (precondition 1): not yet.
- Radar seal step live with the skill bundle's hash and the symbol directory, first sealed edition verified
  (precondition 2): not yet.
- Dashboard keeps radar edition copies with receipt time, lists them to the research key, listing sealed daily
  (precondition 3): not yet.
- data branch protected (precondition 4): not yet.
- Analysis code frozen (precondition 5), its trading-options-funnel commit: 2026-11-17, `main` at
  `eaff05f533a55f8745b4bc83b9db53190d4e492c` (Algorythmos-AI/trading-options-funnel#9 and #10). Synthetic-data tests
  and the generator vectors of `config.yaml` pass in its CI. The read runs only from a checkout at this commit, writes
  its report once, and a re-run after a crash reads the inputs it saved.
- DEC-0055 accepted (precondition 6): not yet.
- First counted session: not yet.
- Early end, lapse or breach: none.

## Results

None. Written once, by the read.
