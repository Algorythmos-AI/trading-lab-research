# Dead-man's switches: who notices when the host goes quiet

Three independent monitors, none of them on the trading host:

1. **The Vercel watchdog** (`/api/cron/watchdog`, every 10 minutes): pages when the dashboard snapshot goes stale
   inside an expected trading window. Proven by `make watchdog-drill` (see dashboard-deploy.md).
2. **healthchecks.io** (free plan): each job pings its own check by slug when it finishes, and `/fail` when it
   fails or refuses. A check that doesn't hear from its job in time pages (ntfy + email).
3. **OCI alarm + Cloudflare tunnel notification** (VM only, ADR 0004): instance down, tunnel down.

## healthchecks.io setup (owner, once)

1. Create a free account and a project "trading-lab". Settings > API Access: create a **ping key** and put it in
   `~/trading/.env` on the Mac (and the VM's paging file later) as `HC_PING_KEY=...`. Never commit it.
2. Integrations: add **ntfy** (the same topic as `NTFY_TOPIC`) and email. Attach both to every check.
3. Create these checks. Use **Cron** schedules, time zone **America/New_York**, slug exactly as shown. Each tick
   is before the earliest possible ping on either host in every daylight-saving combination, and the grace covers
   the latest normal ping (a day with no session, or an early close, still pings inside the window):

| Slug | Cron | Grace | Normal ping (ET) | What a page means |
|---|---|---|---|---|
| `wt-routine` | `0 5 * * 1-5` | 5 h | ~08:00 | The pre-market routine didn't finish (or refused) |
| `wt-paper-b-armed` | `0 6 * * 1-5` | 3 h 45 min | 09:30 (the open) | Paper B never reached the open: not started, refused or crashed while arming |
| `wt-paper-b` | `0 6 * * 1-5` | 11 h | ~16:05 (13:05 early close) | The paper-B session job didn't end cleanly |
| `wt-forward` | `0 12 * * 1-5` | 7 h | ~16:30–17:50 | The forward test didn't run |
| `wt-weekly` | `0 18 * * 5` | 6 h | Fri ~19:00–21:00 | The weekly scorecard didn't run |

The crypto desk (ADR 0005) runs at every hour of every day, so its check is a **Simple** schedule, not a cron:

| Slug | Period | Grace | Normal ping | What a page means |
|---|---|---|---|---|
| `wt-crypto` | 15 min | 30 min | every 15 minutes, 10–30 s after the bar closes | No crypto bar cycle has finished for 45 minutes |

With the crypto desk on the host, `wt-backup` also pings at weekends: change its cron to `30 19 * * *`.

Five checks; the VM adds backup and restore-test checks later (at most 15 of the free 20). The Mac and the VM
share these slugs: the ping body says which host and role sent it.

## What the jobs send

- Success (exit 0): `https://hc-ping.com/<key>/<slug>`, body `host=… role=… exit 0`.
- Failure or refusal: `…/<slug>/fail`. A refusal exits 0 so the scheduler doesn't retry it, but it is not a
  success. A run that finds its job already running (lock held) sends nothing: the running one will ping.
- Paper B pings `wt-paper-b-armed` when its loop reaches the open. On a day without a session it pings with
  "no session today"; if it never armed for any other reason, the job runner sends `/fail`.
- Pings never block or fail a job: 5-second timeout, errors ignored, nothing sent without `HC_PING_KEY`.

## When a check pages

Open the job's log (`make status`, then `logs/<job>_<date>.log`) and the journal. The ping body shows the host
and the exit code. A page on a US holiday means a job didn't run at all (they still start and exit early).
