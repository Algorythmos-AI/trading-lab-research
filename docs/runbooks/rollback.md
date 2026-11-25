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

1. Refuses unless the deploy gate is open: no gated job running, and outside the trading window (07:00 New York to
   2 h after the close).
2. Checks the broker before it moves anything. It refuses if strategy B's allowlist holds a position. If B is flat,
   it cancels this repo's resting orders. **This check reads only the `APCA_API_*` account** ("Robot B stocks"),
   which no desk trades since DEC-0069. It does not look at Gap Hunter's or the clone's accounts. Both desks are
   flat by the close, and the gate keeps a rollback out of the trading window, but check those two accounts in the
   Alpaca UI before a rollback outside the usual hours.
3. Holds the deploy lock and the other jobs' locks, runs `git reset --hard` to the tag, re-syncs the venv and runs
   the smoke tests.
4. Records the rollback in `var/deploy/`. It also tells the automatic deploy not to take the commit it left again:
   only a newer one goes in.

If the units differ between the two versions, `sudo -u wt /usr/local/bin/wt-deploy units-diff` shows how, and
the owner runs `sudo wt-install-units`.

Then fix forward: a `hotfix/*` branch from `origin/main` ([deploy.md](../operations/deploy.md)).
