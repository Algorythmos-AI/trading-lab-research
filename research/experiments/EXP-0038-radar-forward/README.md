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

**2026-11-19, later the same day, still before the build for session 2026-11-19 fired.** The build and catch-up
prompts gained one rule: a ping to the outside alarm that is blocked or fails is skipped and never stops a run. A
read-only test had shown the permission check refusing such a ping. Nothing else in either prompt changed. A read-only
alarm, `trig_017rvGF2Bh77bxogHs7So2RV` (09:35 New York), pages the owner when a session's evidence is missing; it
writes nothing.

| Routine | Prompt sha256 from this change |
|---|---|
| `trig_01PW2UvCBejb4UxCEB58PEVp` (build) | `f3b07073c315d9b4e20c46b3b3d45daf531586dc6f40dedf170714ec391b3e3a` |
| `trig_015qsK3nrRQgscNZh6strL4F` (catch-up) | `7f5212176a00dee795f23313d167cac7491f8b76dc15aff40eab87374a2f64e4` |

**2026-11-19, 08:05 UTC, still before the build for session 2026-11-19 fired. A change to what the build reads.** At
the owner's instruction the build and catch-up prompts gained an optional news read: a fixed read-only script,
`radar_news.py` (sha256 `d4b62ed33e028d5d106a4cc2a8932fa1b6ae939dc91557a9f54eea89a8cc550b`, kept with the routines,
outside the skill bundle), lists dated items from Alpaca's market-data news feed. Each item is a lead: the prompt
requires the event to be confirmed at its linked source and that source to be cited. A failed or blocked read never
stops a run. Headline and article text stay out of the edition sent to the dashboard. Until now the build's news came
from web research and the Stocklake connector, which was not available to the new threads on this date.

- This widens the routine's inputs from this session on. DEC-0055 already says the Radar's picks are not a fixed
  procedure; this entry dates the change so the read can split sessions before and after it.
- **For the owner to decide:** `AGENTS.md` describes the Radar as research from public sources. The feed is a licensed
  one that points at public sources; whether that wording should change is the owner's call.

| Routine | Prompt sha256 from this change |
|---|---|
| `trig_01PW2UvCBejb4UxCEB58PEVp` (build) | `705cebe0810b87cafa55e30811293773502d2f761c38f602d628606ca23e24b0` |
| `trig_015qsK3nrRQgscNZh6strL4F` (catch-up) | `e968d0fa141ff8b7f4f0448fb8de073c527f364fcb3fdd79c648e9a5c5c304ac` |

**2026-11-19, 11:45 UTC, after the build for session 2026-11-19 and before the one for 2026-11-20. The news rule
is tightened (prompt v4).** The first build under the news read ran both reads (about 150 market items, 30 symbol
items). Two feed leads reached the edition. Neither was confirmed at its source, and one of them was the reason a
name left a list and went on the avoid list. Both were printed as NOT VERIFIED. At the owner's instruction:

- A lead not confirmed at its source may no longer add, remove or move a name on a list or the avoid list, or change
  a ranking. It may appear only in the research notes, marked NOT VERIFIED.
- Each run prints the count line of both reads, and the report carries one line with the counts and which leads were
  and were not confirmed.
- Session 2026-11-19 is the only one built under the looser v3 wording.

| Routine | Prompt sha256 from this change |
|---|---|
| `trig_01PW2UvCBejb4UxCEB58PEVp` (build) | `fd70b4358e7f7e792daa78a6072dc6cec166d1f7333ff82bcb47d083ea492171` |
| `trig_015qsK3nrRQgscNZh6strL4F` (catch-up) | `4720e66409a8484ba9b8f66bb647cbb42d591d54e0115d69849a58756afee905` |

## Results

None. Written once, by the read.
