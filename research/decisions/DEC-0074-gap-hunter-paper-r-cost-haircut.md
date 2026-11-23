# DEC-0074: Gap Hunter's paper R is reported beside a cost haircut fixed before its first trade

- **Status:** PROPOSED on 2026-11-23, about 04:45 ET, before Gap Hunter's first session (paper-s arms at 08:30 ET).
  The owner accepts it by merging it. The numbers marked **(set here)** are his to change before the first
  trade closes. Once a trade has closed they change only by a new record that states it was written after
  results were seen.
- **Kind:** a reporting rule. It adds a measure to EXP-0053. It changes no signal, entry, exit, stop, size, limit,
  day stop, latch, execution stop (DEC-0073) or stop line (DEC-0066 section 4). Those all keep reading the paper
  fills as journaled.
- **Trials:** none. HYP-0071 stays the only trial; the global count stays at 87 and family S at 3.
- **What has been seen:** no Gap Hunter trade exists, so no R of HYP-0071 exists. The only number from earlier
  sessions used here is a count, the fill rate behind DEC-0073's kill-power estimate.

## Why

Paper fills on US$1–20 gappers are kinder than real ones:

- the paper broker fills at the quote with no queue and no impact;
- a halt or a jump in the spread costs a real order more than it costs a paper one;
- X5 (DEC-0073) catches bad stop fills only after they happen;
- EXP-0053's execution measures compare fills with the journaled quote, but they cannot see what a real order
  would have moved.

So paper R overstates what the rule would make. At about 6 trades by 2027-03-31 (DEC-0073), no test can measure
that gap. The haircut is set now, before any trade, so it cannot be tuned to the result.

## The haircut

All costs are charged per share, on top of the paper fill.

- **The unit (set here):** `c = max(US$0.01, half the spread)`. The spread is read from the NBBO journaled with
  the trade's `entry_filled` row.
  - This is the slippage the desk and the research engine already charge: `MIN_SLIP` in `wt.live.setups_live`,
    and `slippage.half_spread` with `per_share_min_usd: 0.01` in the ranking config.
  - If that NBBO is missing, crossed or zero, `c = US$0.025`. That is half the US$0.05 spread cap the desk enters
    under, the worst spread it can have let in.
- **Base haircut, H1 (set here):**
  - `c` on every share bought;
  - `c` on every share sold by a limit or market order (the first-target sale, the exits, the flatten);
  - `2c` on every share sold by the stop order. Stops fire into fast tape, so they get the registered stop stress
    of 2.0 (M-FILL, `wt.research.method`, `stop_slip_stress`).
  - Shares sold by the stop are `qty - partial_qty` when the `trade_closed` row carries `stop_fill` (DEC-0073),
    and none otherwise.
- **Severe haircut, H2 (set here):** H1 times 2.0, the registered fill-stress multiplier
  (`slippage.stress_multipliers`).
- **Haircut R:** `R - H / (qty x (entry - stop))`, using the same `entry`, `stop` (the stop the trade entered
  with) and `qty` as the journaled R. A trade with an estimated exit, which the desk counts as -1, is charged the
  same way from -1. A trade with no positive risk (no entry price, or an entry at or under its stop; the desk
  journals its R as None) cannot be charged in R. It is left out of all three means and counted in the report.
- Everything comes from rows the desk already writes: `entry_filled` (`nbbo`) and `trade_closed` (`entry`, `stop`,
  `qty`, `R`, `partial_qty`, `stop_fill`). No journal field is added.

Example: a gap entry at US$4.00 with 12 cents of risk and a 2-cent spread has `c = US$0.01`. A full stop-out costs
`0.01 + 0.02 = 0.03` a share, which is 0.25R under H1 and 0.50R under H2.

## How it is reported

- EXP-0053 reports three numbers side by side, each as a mean R per closed trade with the 95% bootstrap interval
  (sessions resampled, as its primary measure): **paper R** (primary, unchanged), **H1 R** and **H2 R**. Beside
  them it gives the haircut's total in US$ against the realised US$.
- The weekly scorecard's stock-desk lines carry the same three means and the trade count. Counts and R only; no
  symbol, setup name or headline (AGENTS.md data classes).
- At DEC-0066's 30-trade review and at DEC-0073's date stop, the report states all three. **(set here)** The rule
  is not called profitable on paper unless the H1 interval's lower bound is above zero as well as paper R's.
  This only adds a requirement for any claim. It stops nothing, and the stop lines are unchanged.

## Not modelled

- **A halt.** A stop that fills at a halt's reopen is already in the paper fill and in X5, and the haircut adds
  only `2c`. A trade held through a halt is listed by its `trade_id` in the report.
- **Impact beyond the spread.** Orders are capped at US$700 (`S.max_notional`), at most a few hundred shares on
  names the funnel takes for their volume. If fills show otherwise, a new record sizes it.
- **Fees.** The paper broker charges no commission. The regulatory sell fees are under a tenth of a cent a share
  at these prices.

## Code

A reporting change only, in the scorecard and EXP-0053's report. It reads the journal and writes nothing to it, and
touches neither `wt.live.runner_s` nor `wt.oms`. Its tests use constructed journal rows.
