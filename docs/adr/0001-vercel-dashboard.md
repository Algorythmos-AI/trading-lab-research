# ADR 0001: Status dashboard on Vercel, fed by a signed push from the Mac

- **Status:** accepted, 2026-09-29
- **Context:** September 2026 audit, plan v2

## Context

The owner wants one page that answers "is everything OK, and what happened tonight?", readable on a phone.

The previous page only stayed fresh while an interactive assistant session kept pushing data into it. Nothing
alerted anyone when a job failed: `com.wt.routine` exited 1 on 2026-09-28, and it went unnoticed.

Two things constrain the design:
- **Almost every source is local:** launchd, pmset, logs, journals, git and the `gh` CLI. A hosted page can't read
  them.
- **The repository is restricted.** It holds course-derived specifications and research notes that must never
  be published.

## Decision

1. **The Mac pushes; the page never pulls.** Every 15 minutes, `com.wt.dashboard` runs the collector, builds one
   snapshot, sanitizes it and signs it (HMAC-SHA256 over `timestamp.body`). It then POSTs the snapshot to
   `/api/ingest`, passing Vercel's deployment protection with the automation-bypass header.
2. **The sanitization fails closed** (`wt.ops.publish`):
   - **Allowlist:** `ALLOW` is a declarative allowlist. Any field not listed is dropped.
   - **Free text:** it is redacted, truncated and checked against the restricted corpus (the course batches, K0
     deliverables and spec sources). A text that shares any 8-word phrase with the corpus is withheld. Without the
     corpus, only ids, numbers and enums are published.
   - **One contract, enforced twice:** the JSON Schema is generated from `ALLOW`, and the ingest route enforces
     the same file with unknown properties rejected, plus a denylist.
3. **No broker keys on Vercel.** The paper account figures travel inside the snapshot. The only Blob credential
   belongs to the Vercel project. The Mac holds only the ingest secret and the bypass secret.
4. **Private Blob storage.**
   - `snapshots/latest.json` is overwritten, but only by a newer `as_of`; an older one gets 409, and writes are
     conditional (`ifMatch`).
   - One history snapshot is kept per hour.
   - Reads are consistent (`useCache: false`).
5. **An off-host watchdog.** A Vercel cron alerts via ntfy when the snapshot goes quiet *inside a published
   expected window*: from 07:30 ET until 2 h after the close, on session days. Silence while the laptop sleeps
   during the Sydney day is normal and raises nothing.
6. **Access.**
   - Vercel Authentication on all deployments, production included.
   - Invited viewers are team members.
   - The UI is strictly read-only: control stays on the Mac (`make kill`, `make reset-latch`).
7. **Deploys.**
   - GitHub Actions runs `vercel build` and `vercel deploy --prebuilt` from `dashboard/`, so Vercel never
     clones this repository.
   - The workflow is path-filtered, so docs-only commits never rebuild (org decision D-018).

## Consequences

- The page shows the same heartbeats, alerts and preflight results as `make status`. It keeps showing them when a
  job refuses to run.
- A leak would take three separate failures: the allowlist, the leak check and the schema.
- The watchdog needs the Mac to publish its expected windows. After 48 h of silence it sends one low-priority
  alert a day.
