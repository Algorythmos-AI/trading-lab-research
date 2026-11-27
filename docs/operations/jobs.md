# Jobs and units on the host

Every scheduled job runs on the GCP host `trading-lab-host` under systemd, as user `wt`, from the live checkout
`/home/wt/trading` ([gcp-host.md](../runbooks/gcp-host.md)). The Mac runs nothing. Times are New York unless a
line says UTC.

## Scheduled jobs

The schedule is code: `src/wt/ops/schedule.py` (`JOBS`). `src/wt/ops/units.py` renders each job into a
`wt-<job>.service` and `.timer`, and the owner installs them with `sudo wt-install-units`. Every unit runs
`python -m wt.ops.jobs run <job>`, which then runs the job's own command below as a child, with:

- a lock and a preflight;
- a deadline;
- the job's `MODE`;
- a heartbeat;
- alerts on failure.

The table between the markers is generated from `JOBS`. If you change the schedule, paste in the table that
`tests/unit/test_docs_truth.py` prints when it fails.

<!-- jobs:begin (generated from wt.ops.schedule.JOBS; checked by tests/unit/test_docs_truth.py) -->
| Unit | When | Runs | `MODE` | Gated | Desk | What it does |
|---|---|---|---|---|---|---|
| `wt-routine` | Mon..Fri 07:30 New York | `python scripts/premarket_routine.py` | backtest | yes | stocks | SPEC-0001 pre-market dry run; waits in-process until 07:55 ET |
| `wt-paper-s` | Mon..Fri 08:30 New York | `python -c from wt.live.runner_s import run; run()` | paper | yes | stocks | Sleeve S paper session (stock desk); scans from the open, flat by the close |
| `wt-forward` | Mon..Fri 12:40 New York | `python scripts/forward_test.py` | backtest | yes | stocks | Nightly forward test of the frozen candidates, 20 min after the close |
| `wt-weekly` | Fri 20:00 New York | `python scripts/weekly_scorecard.py` | backtest | yes | stocks | Weekly scorecard after Friday's forward test (waits for the forward lock) |
| `wt-dashboard` | Mon..Fri 07..17:03/5:00 America/New_York; *:03/15:00 UTC | `python -m wt.ops.publish` | backtest | no | stocks | Collect status, sanitize, publish to the dashboard: every 5 minutes in the US session, every 15 otherwise |
| `wt-paper-o` | Mon..Fri 09:00 New York | `python -m wt.live.runner_o` | paper | yes | options | Options clone paper session; arms 09:25 ET, flat by 15:10, ends after the close |
| `wt-options-live` | Mon..Fri 09..16:04/5:00 America/New_York; *:04/15:00 UTC | `python -m wt.options.live` | backtest | no | stocks | Publish the options paper account's open positions, read only: every 5 minutes in the US session, every 15 otherwise |
| `wt-gap-hunter-publish` | Mon..Fri 08:30/1:30 America/New_York; Mon..Fri 09..15:00/1:30 America/New_York; Mon..Fri 16:00..15:30 America/New_York; *:05/15:30 UTC | `python -m wt.ops.gap_live` | backtest | no | stocks | Publish Gap Hunter's live state: every minute in the US session, every 15 otherwise |
| `wt-deploy-notify` | *:20/30:00 UTC | `python -m wt.ops.deploy ready` | backtest | no | stocks | Tell the owner when a deploy is ready (main ahead, green, gate open); it never deploys |
| `wt-deploy-auto` | *:35:00 UTC | `python -m wt.ops.deploy auto` | backtest | no | stocks | Deploy the tip of main when the owner's own deploy would be accepted; dry without var/deploy/AUTO_ON |
| `wt-pipeline-check` | Mon..Fri 08:55:00 America/New_York; Mon..Fri 18:30:00 America/New_York | `python -m wt.options.pipeline_check` | backtest | no | options | Verify the radar, the options edition and its focus names against the tape: before the open and after the evening edition |
| `wt-options-review` | Mon..Fri 16:30 New York | `python scripts/options_clone_review.py` | backtest | no | options | Options clone nightly review: the day per name, each setup's figures and verdict so far |
| `wt-exp0037` | Mon..Fri 17:15 New York | `python scripts/exp0037_replay.py nightly` | backtest | no | options | EXP-0037: fetch and hash the session's replay inputs; run the one replay when its list closes |
| `wt-options-select` | Mon..Fri 06:45 New York | `python -m wt.options.radar_select job` | backtest | no | options | Radar to Options selection (shadow): the Radar's candidates through the gate into Stage 1; publishes nothing |
| `wt-lab-tape` | Mon..Fri 09:15 New York | `python -m wt.lab.recorder` | backtest | no | options | Options lab tape: the focus names' option and stock quotes to the close, then prints and the upload |
| `wt-lab-archive-check` | Sat 11:00 New York | `python -m wt.lab.archive check` | backtest | no | options | Options lab: re-download random archived tape parts and compare their sha256 |
| `wt-econ-calendar` | Fri 21:30 New York | `python -m wt.ops.econ_calendar` | backtest | no | stocks | Read the economic release calendar (FRED, Fed, BLS, BEA) for the Calendar page and publish it |
| `wt-news-archive` | Mon..Fri 20:45 New York | `python scripts/news_archive.py --catch-up 30 --publish` | backtest | no | stocks | Archive the finished days of Alpaca's news items and push them to the private archive repository |
<!-- jobs:end -->

- **`MODE`.** Only `paper-s` and `paper-o` run with `MODE=paper`, and only they place (paper) orders. Every other job
  runs with `MODE=backtest`, so the paper-only lock refuses any order it might try ([safety.md](safety.md)).
- **Gated.** A job is gated when its `trading` flag is set. The deploy gate stays closed while a gated job runs or
  holds its lock, and within 60 minutes of its next start (`src/wt/ops/window.py`). Gated jobs restart on failure
  (at most 3 starts in 6 h); so does `lab-tape` (`RESTART_JOBS` in `units.py`). The rest just run again at their next
  time.
- **`paper-s` restarts.** The session rebuilds its day from the journal, so a restart neither chooses again nor
  takes a second attempt (`src/wt/live/runner_s.py`). When `S.switched_on` is HYP-0072 (DEC-0076), the tier-2 names
  are journaled once as `gap_names`. A restart that finds the day's `gap_primary` but no `gap_names` chooses the names
  from the same 09:25 pool and journals them then.
- **Retired jobs.** `paper-b` (DEC-0069) is in `ARCHIVED_JOBS`. The four crypto jobs (DEC-0036) are in
  `RETIRED_JOBS`. If a leftover unit for one of them fires, it exits 0 (`src/wt/ops/jobs.py`).
- **Paging.** A failed unit pages through `wt-alert@` (ntfy priority 4, or 5 for `wt-paper-s`;
  `deploy/oci/bin/wt-alert`). Jobs also send their own alerts through `wt.ops.alerts`
  ([runbooks](../runbooks/README.md)).
- **Logs.** Each job writes `logs/<log>_<YYYYMMDD>.log` under the checkout, dated in Sydney time
  (`src/wt/ops/jobs.py`). `<log>` is the job's `log` field in `schedule.py`, not always its name: for example
  `paper_s` for `paper-s`, `scorecard` for `weekly`, `deploy_auto` for `deploy-auto`.

## Host units that are not jobs

These live as files in `deploy/oci/systemd/`, and `wt-install-units` installs them beside the generated ones. The
list between the markers is checked against that folder.

<!-- units:begin (checked against deploy/oci/systemd by tests/unit/test_docs_truth.py) -->
| Unit file | What it does | When |
|---|---|---|
| `wt-alert@.service` | Pages the owner that a unit failed (ntfy, from `/etc/wt/paging`) | `OnFailure=` of every unit |
| `wt-secrets.service` | Copies the secrets from `/etc/wt/secrets.env` into tmpfs `/run/wt-secrets/env` (`wt-fetch-secrets`) | at boot |
| `wt-secrets.timer` | Retries the secrets copy until it succeeds | after boot |
| `wt-boot-reconcile.service` | After a reboot, starts `routine`, `paper-s`, `paper-o` or `forward` if the boot fell inside its window (`src/wt/ops/bootreconcile.py`) | at boot |
| `wt-backup.service` | Checks the evidence chains, backs up to R2, anchors the day's heads (`wt.ops.backup nightly`) | by its timer |
| `wt-backup.timer` | Starts the backup | daily 19:30 |
| `wt-restore-test.service` | Restores the latest backup into a temp dir and checks it | by its timer |
| `wt-restore-test.timer` | Starts the restore test | Sat 12:00 |
| `wt-tunnel.service` | Cloudflare tunnel for admin SSH, outbound only; runs only if `/etc/cloudflared/token` exists | always, if configured |
| `wt-webull-pull.service` | Reads the owner's Webull account, read only, as user `wt-webull` (ADR 0011); runs only if `/etc/wt/webull.env` exists | by its timer |
| `wt-webull-pull.timer` | Starts the Webull pull | Mon–Fri every 2 min 09:00–16:58, and daily 17:40 |
| `wt-webull-publish.service` | Sends the Trades page's journal from what the pull read (`wt.webull.publish`) | `OnSuccess=` of the pull |
<!-- units:end -->

`wt-install-units` enables the backup and restore-test timers only when the secrets hold `RESTIC_REPOSITORY`, and
the Webull pull timer only when the Webull key and user are installed (`deploy/oci/bin/wt-install-units`;
[webull-readonly.md](../runbooks/webull-readonly.md)). Whether each
one is enabled on the host today cannot be read from the code. **(host state, unverified 2026-11-25)**
