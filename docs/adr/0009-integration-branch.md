# ADR 0009: Work lands on integration; main is production

- **Status:** accepted on merge by the owner.
- **Context:** the owner asked for an integration branch as the default, with `main` kept for production.

## Context

Every pull request went straight to `main`, and a merge to `main` is a production release twice over: the
dashboard workflow deploys lab.algorythmos.com on the push (decision of 2026-09-29), and the host's hourly gated
deploy takes the green tip of `main` (ADR 0008). On 17 October seven dashboard pull requests merged in one day,
each a production deploy, from several sessions working at once. Nothing showed the combined change before it was
live, and there was no point at which the owner chose what went out.

## Decision

1. **Two long-lived branches.** `integration` is the default branch and takes all work. `main` is production.
2. **Work.** Short-lived branches (`feat/`, `fix/`, `options/`, `ops/`, `docs/`, `research/`) are cut from
   `integration` and squash-merged into it after `test` and `dashboard-gate` pass. Dependabot targets it too.
3. **Staging.** A push to `integration` that touches the dashboard deploys a Vercel preview in fixture mode and
   points staging.lab.algorythmos.com at it, through a `staging` GitHub Environment that admits only
   `integration`. Preview deployments refuse ingest and fixture mode serves the synthetic fixtures, so staging
   holds no production data (the reason PR previews were removed). The host never runs `integration`.
4. **Releases.** One Release PR from `integration` to `main`, merged by the owner with a merge commit after the
   US close. The merge commit keeps both branches on one history, so the next release has no conflicts.
5. **Hotfixes.** `hotfix/<what>` from `main`, a PR into `main`, then a PR from `main` back into `integration`,
   merged with a merge commit.
6. **Rules.** A ruleset on each branch: pull request required, no force push, no deletion, required checks
   `test` and `dashboard-gate`. `main` also requires `release-source` (release.yml), which fails unless the pull
   request comes from `integration` or `hotfix/*` in this repository, and allows merge commits only. Head
   branches are deleted after merge.

## What does not change

- The production deploy job, the host's deploy (`wt.ops.deploy` still takes only green commits on `main`), and
  its gate.
- The publishers. Radar, journal, options and snapshot editions are data sent to production's ingest, not code,
  and keep going there.
- The commit rules (D-016).

## Consequences

- A change reaches production one release later than before. A fault in production goes through a hotfix.
- Back-merges and Release PRs are opened with the Claude GitHub app rather than a workflow: pull requests opened
  with the workflow token do not trigger the required checks.
- Undo: make `main` the default again and disable the `integration` ruleset; production is untouched throughout.
