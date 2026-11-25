# Dashboard late or stopped

**Signal:**
- ntfy "Dashboard late: no update for N min" (priority 4). The watchdog (`/api/cron/watchdog`, every 10 minutes)
  pages only inside an expected window: from 07:30 New York until 2 h after the close, on session days. The host
  publishes those windows itself (`expected_windows` in `src/wt/ops/publish.py`).
- The freshness pill says "Lab host (VM) late" or "Lab host (VM) stopped". Outside the windows, "Lab host (VM) ·
  resting" is normal. The pill measures only how old the last published snapshot is: "stopped" does not mean the
  desks stopped, and "resting" does not mean the VM is up.

The dashboard is fed by the `wt-dashboard` job on the GCP host: every 5 minutes in the US session, every 15
otherwise ([jobs.md](../operations/jobs.md)). Open a shell on the host with
`gcloud compute ssh trading-lab-host --zone us-east1-b --tunnel-through-iap` ([gcp-host.md](gcp-host.md)).

**Checks, in order:**
1. **Is the VM running?** From your own machine: `gcloud compute instances list`. If it is stopped or being
   rebuilt, nothing publishes.
2. **Is the timer there and firing?** Run `systemctl list-timers 'wt-dashboard*'` and
   `systemctl status wt-dashboard.service`. If it is missing, the owner runs `sudo wt-install-units`. It refuses while
   the deploy gate is closed, and it re-enables every job timer, including one disabled on purpose.
3. **Did the secrets load?** Run `systemctl status wt-secrets.service`. Without `/run/wt-secrets/env` every job
   fails to start.
4. **Read the job's log:** `sudo -u wt tail -n 50 /home/wt/trading/logs/dashboard_$(TZ=Australia/Sydney date +%Y%m%d).log`
   (logs are dated in Sydney time).
   - `DASHBOARD_INGEST_URL / SECRET not set`: the host's secrets lack them. Run `sudo wt-set-secrets`.
   - HTTP 401: the host signs with its own key, `DASHBOARD_KEY_ID` (`gcp-use1` by default), and Vercel no longer
     holds that key's secret in `DASHBOARD_INGEST_KEYS`. Re-add it as in [gcp-host.md](gcp-host.md), section 2.
     `provision_secrets.sh` does **not** fix this: it rotates only the default key, and it revokes the bypass secret.
   - HTTP 403: the host's `VERCEL_AUTOMATION_BYPASS_SECRET` is no longer valid (for example after
     `provision_secrets.sh`). Type the current one with `sudo wt-set-secrets`.
5. **Build the snapshot without sending it:** `sudo -u wt make -C /home/wt/trading publish DRY_RUN=1`. It runs
   without the host's secrets, so it shows build faults, not secret faults.
6. **Prove the paging path:** follow the watchdog drill in [dashboard-deploy.md](dashboard-deploy.md).
