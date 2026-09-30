# Dashboard deploys (and the watchdog drill)

**How it normally works.** Every push to `main` that touches the dashboard or its contract (`dashboard/**`,
`.github/workflows/dashboard.yml`, `src/wt/ops/publish.py`) runs the `dashboard` workflow. After the checks pass,
the `deploy (production)` job builds the site stamped with the commit (`BUILD_SHA`), deploys it, and fails unless
`/api/health` then reports that commit. Claude merges such pull requests only while `make gate` is open, because
each one is a production deploy of the only off-host dead-man's switch.

**One-time setup (owner).** Repo Settings > Environments > New environment `production`:
- Deployment branches and tags: "Selected branches and tags", add the rule `main` (type: branch).
- Environment secrets:
  - `VERCEL_TOKEN`: a Vercel token scoped to the team, with an expiry (Vercel > Account settings > Tokens).
  - `VERCEL_AUTOMATION_BYPASS_SECRET`: the same value as in `~/trading/.env`.
Without both secrets the deploy job fails on purpose ("Main is NOT deployed").

**If a deploy fails.** The previous deployment stays live. Read the failed step:
- Environment variables (not secret, but kept out of git): `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, the values
  in `dashboard/.vercel/project.json` (`orgId`, `projectId`).
- *Require the deploy secrets*: set up the Environment as above (secrets and variables), then re-run the job.
- *The live dashboard reports this commit*: Vercel may still be aliasing; re-run once. If it still fails, open
  the deployment in Vercel and promote the previous one.

**Manual deploy (owner).** `make dashboard-deploy` builds `origin/main` from a clean worktree on Vercel, stamped
with its commit. Use it when Actions is unavailable.

**Why the Mac deploy may refuse.** `make deploy` refuses while the live dashboard is older than the
dashboard/contract code it would bring (`wt.ops.dashguard`), because the dashboard rejects snapshot fields it
doesn't know. Deploy the dashboard first. To override (recorded in the deploy record):
`WT_DASHBOARD_GUARD_OVERRIDE="why this is safe" make deploy`.

**Watchdog drill.** `make watchdog-drill` sends two real pages through the production watchdog code on in-memory
state: "DRILL: Dashboard late…" (priority 4), then "DRILL: …recovered" (priority 2). Nothing stored changes.
Check both arrive on the phone. It prints `drill OK` only if both were handed to ntfy.
