# Research registry: institutional memory

Every hypothesis, experiment, decision and lesson is a file here, in git. No strategy parameter, threshold or
evaluation rule changes without a record. The experiments are also the **global trial count** used by the deflated
Sharpe ratio, kept in `config/trial_registry.yaml` (DEC-0005; `src/wt/research/trials.py`).

Counts on `integration`, 2026-11-25:

| Kind | Folder | Files | Highest id |
|---|---|---|---|
| Hypotheses | `hypotheses/` | 73 | HYP-0073 |
| Decisions | `decisions/` | 79 | DEC-0080 |
| Experiments | `experiments/` | 59 folders, plus 3 combined G1 files | EXP-0056 |
| Lessons learned | `lessons_learned/` | 6 | LL-0006 |

Where things stand now: the dashboard's Reference Registry (`/research/records`, owner only). For history, see
[`G1_SUMMARY.md`](G1_SUMMARY.md) (the stocks research gate, which predates DEC-0069) and
[`CRYPTO_SUMMARY.md`](CRYPTO_SUMMARY.md) (the crypto desk, closed by DEC-0036).

## Layout

```
research/
 ├── hypotheses/          HYP-NNNN-<slug>.yaml      what we expect, and why, written before any test
 ├── experiments/         EXP-NNNN-<slug>/          one folder per run (contents below); immutable once run
 ├── decisions/           DEC-NNNN-<slug>.md        what was decided, by whom, on which experiments; a Status line
 ├── lessons_learned/     LL-NNNN-<slug>.md         post-mortems
 ├── active_strategies/   <id>.yaml                 the frozen strategy configs the code reads
 ├── retired_strategies/  README.md                 every strategy a decision ended, and why
 ├── forward/             the forward test's scorecards and archive
 ├── specs/               RESTRICTED: the specification the rules are tested against (NOTICE.md)
 └── external/            RESTRICTED: outside traders' posts, studied for ideas (NOTICE.md)
```

Slugs are lower-case words in older records and UPPER_CODES in newer ones (`HYP-0071-GAP_HUNTER_FUNNEL`); both are
valid.

## Ids

- Ids are sequential within a kind and never reused. The grammar is `(DEC|HYP|EXP|LL)-NNNN`, with an optional
  lower-case letter for a variant of an experiment (`EXP-0005b`, `EXP-0015a`), and `EXP-DEBUG-NNNN` for plumbing
  runs that count as no trial (`src/wt/research/registry.py`, `_ID`).
- A number taken and then given up stays as a "not used" record: EXP-0001, EXP-0004, DEC-0013, and ADR 0003 in
  `docs/adr/`.
- **Gaps on 2026-11-25:** DEC-0048 and EXP-0049 have no file. Other records cite both, so treat them as reserved:
  never reuse either number.
- Before you number a new record, read `origin/integration` and the open pull requests, and say in your pull request
  which ids you take ([AGENTS.md](../AGENTS.md), rule 3). Several sessions number records at once.

## What an experiment folder holds

The contents vary with the experiment's age. There is no single required set:

| File | In how many of the 59 | What it is |
|---|---|---|
| `README.md` | 34 | The plan and the pre-registration, written before the run |
| `config.yaml` | 23 | The frozen configuration the run used |
| `report.md` | 18 | The write-up. RESTRICTED: never published |
| `results.json` / `result.json` | 17 / 9 | Machine-readable results (both spellings are in use) |

A holdout is run once per frozen config and named for it (for example `EXP-0011-holdout-B-qqqm`).

## Rules

1. **Pre-registration.** A hypothesis, an experiment and a decision come before any affected P&L is viewed
   ([AGENTS.md](../AGENTS.md), rule 2).
2. **Append only.** An experiment is never re-run under its own id; a re-run gets a new EXP id and counts as a trial.
3. **A strategy changes only through records:** a hypothesis, at least one experiment, and a decision that cites
   them.
4. **Owner approvals** are recorded in the decision's Status line (`ACCEPTED on <date>`, often with
   `approved_by: owner`). The statuses the registry reads are `accepted`, `proposed`, `withdrawn`, `superseded`,
   `not_used`, `in_effect` and `recorded` (`DEC_STATUSES` in `src/wt/research/registry.py`).
5. **Data classes.** Record titles and prose are the RECORD class: they may appear only on the owner-only Reference
   Registry, never in issues, logs or alerts. `report.md`, `specs/` and `external/` are RESTRICTED
   ([AGENTS.md](../AGENTS.md), "Data classes").

## Tooling

| Tool | What it does |
|---|---|
| `make research-index` (`scripts/research_index.py`) | Prints every experiment with its decision, span, data hash, result hash and the commit that added it. Printed, never committed |
| `src/wt/research/registry.py`, `scripts/build_registry.py` | Build the Reference Registry's index from the records |
| `.github/workflows/registry.yml` | On every push to `main` and `integration`, builds that index and sends it, signed, to the dashboard. It prints counts and hashes only ([dashboard/README.md](../dashboard/README.md), "Reference Registry") |
| `src/wt/research/trials.py` | Reads the trial counts in `config/trial_registry.yaml` |

A record the registry cannot parse shows up as an issue on the Reference Registry page (two experiment configs did
on 2026-11-25, fixed in #650). Before you push a new record, build the index locally (it sends nothing):
`PYTHONPATH=src .venv/bin/python scripts/build_registry.py build --branch integration --sha $(git rev-parse HEAD) --out /tmp/registry.json`.
