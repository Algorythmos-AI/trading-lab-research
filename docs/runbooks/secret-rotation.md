# Rotate secrets

**Dashboard secrets** (ingest HMAC, cron secret, ntfy topic, deployment-protection bypass):

```
bash ~/trading/dashboard/scripts/provision_secrets.sh
```

It regenerates the default ingest secret (`DASHBOARD_INGEST_SECRET`), `CRON_SECRET`, `NTFY_TOPIC` and the Vercel
bypass secret, writes them to `~/trading/.env` (mode 600) and to the Vercel production environment, and **revokes the
old bypass secret**. It prints only the new ntfy topic. It touches neither the host nor GitHub. Then, in this order,
outside the trading window:

1. Set the new `VERCEL_AUTOMATION_BYPASS_SECRET` in the GitHub `production` Environment, which `dashboard.yml` uses.
   Do this before the redeploy: the workflow's closing `/api/health` check uses that secret, and the old one is
   already revoked.
2. Redeploy the dashboard by re-running the latest `dashboard` workflow on `main`, so the functions pick up the new
   values.
3. On the host, run `sudo wt-set-secrets` and type the new `VERCEL_AUTOMATION_BYPASS_SECRET` and `NTFY_TOPIC` from
   the Mac's `.env`. Until then every publish from the host is refused (HTTP 403).
4. Subscribe to the new ntfy topic in the ntfy app, remove the old one, and point the healthchecks.io ntfy
   integration at it ([dead-man-switches.md](dead-man-switches.md)).
5. Check the next `wt-dashboard` run's log ([dashboard-late.md](dashboard-late.md)).

The host signs with its own key (`DASHBOARD_KEY_ID`, `gcp-use1` by default), which this script does not rotate; that
key's secret lives in Vercel's `DASHBOARD_INGEST_KEYS` ([gcp-host.md](gcp-host.md), section 2).

**Broker keys (Alpaca paper):**

The cloud host is the only machine that runs jobs ([gcp-host.md](gcp-host.md)). It reads its keys from
`/etc/wt/secrets.env`, never from the Mac's `~/trading/.env`. Regenerating a paper key invalidates every older
copy at once, so the host needs the new pair, and so does every other place that holds the old one.

1. Choose a time when no trading job runs: outside 07:00 to 18:00 New York on a session day. On the host,
   `sudo -u wt /usr/local/bin/wt-deploy gate` then prints `Deploy gate OPEN`. A job that is already running keeps
   the old pair in memory, and Alpaca refuses it from the moment the new one exists. (If the host's pair is
   already dead the gate cannot open; go on to step 3.)
2. Regenerate the key pair in Alpaca's console (the paper account).
3. On the host, run `sudo wt-set-secrets`. Type the new `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY`; Enter keeps
   every other value. It ends with `wt-secrets: ok`.
4. Check it with `sudo -u wt /usr/local/bin/wt-deploy gate`. The gate reads Alpaca's calendar with the host's
   keys, so `Deploy gate OPEN` means the new pair works. "Alpaca rejected this host's API keys" means the host
   still holds an old or mistyped pair: repeat step 3. `make preflight` does not test the keys.
5. Update `~/trading/.env` on the Mac if the console uses the same paper account. Updating only the Mac leaves
   the host on the dead pair.

**Broker key (Webull, read only):** it lives on the host in `/etc/wt/webull.env`, apart from the shared secrets
(`wt-set-secrets` has no field for it). Press **Reset Key** in Webull's API Keys Management, then run
`sudo wt-set-webull-secret` and approve the new token in the Webull app ([webull-readonly.md](webull-readonly.md)).

**GitHub Actions secrets** (`VERCEL_TOKEN`, …): create a new token with an expiry, then:

```
gh secret set VERCEL_TOKEN -R Algorythmos-AI/trading-lab-research
```
