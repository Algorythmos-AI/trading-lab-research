# DEC-0036: The crypto desk is closed; family C ends at its twelve trials and its challengers

- **Status: ACCEPTED on 2026-10-24.** The owner chose to close the desk on 2026-10-24, asked directly, from
  three options (close it; finish the cutover to `crypto-lab`; leave it running). The merge of the pull request
  that carries this line accepts it.
- **Date drafted:** 2026-10-24, from results already on record. No new experiment was run and no P&L was
  viewed to write it: every number below is quoted from a report that already exists in `research/experiments/`
  or from the desk's own challenger ledger on the host, as the nightly job prints it.
- **Amends:** DEC-0012 (the desk's pre-registration), DEC-0014 (paper incubation), DEC-0015 (the tournament),
  DEC-0016 (the learning charter), DEC-0019, DEC-0020, DEC-0025, DEC-0027 (the data harvest): each stays as the
  record of what was done; none governs a running desk after this.
- **Trials:** none added. Family C closes at the count `config/trial_registry.yaml` already holds: 12 registered
  trials (DEC-0012 4, DEC-0015 7, DEC-0019 8, DEC-0020 11, DEC-0025 12) plus the challengers the learning charter
  allowed (DEC-0016: 60; used by the nightly job as it ran, every one failed).

## What the record says

The question DEC-0012 asked: does any rule on the crypto desk show a statistically robust edge after costs, on
paper, on public market data? Gate C1 is the backtest after costs with the deflated Sharpe over the family's
trial count (DEC-0012, section "Gates"). `research/CRYPTO_SUMMARY.md` (2026-10-09) answered "no" for every
registered rule; nothing since has changed that answer.

| Trial | Record | Experiment | Trades | Mean R after costs | Verdict |
|---|---|---|---|---|---|
| TREND | DEC-0015 | EXP-0016 | 360 | -0.163 | fails C1 |
| BREAK | DEC-0015 | EXP-0016 | 346 | -0.147 | fails C1 |
| DIP | DEC-0015 | EXP-0016 | 87 | -0.336 | fails C1 |
| The three under desk-wide limits | DEC-0019 | EXP-0020 | 663 | -0.138 (desk) | not a gate |
| Resting-limit entries, per sleeve | DEC-0020 | EXP-0021 | signal level | -0.03, -0.02, -0.18 | all fail the screen |
| TREND with ranked entries | DEC-0025 | EXP-0022 | 366 | -0.154 | fails C1 |

The nightly challenger job (DEC-0016, DEC-0021) kept running after the summary. Its ledger on the host
(`var/crypto/sleeves/challengers.json`) holds six challengers, every one `failed` on C1 (deflated Sharpe, the
confidence interval not above zero at 1.5x slippage, no better than random entries, profit factor below one);
none `passed`, none went `live`. On 2026-10-24 the job's own line reads: "6 registered in all {registered: 0,
failed: 6, passed: 0, live: 0, retired: 0}; best current sleeve break (-0.160R)".

The paper incubation of DEC-0014 ran throughout on the lab's own simulator against Kraken public data. It
produced no evidence that counts: DEC-0014 says paper trades of a rule that has not passed C1 "count toward
no gate", and no rule passed C1.

## Decision

1. **The desk is closed.** Family C takes no further trial and no further challenger. The question of
   DEC-0012 is answered, for the rules it registered and the spans it named: no.
2. **Nothing of it runs anywhere.** The four crypto jobs (`crypto`, `dashboard-crypto`, `crypto-challengers`,
   `crypto-learn`) leave `src/wt/ops/schedule.py` and the host's units; the kill file `var/crypto/KILL` and the
   moved-marker guard of ADR 0005 §7 (`var/crypto.MOVED`) are the stop until that release is installed.
3. **The cutover to `crypto-lab` does not happen.** The extraction of 2026-10-11 (`crypto-lab` at the
   monorepo's c8d92e1) is kept as it is and the repository is archived with its README saying so. Standing up a
   host for a desk whose every rule failed its gate buys no evidence.
4. **The record stays.** `research/decisions/DEC-0012..0027`, `research/experiments/EXP-0016, 0020, 0021, 0022`,
   `research/CRYPTO_SUMMARY.md` and the challenger ledger are not deleted or rewritten. The desk's code leaves
   the tree in a second pull request after the jobs are gone; git history keeps it.
5. **The dashboard says closed.** The crypto pages become one static page that states this record, and
   `/api/health` reports the desk's state as `closed` (the state word of `dashboard/src/lib/desks.json`).
6. **Lessons kept.** LL-0003 (cost in R) and LL-0004 (weights for overlapping trades) came from this desk and
   stay in `research/lessons_learned/`.

## What would reopen it

A new pre-registration (a new DEC with its own hypotheses, spans and trial budget), written before any backtest
is run, on data the desk has not already searched. Nothing in this record forbids that; it ends this family.
