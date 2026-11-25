# From pull request to the host: branches, release, deploy, rollback

Checked against the code at `9441a547` on 2026-11-25. The deploy is `src/wt/ops/deploy.py`; the gate is
`src/wt/ops/window.py`; the host helper is `deploy/oci/bin/wt-deploy`. If they change, they are right and this page
is out of date.

## 1. Branches (ADR 0009)

| Branch | What lands there | Required checks (GitHub rulesets, read 2026-11-25) | Merged by |
|---|---|---|---|
| `integration` (default) | Squash-merged pull requests from feature branches | `test`, `dashboard-gate` | anyone allowed, after green checks |
| `main` (production) | Release PRs from `integration` and `hotfix/*` PRs, merged with a merge commit, never squashed | `test`, `dashboard-gate`, `release-source` | the owner only. Release PRs go in after the US close |

- After a hotfix merges, a PR from `main` back into `integration`, merged with a merge commit, carries it into the next
  release.
- A push to `integration` that touches those paths deploys the staging dashboard (synthetic data), only if the
  `STAGING_ENABLED` repository variable is `true` (`.github/workflows/dashboard.yml`).
- A push to `main` that touches the dashboard or its contract paths deploys the production dashboard (the same
  workflow, which filters by path). Every push to `main` or `integration` rebuilds the Reference Registry
  (`registry.yml`). Neither touches the host.

## 2. How a commit on `main` reaches the host

The host's live checkout `/home/wt/trading` changes only through `wt.ops.deploy`. It runs in one of two ways:

- **by the owner:** `sudo -u wt /usr/local/bin/wt-deploy deploy [<sha>]`;
- **by the hourly `deploy-auto` job** (ADR 0008), only while the owner's file `var/deploy/AUTO_ON` exists. Without
  that file it only logs what it would have done.

Automated contributors never start a deploy and never create or remove `AUTO_ON` ([AGENTS.md](../../AGENTS.md)).

`deploy()` takes these steps, in order. Any refusal leaves the checkout unchanged.

1. **Gate.** It refuses if the gate is closed. The gate is closed:
   - while a gated job runs or holds a lock;
   - from 07:00 New York to two hours after the close on a session day;
   - within 60 minutes of a gated job's next start;
   - whenever the exact market calendar can't be read (`window.deploy_blockers`).
2. **Checkout.** The live checkout must be on `main` with clean code (`preflight.check_git`).
3. **Target.** It runs `git fetch origin main`. The target must be on `main` and a fast-forward of the checkout
   (`resolve_target`).
4. **CI.** The target's checks must be green (`wt.ops.ci`).
   - The owner's deploy reads `WT_REQUIRED_CHECKS`, default `test`; the automatic deploy always asks for
     `ci.DEFAULT_REQUIRED`, which is `("test",)`.
   - **Neither checks `dashboard-gate` by default,** although the rulesets require it.
   - A refused GitHub token stops the deploy. The automatic deploy also pages about it, once a day.
   - The owner may pass a commit whose checks are red or unreadable with `WT_DEPLOY_CI_OVERRIDE='reason'`, for that
     one deploy. The automatic deploy never reads it.
5. **Dashboard guard.** The live dashboard must not be behind the dashboard-contract paths the target changes
   (`wt.ops.dashguard`, `deploy/contract-paths.txt`).
6. **Stage (`--stage`).** The test suite runs on the target in a throwaway worktree with its own venv:
   - selection `-m "not replay"`;
   - time limit 1800 s, or 1200 s for the automatic deploy.
   `wt-deploy` always stages. A local `make deploy` stages only with `STAGE=1`.
7. **Automatic deploy only, after the tests and before the lock:** it checks that `AUTO_ON` is still there and that the run is under 25
   minutes old (`go_on`).
8. **Switch, under the deploy lock.**
   1. Ask the gate again.
   2. Hold the non-gated jobs' locks for up to 120 s.
   3. Tag the current commit `runtime-YYYYMMDD-N`.
   4. `git merge --ff-only` to the target.
   5. Migrate runtime state (`wt.ops.migrate`).
   6. `uv pip sync` the venv.
   7. Run `pytest -m smoke`.
9. **Failure.** If the smoke test fails, it runs `git reset --hard` to the tag, re-syncs and pages at priority 4.
   If that also fails, it pages at priority 5, "Host left between two releases".
10. **Record.** A record goes to `var/deploy/`. If the deploy succeeded, `wt-deploy` then renders the units to
    `var/units` and prints "units changed" if they differ from what is installed; the owner then runs
    `sudo wt-install-units`. After a refusal or a rollback, `wt-deploy` stops before this step.

## 3. What the automatic deploy adds (`deploy.auto`)

- The gate must still be open 60 minutes from now.
- The tip of `main` must be at least 30 minutes old, because merges come in bursts.
- A target that failed on this host is tried once more after 6 h, then left until a newer commit.
- **Owner paths.** A release that changes any `OWNER_PATHS` waits for the owner and sends the "A deploy needs you"
  page. So does a host whose installed units already differ from the code. `OWNER_PATHS`:
  - `deploy/oci/bin`, `deploy/oci/systemd`;
  - `src/wt/ops/{schedule,units,deploy,jobs,ci,window,locks,dashguard}.py`;
  - `src/wt/webull`.
  A comment change in one of these counts too.
- No switch starts later than 25 minutes into the run (the job's deadline is 50 minutes).
- A release that waits more than 12 h is said once a day.

Only the *job units* rendered from `JOBS` are compared with what is installed. A drift in a static unit or helper
on the host (`deploy/oci/systemd`, `/usr/local/bin/wt-*`) is not seen by the automatic deploy.

## 4. Rollback

```bash
sudo -u wt /usr/local/bin/wt-deploy 'rollback runtime-YYYYMMDD-N'
```

This runs `make rollback TAG=…` under the same gate. See [rollback.md](../runbooks/rollback.md).

## 5. What a pull request into `integration` changes, by path

| Path changed | Effect |
|---|---|
| `dashboard/**` or the contract paths in `deploy/contract-paths.txt` | `dashboard-gate` runs the dashboard's checks. Merges redeploy the staging dashboard, and releases redeploy production |
| `OWNER_PATHS` (section 3) | The release waits for the owner's deploy and `sudo wt-install-units` |
| `deploy/oci/**` | `infra.yml` runs terraform fmt/validate and shellcheck |
| anything else | The host takes it at the next automatic deploy after the release, if `AUTO_ON` is set |

Whether `AUTO_ON` exists on the host today, and whether the installed units match the code, cannot be read from the
repository. **(host state, unverified 2026-11-25)**
