# config/

The configuration that the code and the research read. Much of it is **frozen research configuration**. Changing
a frozen value is a strategy or evaluation change, so it needs a hypothesis, an experiment and a decision record
first ([AGENTS.md](../AGENTS.md), rule 2). Each file's own header says what freezes it. Read the header before you
edit the file.

Checked against the code at `9441a547` on 2026-11-25. "Read by" lists the main readers, found by searching the
code for the file's name.

## Trading limits and desks

| File | What it holds | Read by | Frozen? |
|---|---|---|---|
| `risk.yaml` | Hard pre-trade limits per strategy (allowlists, caps, entries per day), and each desk's switched-on rules | `wt.risk.pretrade`, `wt.core.desk`, the runners (`live/runner_s.py`, `runner_o.py`) | Yes: a limit that can block an entry changes only with a record |
| `options_clone.yaml` | The options clone's rules and parameters (DEC-0030 and later) | `wt.options.setups`, `session.py`, `dryrun.py`, `pipeline_check.py` | Yes |
| `options_desk.yaml` | The Options desk's names | `wt.options.live`, `clone_names.py`, `radar_candidates.py`, `pipeline_check.py` | By record |
| `options_universe.yaml` | The selection universe: the desk's names plus the Radar candidates that pass its gate (DEC-0070) | `wt.options.universe`, `radar_candidates.py` | By record |
| `options_select.yaml`, `options_select_stage2.yaml` | Stage 1 and stage 2 of the Options desk's selection (DEC-0046) | `wt.options.select`, `select_stage2.py`, which refuse a file holding anything else | Yes |
| `options_rules.json` | The probation rules shown on the Options page | `wt.options.live`, `scripts/options_edition.py`, `scripts/options_replication.py` | By record |
| `legacy_positions.yaml` | Positions outside the retired QQQ rule's mandate that the owner accepted as legacy | `wt.risk.mandate`, `live/runner_b.py` | Owner |

## Scanner and ranking

| File | What it holds | Read by | Frozen? |
|---|---|---|---|
| `ranking.yaml` | Pre-market ranking parameters, frozen before G1 | `wt.scanner.features`, `scripts/forward_test.py`, research drivers | Yes: a change is a logged experiment and a trial |
| `catalysts.yaml`, `catalysts_spec.yaml` | Headline keyword classifiers (the original and the specification's) | `wt.scanner.catalyst` | Yes |
| `hod_volume_curve.json` | The intraday cumulative-volume curve (HYP-0033) | `wt.live.scan_s`, `scripts/forward_test.py` | Yes |
| `generated/*.yaml` | **Generated** from `research/specs/SPEC-0001-…/spec.yaml`. Do not edit; each header names the command that regenerates it | `wt.specs.loader` | Generated |

## Calendars and events

| File | What it holds | Read by |
|---|---|---|
| `events/macro_events.csv` | Macro-event dates, types and severities | `wt.options.select`, `select_fetch.py`, `radar_select.py`, `pipeline_check.py` |
| `events/earnings.csv` | Earnings dates for the Options desk's names, kept by hand | `wt.options.edition`, `select.py`, `radar_select.py`, `pipeline_check.py` |
| `events/earnings_radar.csv` | Earnings dates for Radar-sourced names (DEC-0070) | `wt.options.radar_select`, `universe.py` |

## Research and the dashboard

| File | What it holds | Read by |
|---|---|---|
| `trial_registry.yaml` | The global trial count for the deflated Sharpe ratio (DEC-0005) | `wt.research.trials`, `wt.research.registry` |
| `dashboard.yaml` | Status dashboard configuration, including the G2 thresholds | `wt.ops.status`, `wt.ops.publish`, `wt.analytics.g2` |
| `legacy_history.json` | Monthly history shown by the status page | `wt.ops.status` |
