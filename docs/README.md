# Trading Lab docs: start here

This is the index to the project's documentation. Each topic has **one** canonical page, listed here. Other pages
link to that page instead of repeating it.

## One source of truth

- **The code is the truth for what runs.** A page that describes code names the file it comes from. When code and a
  page disagree, the code wins: fix the page in the same pull request.
- **Tests keep the indexes honest.** `tests/unit/test_docs_truth.py` fails when a link breaks, when a runbook or ADR
  is missing from its index, or when a doc names a `make` target that does not exist.
- **Host state is dated.** Facts about the live host that code cannot show (its size, which keys it holds, whether
  `AUTO_ON` exists) say when and how they were checked, or are marked *unverified*.
- **The repository is public** (checked 2026-11-25), so nothing here holds IP addresses, project or account IDs, or
  secret values. Data classes and what may be published are in [AGENTS.md](../AGENTS.md), "Data classes".

## By reader

| You are | Read, in order |
|---|---|
| **New engineer** | [README](../README.md) → [glossary](reference/glossary.md) → [safety](operations/safety.md) → [ADRs](adr/README.md) → [research registry](../research/README.md) |
| **Automated contributor (agent)** | [AGENTS.md](../AGENTS.md) (rules first) → this page → [safety](operations/safety.md) → the newest [release record](releases/README.md) |
| **On call** | [Runbooks](runbooks/README.md) → [kill switch and flatten](runbooks/kill-and-flatten.md) → [safety](operations/safety.md) |

## By topic

| Topic | Canonical page |
|---|---|
| Rules for contributors, data classes | [AGENTS.md](../AGENTS.md) |
| Names and aliases (desks, robots, jobs, gates) | [reference/glossary.md](reference/glossary.md) |
| Paper-only lock, kill switches, latches, flatten | [operations/safety.md](operations/safety.md) |
| The GCP host: provision, secrets, resize, rebuild | [runbooks/gcp-host.md](runbooks/gcp-host.md) |
| Incidents and tasks, one page each | [runbooks/README.md](runbooks/README.md) |
| Why things are the way they are | [adr/README.md](adr/README.md) |
| What went to `main`, and when | [releases/README.md](releases/README.md) |
| Past incidents | [incidents/README.md](incidents/README.md) |
| Point-in-time audits | [audits/](audits/) |
| Research records and their rules | [research/README.md](../research/README.md) |
| The dashboard | [dashboard/README.md](../dashboard/README.md) |
| Security, the public-repository exception | [SECURITY.md](../SECURITY.md), [NOTICE.md](../NOTICE.md) |
