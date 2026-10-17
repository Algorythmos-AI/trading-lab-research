# Ruleset emergency

`main` and `integration` are each protected by a repository ruleset (ADR 0009). Both require a pull request and
the `test` and `dashboard-gate` checks; `main` also requires `release-source` and allows merge commits only. There
are no bypass actors.

**If CI is down and a fix must land:**
1. GitHub → the repo → Settings → Rules → Rulesets → the `main` ruleset → set Enforcement to **Disabled** (or the `integration` ruleset, for a fix there).
2. Merge the fix through its PR.
3. Set Enforcement back to **Active** at once, and note it in the PR.

Org rule: only the owner changes rulesets.
