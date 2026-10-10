# Rotate secrets

**Dashboard secrets** (ingest HMAC, cron secret, ntfy topic, deployment-protection bypass):

```
bash ~/trading/dashboard/scripts/provision_secrets.sh
```

- It regenerates every value and writes it to `~/trading/.env` (mode 600) and to the Vercel production
  environment.
- It prints only the new ntfy topic. Subscribe to it in the ntfy app and remove the old one.
- Redeploy the dashboard by re-running the latest `dashboard` workflow on `main`, so the functions pick up the new
  values.

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

**Broker keys (Webull):** these are not on the host (`wt-set-secrets` has no field for them). Regenerate them in
Webull's console and update `~/trading/.env`.

**GitHub Actions secrets** (`VERCEL_TOKEN`, …): create a new token with an expiry, then:

```
gh secret set VERCEL_TOKEN -R Algorythmos-AI/trading-lab-research
```
