# Glossary

The project has renamed things as it went, so one thing can have several names in code, records and pages. This
page maps each alias to the thing it means. Records are cited by ID only; read the record for the reasoning.

## Desks and robots

| Name used now | Aliases you will meet | What it is | Code | Job | State |
|---|---|---|---|---|---|
| **Gap Hunter** | stock desk, stocks desk, sleeve S, Robot B sleeve S, paper-s, smallcap, strategy `S` | The stock desk's paper session (DEC-0066; its live page is DEC-0078, PROPOSED on 2026-11-25) | `src/wt/live/runner_s.py`, `src/wt/scanner/gap_hunter.py`, `src/wt/live/scan_s.py` | `paper-s`, `gap-hunter-publish` | `var/smallcap/`, journal `data/live/smallcap_journal.jsonl` |
| **Options clone** | the clone, options desk runner, paper-o, runner_o, strategy `O` | Paper options trading on the clone account (DEC-0030 and later) | `src/wt/live/runner_o.py`, `src/wt/oms/options.py`, `src/wt/options/` | `paper-o`, `options-review` | `var/options/`, journal `data/live/options_journal.jsonl` |
| **Research arms** | arms | Tagged or virtual variants run beside the clone, only with `research_arms.enabled` in `config/options_clone.yaml`; the control is unchanged (DEC-0041) | `src/wt/options/setups.py` (`tag_decision`), `src/wt/options/shadow.py`, `src/wt/options/arms_verdict.py` | inside `paper-o` | `var/options/shadow/` |
| **QQQ rule** (retired) | strategy B, Paper B, paper-b, Robot B, B_intraday_momentum | The first paper rule, retired by DEC-0069. Its runner is still in the package | `src/wt/live/runner_b.py` | none (`paper-b` is in `ARCHIVED_JOBS`, `src/wt/ops/jobs.py`) | `data/live/journal.jsonl`, `data/live/virtual_account.json` |
| **Crypto desk** (closed) | desk `C`, crypto | Closed by DEC-0036; its code was deleted (ADR 0005 addendum). `src/wt/core/desk.py` still lists it | — | none | — |

"Robot B" once named the QQQ rule and later the desk that holds sleeve S. Say **Gap Hunter** or **QQQ rule**.
There is no "QQQ account": QQQ is a ticker ([paper-accounts.md](../runbooks/paper-accounts.md)).

## Accounts

There are three Alpaca **paper** accounts: "Robot B stocks (host)" (`APCA_API_*`, market data only), "Clone options
(host)" (`APCA_CLONE_*`) and "Gap Hunter" (`APCA_S_*`). See [paper-accounts.md](../runbooks/paper-accounts.md).
`APCA_OPTIONS_*` is a legacy pair. The code still falls back to it when `APCA_CLONE_*` is missing
(`src/wt/brokers/alpaca_options_paper.py`).

## Owner's desk and research pipeline

| Term | Meaning |
|---|---|
| **Options desk** | The owner's own options page on the dashboard (`/options`): advisory trade states for the owner's hand trades (DEC-0042). It places no order |
| **Trade now board / board** | The Options desk's board of trade states (DEC-0042, DEC-0050) |
| **Focus names** | The session's few names for the Options desk, picked outside this repository and only annotated here |
| **Radar** | The owner's pre-market research from public sources, shown on `/radar`. PRIVATE, behind the owner's login ([AGENTS.md](../../AGENTS.md), "Data classes") |
| **Radar → Options selection** | The 06:45 New York shadow selection that lets Radar candidates into the Options desk's universe through a fail-closed gate (DEC-0070, job `options-select`) |
| **Funnel** | The selection funnel in the private `trading-options-funnel` repository. It sends only counts, statuses, dates and hashes to the Operations page |
| **Options lab / lab tape** | The recorder of the focus names' option tape on the host (DEC-0060; jobs `lab-tape`, `lab-archive-check`; `src/wt/lab/`) |
| **Reference Registry** | The dashboard's index of the research records (`/research/records`), built in CI by `registry.yml` |

## Gates and research words

| Term | Meaning |
|---|---|
| **G1** | The first research gate: did anything show a robust edge after costs ([research/G1_SUMMARY.md](../../research/G1_SUMMARY.md)) |
| **G2** | The paper-evidence gate for the QQQ rule: trades, sessions, replay match and incident-free sessions, thresholds in `config/dashboard.yaml` (`src/wt/analytics/g2.py`). Its subject is retired |
| **HYP / EXP / DEC / LL** | Hypothesis, experiment, decision and lesson records in `research/` ([research/README.md](../../research/README.md)) |
| **Pre-registration** | A hypothesis, experiment and decision are written before any affected P&L is viewed ([AGENTS.md](../../AGENTS.md), rule 2) |
| **Holdout** | An evaluation run once per frozen config |
| **DSR / trial registry** | The deflated Sharpe ratio counts every experiment as a trial; the counts are in `config/trial_registry.yaml` |

## Operations words

| Term | Meaning |
|---|---|
| **The host** | The GCP VM `trading-lab-host`, where every scheduled job runs ([gcp-host.md](../runbooks/gcp-host.md)) |
| **Live checkout** | `/home/wt/trading` on the host. Production. It changes only through the gated deploy |
| **Gate** | The computed window in which the live checkout may change (`src/wt/ops/window.py`; `make gate`) |
| **AUTO_ON** | The owner's file `var/deploy/AUTO_ON` that switches on the hourly automatic deploy (ADR 0008) |
| **KILL** | A desk's kill file: no new entries while it exists. There is one per desk ([safety.md](../operations/safety.md)) |
| **Latch** | A loss limit that stops entries until the owner clears it ([safety.md](../operations/safety.md)) |
| **Lease** | The primary-host lease that lets a host trade (`src/wt/ops/lease.py`; [backups-and-lease.md](../runbooks/backups-and-lease.md)) |
| **Shadow host** | A host with `WT_ROLE=shadow`. Gap Hunter's broker refuses every order there; the clone does not read the role ([safety.md](../operations/safety.md)) |
