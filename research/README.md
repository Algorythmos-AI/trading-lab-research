# Research registry — institutional memory

Every hypothesis, experiment, decision, strategy version and lesson is a file here, in git.
Nothing about strategy parameters changes without an entry. This is also the **global trial registry**
used for the Deflated Sharpe calculation (every experiment run counts as a trial).

```
research/
 ├── hypotheses/          HYP-NNNN-<slug>.yaml   what we believe and why (with KB evidence)
 ├── experiments/         EXP-NNNN-<slug>/       config.yaml + results.json + report.md (immutable once run)
 ├── decisions/           DEC-NNNN-<slug>.md     who decided what, when, based on which experiments
 ├── active_strategies/   <id>.yaml              the ONLY configs the runner may load (versioned)
 ├── retired_strategies/  <id>-vNN.yaml          superseded / failed versions, with the reason
 └── lessons_learned/     LL-NNNN-<slug>.md      post-mortems (backtest surprises, paper/live incidents)
```

## Rules
1. IDs are sequential and never reused. Experiments are append-only: re-running = new EXP id.
2. A strategy version bump requires: a hypothesis, ≥1 experiment, and a decision referencing them.
3. Holdout runs are logged as `EXP-…-holdout` and may happen **once** per frozen config.
4. Owner approvals (K0, gate passes, live switch) are recorded as decisions with `approved_by: owner`.

## Strategy version entry (example)
```yaml
strategy: S1_small_cap_momentum
strategy_version: 17
change: {rvol_min: {from: 2.0, to: 3.0}}
reason: too many false positives in 2x bucket (EXP-0041)
hypothesis: HYP-0012
experiments: [EXP-0041, EXP-0042]
result: {win_rate_delta_pct: +6.0, expectancy_R_delta: +0.04, trades_delta_pct: -31}
decision: DEC-0019
date: 2027-01-15
```
