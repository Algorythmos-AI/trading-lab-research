# Kill switch and flatten

**You'll see:** you want trading to stop now.

The jobs run on the GCP host, so the commands below run there. Open a shell with
`gcloud compute ssh trading-lab-host --zone us-east1-b --tunnel-through-iap` (see [gcp-host.md](gcp-host.md)).
Each desk has its own kill file, and **no single file stops every desk**. The full table is in
[docs/operations/safety.md](../operations/safety.md).

## Stop new entries

Exits and stops keep being managed.

| Desk | On | Off |
|---|---|---|
| Gap Hunter (`paper-s`) | `sudo -u wt sh -c 'mkdir -p /home/wt/trading/var/smallcap && echo "why ($(date))" > /home/wt/trading/var/smallcap/KILL'` | `sudo -u wt rm /home/wt/trading/var/smallcap/KILL` |
| Options clone (`paper-o`) | `sudo -u wt make -C /home/wt/trading kill DESK=options REASON="why"` | `sudo -u wt make -C /home/wt/trading unkill DESK=options` |
| Options clone, root file | `sudo -u wt make -C /home/wt/trading kill REASON="why"` | `sudo -u wt make -C /home/wt/trading unkill` |

- The root `KILL` file is read by the options clone, not by Gap Hunter (`src/wt/live/runner_o.py`,
  `src/wt/live/runner_s.py`).
- `make kill DESK=stocks` also writes the root file; it does not stop Gap Hunter.
- The runners re-read their files while running, so this takes effect at once.
- `make status` and the dashboard's top-level kill flag show only the root file. Check `var/smallcap/KILL` yourself
  before you trust that Gap Hunter is stopped.

## Flatten now

1. Turn the desk's kill file on (above).
2. **Cancel orders first.** In the Alpaca paper UI of the desk's account ([paper-accounts.md](paper-accounts.md)),
   cancel the desk's open orders, so a stop can't fill *after* your sell and open a short:
   - `wt-S-…` for Gap Hunter;
   - `wt-O-…` for the clone.
3. Close the position in the Alpaca UI.
4. Leave the kill switch on until you've read the logs (`/home/wt/trading/logs/`).
