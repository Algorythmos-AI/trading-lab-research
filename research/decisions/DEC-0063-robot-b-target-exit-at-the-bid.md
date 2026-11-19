# DEC-0063: Robot B's target exit waits for the bid and sells at the target

- **Status:** ACCEPTED, in effect since 2026-11-19. The owner merged hotfix PR #518 into `main` (f4b4ef48) and
  deployed it to the host on 2026-11-19 at 03:44 UTC: 9a6baef4 to ded833b4, deploy record
  `var/deploy/20261119T034404Z.json`, rollback tag `runtime-20261119-1`.
- **Evidence:** EXP-0048 (paper execution audit, report section 1).
- **Kind:** an execution fix in the paper runner, so that live exits match the fill model the evidence was costed
  with. It changes no rule of B: the signal, entry, stop, 2R target, size, limits, gates, latch, stop line and
  frozen config are untouched (DEC-0011 section 3; DEC-0061).

## Why

The frozen rule exits at a fixed 2R target, and the backtest fills that target when price reaches it. The paper
runner did something else (`src/wt/live/runner_b.py`, session loop):

- it fired the target exit when the QQQM **mid** of IEX's latest quote reached the target;
- it then sold at **bid − $0.01**, with no spread or age check on that quote.

A wide quote can put the mid above the target while the bid sits far below it. EXP-0048 found that both paper exits
labelled `target` to 2026-11-18 were booked about 1.8R below the target, and one of them closed 1.1 minutes after
entry. A partial stop fill averaged into the exit price is another possible cause. The records cannot tell the two
apart. The fix closes the first cause either way.

## What changes

`target_exit_limit(q, target)` in `runner_b.py`:

- The target exit waits until the **bid** is at or above the target.
- It then sells with a limit **at the target**, so it can never fill below it.
- A missing, zero or crossed quote waits.

An exit that does not fill within the order manager's timeout is cancelled and the stop is re-placed, as before.

## What it means for the record

- **Paper trades.** Trades before and after the deploy differ in how the target exit executes. The new exit
  applies from the 2026-11-19 session: the deploy landed after the 2026-11-18 close and before that session's
  runner started. Readers of the paper sample (G2b, the stop line) note it. No paper trade is
  re-scored or removed. The −3.29R to 2026-11-18 stands as booked.
- **Conservatism.** The new exit is slightly stricter than the backtest's touch fill: the backtest fills on a trade
  price at the target, while the runner now needs the bid there. It can miss a target the backtest would have
  filled, and the trade then exits by stop or flatten.
- **Verdict.** No effect on the verdict: B stays SUSPEND (DEC-0062).
- **Not included:** the half-day entry cancel (EXP-0042, `runner_b.py` after-flatten cancel), and the flatten retries
  EXP-0048 counted ("sell exceeds available"). Each would need its own record.
