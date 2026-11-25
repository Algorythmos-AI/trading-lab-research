# Rollback a deploy

**You'll see:** the next night's jobs fail after a deploy, or a release must come out.

Every deploy tags the commit it replaced as `runtime-YYYYMMDD-N`. The deploy records in `var/deploy/*.json`
and the Operations page list the tags. On the GCP host
([gcp-host.md](gcp-host.md), `gcloud compute ssh trading-lab-host --zone us-east1-b --tunnel-through-iap`):

```bash
sudo -u wt /usr/local/bin/wt-deploy gate                           # must say OPEN
sudo -u wt /usr/local/bin/wt-deploy 'rollback runtime-YYYYMMDD-N'
```

`wt-deploy` runs `make rollback TAG=…`, which runs `wt.ops.deploy rollback` (`src/wt/ops/deploy.py`). The rollback:

1. Refuses unless the deploy gate is open: no gated job running, outside the trading window (07:00 New York to
   2 h after the close), and not within an hour of a gated job's start.
2. Checks the brokers before it moves anything (`broker_cleanup_before_rollback`). It reads three paper accounts:
   the `APCA_API_*` one ("Robot B stocks", where only strategy B's allowlist counts), Gap Hunter's (`APCA_S_*`) and
   the clone's own (`APCA_CLONE_*`), where every position is the desk's. It refuses if any of them holds a position,
   or if a desk account can't be read, and then cancels nothing. Once all are flat it cancels this repo's resting
   orders (`wt-…` ids) on each. A checkout without a desk's key pair says so and skips that account: that desk can't
   trade from it. The host holds both desks' pairs ([paper-accounts.md](paper-accounts.md)), so both are checked
   there. A clone that runs on the shared `APCA_OPTIONS_*` pair instead of its own is not covered (the host has
   none set): check that account in the Alpaca UI.

   There is no override. If it refuses because a desk holds a position, flatten that desk first
   ([kill-and-flatten.md](kill-and-flatten.md)) and run the rollback again. If an account could not be read (a broker
   outage), wait and retry, or fix forward with a hotfix instead.
3. Holds the deploy lock and the other jobs' locks, runs `git reset --hard` to the tag, re-syncs the venv and runs
   the smoke tests.
4. Records the rollback in `var/deploy/`. It also tells the automatic deploy not to take the commit it left again:
   only a newer one goes in.

If the units differ between the two versions, `sudo -u wt /usr/local/bin/wt-deploy units-diff` shows how, and
the owner runs `sudo wt-install-units` (it re-enables every job timer, including one disabled on purpose).

Then fix forward: a `hotfix/*` branch from `origin/main` ([deploy.md](../operations/deploy.md)).
