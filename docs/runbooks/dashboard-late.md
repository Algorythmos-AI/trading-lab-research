# Dashboard late or stopped

**Signal:**
- ntfy "Dashboard late: no update for N min" (priority 4). The watchdog only pages inside an expected window: from
  07:30 ET until 2 h after the close, on session days.
- Outside those windows a grey "Mac asleep (expected)" pill is normal.

**Checks, in order:**
1. **Is the Mac awake and on power?** The trading jobs keep it awake with `caffeinate`, but only while they run.
2. Run `launchctl list | grep com.wt.dashboard`. The agent must be loaded; if not:
   `make -C ~/trading install-dashboard-agent`.
3. Read `logs/dashboard_<date>.log`.
   - `DASHBOARD_INGEST_URL / SECRET not set` → run `provision_secrets.sh`.
   - HTTP 401 → the HMAC secret differs between `.env` and Vercel: rotate.
   - HTTP 403 → the bypass secret is wrong: rotate.
4. `make -C ~/trading publish DRY_RUN=1` builds the snapshot locally without sending it.
