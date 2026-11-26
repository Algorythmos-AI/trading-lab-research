# Trading Lab docs: start here

This is the index to the project's documentation. Each topic has **one** canonical page, listed here. Other pages
link to that page instead of repeating it.

## One source of truth

- **The code is the truth for what runs.** A page that describes code names the file it comes from. When code and a
  page disagree, the code wins: fix the page in the same pull request.
- **Tests keep the indexes honest.** `tests/unit/test_docs_truth.py` fails when a link breaks, when a runbook or ADR
  is missing from its index, when a doc names a `make` target that does not exist, when the job table, unit list or
  package map drifts from the code, or when the code reads an environment variable that
  [env-vars.md](reference/env-vars.md) does not list.
- **Host state is dated.** Facts about the live host that code cannot show (its size, which keys it holds, whether
  `AUTO_ON` exists) say when and how they were checked, or are marked *unverified*.
- **The repository is public** (checked 2026-11-25), so nothing here holds IP addresses, project or account IDs, or
  secret values. Data classes and what may be published are in [AGENTS.md](../AGENTS.md), "Data classes".

## By reader

| You are | Read, in order |
|---|---|
| **New engineer** | [README](../README.md) → [architecture](architecture.md) → [glossary](reference/glossary.md) → [jobs](operations/jobs.md) → [deploy](operations/deploy.md) → [safety](operations/safety.md) → [ADRs](adr/README.md) → [research registry](../research/README.md) |
| **Automated contributor (agent)** | [AGENTS.md](../AGENTS.md) (rules first) → this page → [architecture](architecture.md) → [deploy](operations/deploy.md) → [CI](reference/ci.md) → [safety](operations/safety.md) → the newest [release record](releases/README.md) |
| **On call** | [Runbooks](runbooks/README.md) → [kill switch and flatten](runbooks/kill-and-flatten.md) → [safety](operations/safety.md) → [jobs](operations/jobs.md) → [host](operations/host.md) |

## By topic

| Topic | Canonical page |
|---|---|
| Rules for contributors, data classes | [AGENTS.md](../AGENTS.md) |
| The whole system on one page: pieces, data flow, runtime state, the package map | [architecture.md](architecture.md) |
| Names and aliases (desks, robots, jobs, gates) | [reference/glossary.md](reference/glossary.md) |
| Paper-only lock, kill switches, latches, flatten | [operations/safety.md](operations/safety.md) |
| The host: what it is, users, secrets flow, helpers | [operations/host.md](operations/host.md) |
| The host: provision, secrets, resize, rebuild (procedures) | [runbooks/gcp-host.md](runbooks/gcp-host.md) |
| Every scheduled job and host unit | [operations/jobs.md](operations/jobs.md) |
| Branches, release, deploy, rollback | [operations/deploy.md](operations/deploy.md) |
| Environment variables and where each is set | [reference/env-vars.md](reference/env-vars.md) |
| CI workflows and required checks | [reference/ci.md](reference/ci.md) |
| What each config file is, and whether it is frozen | [config/README.md](../config/README.md) |
| Incidents and tasks, one page each | [runbooks/README.md](runbooks/README.md) |
| Why things are the way they are | [adr/README.md](adr/README.md) |
| What went to `main`, and when | [releases/README.md](releases/README.md) |
| Past incidents | [incidents/README.md](incidents/README.md) |
| Point-in-time audits | [audits/](audits/) |
| Point-in-time data discovery notes (what a source can stand in for, checked before a record) | [notes/](notes/) |
| Research records and their rules | [research/README.md](../research/README.md) |
| The dashboard | [dashboard/README.md](../dashboard/README.md) |
| Security, the public-repository exception | [SECURITY.md](../SECURITY.md), [NOTICE.md](../NOTICE.md) |
