# DEC-0023: Stocks desk, the small-cap evidence charter: one book of record, and what may be counted

- **Status: ACCEPTED on 2026-10-08.** The owner accepts it by merging the pull request that carries this
  status line, having approved in chat a plan that names this charter and its three choices (views over the
  forward ledger; the price bands stay frozen; the US$2 to US$20 slice is counts only).
- **Governs:** how the ten round-3 trials (HYP-0010 to HYP-0019, registered by DEC-0010) are observed going
  forward. It registers no trial, changes no rule, limit, cost, gate or trial count (85 stays in force), and
  builds no simulated book.
- **Evidence it rests on:** `docs/audits/STOCKS_FORENSIC_AUDIT.md` (8 sessions, 0 forward trades in each of
  the ten trials; 0 to 3 names a day past the hard filters in the dry run; none past the chart musts).
- **Date drafted:** 2026-10-08.

## 1. The book of record

1. The forward ledger (`var/forward/forward_trades.jsonl`, written only by `scripts/forward_test.py`) is the
   book of record for the ten trials. There is no other.
2. A "book" on the dashboard or in a scorecard is a **view**: a pure function of ledger rows, by hypothesis
   id. It may show the trade count, cumulative R, drawdown in R, and nominal dollars at the registered 1% of
   US$600 per trade. It does not compound, resize, net across trials or apply any limit the trials do not
   already have.
3. No stocks code books a simulated order. `AGENTS.md` rule 1 and ADR 0005 item 4 stand as written.
4. What this evidence is: incubation, the forward half of G2 for whichever trial later passes G1. What it is
   not: proof of edge. G1 at 85 trials is unchanged and is still the only route to "proven".

## 2. Two funnel records, never merged

| Record | Where | Data it sees | Standing |
|---|---|---|---|
| As seen | `var/routine/<date>/*.json` (`stats`, `reached`) | each stage's minute, the last 15 minutes from IEX | describes the dry run only |
| Of record | `var/forward/funnel/<date>.json` | the after-close pool the trials read | describes the registered run |

They answer different questions and are not added, averaged or drawn on one chart. Agreement between them
(names in common at Tier 1 and Tier 2, the same first pick, the same signals) may be reported as counts.

## 3. Counts are free; a result is a trial

1. Counts of names at a step, of reasons, of skips and of refusals may be recorded, published (as SAFE
   class) and compared without a record.
2. The US$2 to US$20 slice is such a count. It selects nothing.
3. Any R, profit, win rate or expectancy that is **conditional on a group the registered trials do not
   define** is a new experiment: it needs an EXP id, a hypothesis if it implies a rule, and a row in
   `config/trial_registry.yaml`. Groups this covers, without limit: a price slice, a rejection reason, a tier,
   a chart must, a feed, a time of day, a catalyst class.
4. A published row never carries a setup name, a headline or a catalyst category. Trials are named by
   hypothesis or trial id.

## 4. Shadow outcomes

Not built yet; this fences them before any is computed.

1. A **signal** is a registered rule firing on a name in a registered set. A name that failed the funnel, or
   a signal that failed the spread must, is not a signal that was refused: it gets counts and its recorded
   features, and never an outcome.
2. A **shadow outcome** is the registered exit simulation applied to a signal that admission refused for
   cash or for a day stop (`unfunded`, `day_stop_consecutive_losers`, `day_stop_loss_R`). A later attempt
   whose earlier attempt was not admitted is excluded: it exists only after a trade that did not happen.
3. Shadow R is **sealed**: written beside the ledger, never in it, with only the number resolved published.
4. The seal opens once, by an experiment with its own id, and not before both hold: the round-3 evaluation
   under DEC-0010 is recorded, and 30 shadow outcomes are resolved. What it tests is declared before it runs.
5. Shadow outcomes are not training labels until a later decision says so (section 6).

## 5. Measurements, not limits

Open risk across the trials, concurrent positions and the day's realised R may be measured and shown. No
desk-wide limit, and no key in `config/risk.yaml`, is added by this record: a limit across trials changes
which trades happen, and that is new trials.

## 6. Learning

No label is built from round-3 trades, forward or historical, until the round-3 evaluation is recorded and a
decision registers the dataset. A features-only table with no outcome column may be built before then. The
holdout span (2025-09-26 to 2026-09-25) is never read for it.

## What follows

- A typed, pure view of the ledger by hypothesis id, and a board for it on the dashboard.
- The agreement counts of section 2 in the weekly scorecard.
- Nothing in this record is implemented by the pull request that carries it.
