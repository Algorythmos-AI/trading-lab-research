# CI: workflows, required checks, and what `make ci` covers

Checked against `.github/workflows/` at `9441a547`. The required checks were read from the repository rulesets on
2026-11-25.

## Required checks

| Branch | Ruleset requires | Comes from |
|---|---|---|
| `integration` | `test`, `dashboard-gate` | `ci.yml` |
| `main` | `test`, `dashboard-gate`, `release-source` | `ci.yml`, `release.yml` |

Both rulesets also block deletion and non-fast-forward pushes and require a pull request. The host's deploy checks
less: by default it requires only `test` (`src/wt/ops/ci.py`, `DEFAULT_REQUIRED`). See
[deploy.md](../operations/deploy.md).

## Workflows

| Workflow | Runs on | What it does |
|---|---|---|
| `ci.yml`, job **`test`** | Every pull request; pushes to `main` and `integration` | 1. Installs the locked environment.<br>2. Checks that it also installs on Linux ARM64 (hash-checked, no download).<br>3. Checks no restricted or runtime path, at HEAD and in every commit of the change (`scripts/check_restricted_paths.py`).<br>4. Runs ruff, then actionlint and shellcheck.<br>5. Runs mypy on the typed modules (`make typecheck`).<br>6. Checks that the dashboard contract regenerates with no diff (`make schema`).<br>7. Runs pytest |
| `ci.yml`, job **`dashboard-gate`** | Same | If the change touches the dashboard contract (`deploy/contract-paths.txt`), runs the dashboard's lint, types, unit tests, contract, build and end-to-end tests; otherwise passes |
| `release.yml`, job **`release-source`** | Pull requests (also when edited) | A pull request into `main` must come from `integration` or a `hotfix/*` branch, and not from a fork |
| `dashboard.yml` | Dashboard and contract paths; manual | Dashboard checks; deploys production on `main`, and staging on `integration` when the `STAGING_ENABLED` variable is `true` |
| `registry.yml` | Pushes to `main` and `integration`; manual | Builds the Reference Registry index (`scripts/build_registry.py`) and sends it, signed, in the `registry` Environment. Prints counts and hashes only |
| `infra.yml` | `deploy/oci/**` | Terraform fmt and validate, and shellcheck |
| `security.yml` | Pull requests, pushes, and weekly (Sunday 20:00 UTC) | The org's reusable security workflow (gitleaks over the checked-out tree; this repository passes `semgrep: false`), and a dependency audit (`pip-audit` on both lockfiles; `pnpm audit --prod`, high and critical) |

## Locally

| Command | Covers | Does not cover |
|---|---|---|
| `make ci` | ruff, mypy on the typed modules, the restricted-path check at HEAD, pytest | the ARM64 install check, actionlint, the schema diff, the restricted check over every commit, and `dashboard-gate` |
| `make schema && git diff --exit-code` | the dashboard contract diff that CI runs | — |
| `make hooks` | installs pre-commit: gitleaks, the restricted-path guard, ruff, actionlint, and the large-file, private-key and merge-conflict checks | — |
| `cd dashboard && pnpm lint && pnpm typecheck && pnpm test && pnpm build` | most of `dashboard-gate` | the end-to-end and screenshot tests (`pnpm test:e2e`) |

Run the dashboard's tests twice, with and without `DASHBOARD_FIXTURE=1`: the CI build uses the fixture.

## What the tests may not do

`tests/unit` is CI-safe: fixtures and `tmp_path` only, no network ([AGENTS.md](../../AGENTS.md)). The host's deploy
stage runs the same suite with `-m "not replay"`. A test must therefore also pass in a fresh checkout on the host,
with no `.env` and a different time zone.
