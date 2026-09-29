# ADR 0002: Runtime state outside git, and a computed deploy gate

- **Status:** accepted, 2026-09-29
- **Context:** September 2026 audit, plan v2

## Context

launchd runs the working tree of `~/trading` every trading night. Before this change:

- **Jobs wrote into tracked paths.** `research/forward/forward_trades.jsonl`, `research/forward/routine/` and
  `watchlist/<date>.json` all lived under version control. Once evidence was committed, the next
  `git pull --ff-only` on the live checkout would have failed:
  - an untracked file collides with an incoming add;
  - an appended tracked file blocks the merge.
- **Updates relied on a fixed wall-clock rule.** "Don't touch it between 21:30 and 06:40 Sydney" is wrong after
  both daylight-saving changes. The US close falls at 06:00, 07:00 or 08:00 Sydney depending on the regimes in
  force, and the forward test runs until about two hours after it.
- **Failures were silent.** The paper script masked exit codes, no job took a lock, and nothing alerted the owner.
  `com.wt.routine` exited 1 on 2026-09-28 and nobody knew.

## Decision

1. **Runtime state lives in `var/`** (`WT_STATE`), which is git-ignored:
   - the forward ledger;
   - routine stage files;
   - forward-mode watchlists and scorecards;
   - locks, heartbeats, the alert spool and deploy records.

   Evidence reaches git only as new, immutable archive files, through pull requests built outside the live checkout.

2. **Every job runs through `wt.ops.jobs`:**
   - a per-job lock;
   - preflight: on `main`, a reviewed commit, clean code paths, runtime state migrated, the venv matching the
     lockfile, at least 3 GB free, `.env` mode 600;
   - an in-process wait where needed;
   - a deadline;
   - post-run checks, alerts and a heartbeat.

   A failed preflight is a *refusal*: one alert per day, exit 0.

3. **The live checkout changes only through `make deploy`.** It refuses while any job runs or holds its lock,
   inside the trading night (07:00 ET to close + 2 h on a session day, from the exchange calendar), within an hour
   of a scheduled start, or when the calendar can't be read. When it does run, it:
   - tags `runtime-<date>-<n>`;
   - pulls, migrates state and syncs the venv;
   - runs the smoke tests, and rolls back to the tag if they fail.

4. **launchd agents are generated from `wt.ops.schedule`.** The owner installs them with
   `make install-trading-agents`, which is behind the same gate.

## Consequences

- `git pull` on the live checkout can't collide with a job's output, and nothing changes mid-session.
- The forward test is its own job (`com.wt.forward`), so a hang can't block the next trading day. Until the owner
  reinstalls the agents, the paper job runs it inline, as before.
- `make status` answers "what's going on" in the terminal. The dashboard publishes the same heartbeats.
