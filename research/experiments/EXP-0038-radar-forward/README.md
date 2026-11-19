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

## Changes to the routines (dated; written before the first run under the change)

**2026-11-19, before the build for session 2026-11-19 fired. No session had been counted.** The Radar's build routine stopped firing on 2026-11-13: its thread had
been closed, and every later fire was refused. The editions for 16, 17 and 18 November were built by hand. The
owner approved this repair on 2026-11-19.

- **Build routine replaced.** `trig_019H1xWFsesH5mKWqMkbFhby` (prompt hash below, 10:30 UTC) is
  switched off. `trig_01PW2UvCBejb4UxCEB58PEVp` runs in its place at 05:30 New York, in a new thread, with a new
  prompt (hash below). A second routine, `trig_015qsK3nrRQgscNZh6strL4F` (06:30 and 07:30 New York,
  prompt hash below), builds only when the first did not deliver.
- **What the new prompt changes.** It decides what to do from the files and the dashboard's own listing, takes a lock
  so that two runs cannot build one session twice, never rewrites an edition file once a send was tried, and no
  longer edits the skill folder in a scheduled run. It does not change how names are chosen: the skill bundle is
  untouched, and the seal still records that bundle's sha256.
- **Late pass added.** `trig_01DC6cnD86K6UnuiJTmCTTBX` (09:05 New York, prompt hash below) runs the
  send routine's own seal and desk steps, unchanged, when an edition is on the dashboard but its evidence is not yet
  on the data branch. Its files record the send routine's id, `trig_01B1TN3d4x7dZ3Wxad2LmYgb`, as those steps do.
  The send routine itself (prompt hash below) is not changed.
- **Effect on this experiment.** None of the rules in DEC-0055 or `config.yaml` moves: the scored edition is still
  the first one the dashboard received before 09:30 New York, by the store's receipt time. Session 2026-11-18 has no
  sealed edition and stays as it is; it is not sealed after the fact.
- The full prompt texts are kept outside this repository, with the routines. Their sha256, as stored on 2026-11-19:

| Routine | Prompt sha256 |
|---|---|
| `trig_019H1xWFsesH5mKWqMkbFhby` (old build, as it ran to 13 Nov) | `73272ee8990fe60b5e44598f41f1e76c10008066ea91ad6900ffe27d4f4ae6da` |
| `trig_01PW2UvCBejb4UxCEB58PEVp` (build) | `c02b2a8328e30bd7808dd42c7d8115ca0f747dd3c4d64ef29ca3abdd43b0b3f4` |
| `trig_015qsK3nrRQgscNZh6strL4F` (catch-up) | `0d05dcec87aceef315aebd45b1fa769c35761104e4c6077256497c99ad47e9f1` |
| `trig_01DC6cnD86K6UnuiJTmCTTBX` (late pass) | `c4604d5ba4f351dbbcb088c654958d2e057486b293a18f1ba2d3759db775365c` |
| `trig_01B1TN3d4x7dZ3Wxad2LmYgb` (send, unchanged) | `fd5f6e7214b38a8777d17580359eabf358ea8286a096a58c3a0c0290e45560c2` |

## Results

None. Written once, by the read.
