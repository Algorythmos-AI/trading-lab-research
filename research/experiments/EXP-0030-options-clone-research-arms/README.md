# EXP-0030: research arms on the options clone, tagged and virtual, forward on paper

- Decision: DEC-0041. Trials: HYP-0034 to HYP-0047, family O (21 to 35).
- **Design only.** Nothing here is a result. No arm exists in code yet, no trade has been tagged and no virtual trade
  booked when this was written; no backtest or replay of any arm was run.
- Control: EXP-0029, unchanged. Job `paper-o` on the host, `config/options_clone.yaml` and `config/risk.yaml` key `O`
  as frozen by DEC-0040. The arms place no order and change none of the control's decisions.
- Start: the first session run by a release that writes the arm's tags or virtual trades (`research_arms:` on), for
  each arm. Never backfilled. An arm stops, with whatever it has, if EXP-0029's config changes.
- Close without a verdict: **2027-11-05**, for any trial that has not reached its count.

## Arms

| Trial | Hypothesis | Kind | Base | Compared |
|---|---|---|---|---|
| OC-NTZ-RETEST, OC-NTZ-REJECT | HYP-0034, HYP-0035 | tag | retest, rejection | the rest minus tagged |
| OC-GAP-RETEST, OC-GAP-REJECT | HYP-0036, HYP-0037 | tag | retest, rejection | the rest minus tagged |
| OC-LEADER-RETEST, OC-LEADER-REJECT | HYP-0038, HYP-0039 | tag, QQQ only | retest, rejection | the rest minus tagged |
| OC-IVGATE-RETEST, OC-IVGATE-REJECT | HYP-0040, HYP-0041 | tag | retest, rejection | the rest minus tagged |
| OC-EARLY-RETEST, OC-EARLY-REJECT | HYP-0042, HYP-0043 | tag | retest, rejection | early minus late |
| OC-RUNNER-RETEST, OC-RUNNER-REJECT | HYP-0044, HYP-0045 | shadow, paired | retest, rejection | runner minus control, per trade |
| OC-TRAP | HYP-0046 | shadow | new setup `trap` | its own mean |
| OC-RECLAIM-FAST | HYP-0047 | shadow | new setup `reclaim_fast` | its own mean |

The exact rule and every number of each arm are in its hypothesis record (`statement:` and `frozen:`).

## Data

- Tags: one field per arm in each row of the runner's per-session decision log (`decisions/<session>.jsonl` in its
  state folder on the host), written at the decision, beside the gates. A trade inherits the tags of the decision
  that opened it.
- Virtual trades: their own append-only file, written by `wt.options.shadow`, never the clone's journal or ledger.
- Trades: every control `trade_closed` row of EXP-0029 inside an arm's window, split by setup with
  `wt.options.review.trial_of`. Trades booked `unresolved` are left out and counted.
- Unit: return on premium after $0.03 a contract each way (a virtual exit is priced at the bid).

## Verdict

- The test of DEC-0030 section 6, resampled by session, on the quantity in the table: at least 30 trades (for a tag
  arm, in each group) and 20 sessions. A trial is falsified if the lower end of the 95% bootstrap range is at or
  below 0, or the quantity is at or below 0 in either half of the trades in order.
- Each report is written once, by a verdict script added with the arms' code, into this folder. It refuses to write
  over an existing report. No split of the control's trades by tag and no shadow result is read before it.
- A pass changes no rule. A number changed after a result is seen means a new experiment and new trials.

## Booking stopped by DEC-0059 (appended 2026-11-18, before any affected result is read)

- Counting ended at the 2026-11-17 session: DEC-0056 point 6 changed EXP-0029's config from the 2026-11-18 session,
  which ends every arm under DEC-0041 point 5, with at most 9 sessions; each closes with no verdict on 2027-11-05.
- DEC-0059 ends the booking (`research_arms.enabled: false`) and shows each arm on the Paper options page only up to
  2026-11-17. The verdict script and its rules are unchanged.
