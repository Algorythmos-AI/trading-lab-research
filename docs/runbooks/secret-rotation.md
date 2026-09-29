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

**Broker keys:**
1. Regenerate them in the broker's console (Alpaca paper, Webull).
2. Update `~/trading/.env`.
3. Run `make -C ~/trading preflight`.

**GitHub Actions secrets** (`VERCEL_TOKEN`, …): create a new token with an expiry, then:

```
gh secret set VERCEL_TOKEN -R Algorythmos-AI/trading-lab-research
```
