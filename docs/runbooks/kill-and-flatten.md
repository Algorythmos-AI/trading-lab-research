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

A kill file stops only new entries. The running desk keeps protecting what it holds: Gap Hunter re-places a
missing stop on every loop, and the clone keeps managing its exits. **Stop the runner before you touch its orders**,
or a stop you cancel can come back and open a short after your sell.

1. Turn the desk's kill file on (above), so a restart cannot enter.
2. **(owner)** Stop the desk's runner: `sudo systemctl stop wt-paper-s` (Gap Hunter) or `sudo systemctl stop wt-paper-o`
   (the clone). It may page as a failed unit (the job runner exits 143 when stopped). Its resting orders stay at the broker: the
   runner does not cancel them on the way out. Its timer starts it again
   at the next session, and the kill file keeps that session from entering.
3. **Cancel orders.** In the Alpaca paper UI of the desk's account ([paper-accounts.md](paper-accounts.md)), cancel
   the desk's open orders:
   - `wt-S-…` for Gap Hunter;
   - `wt-O-…` for the clone.
4. Close the position in the Alpaca UI.
5. Leave the kill switch on until you've read the logs (`/home/wt/trading/logs/`).
