# Kill switch and flatten

**You'll see:** you want trading to stop now.

The jobs run on the GCP host, so the commands below run there. Open a shell with
`gcloud compute ssh trading-lab-host --zone us-east1-b --tunnel-through-iap` (see [gcp-host.md](gcp-host.md)).
The root `KILL` file is the **master switch: every desk reads it**. Each desk also has its own file. The full table is in
[docs/operations/safety.md](../operations/safety.md).

## Stop new entries

Exits and stops keep being managed.

| Desk | On | Off |
|---|---|---|
| Every desk (root file) | `sudo -u wt make -C /home/wt/trading kill REASON="why"` | `sudo -u wt make -C /home/wt/trading unkill` |
| Gap Hunter only (`paper-s`) | `sudo -u wt make -C /home/wt/trading kill DESK=s REASON="why"` | `sudo -u wt make -C /home/wt/trading unkill DESK=s` |
| Options clone only (`paper-o`) | `sudo -u wt make -C /home/wt/trading kill DESK=options REASON="why"` | `sudo -u wt make -C /home/wt/trading unkill DESK=options` |

- The root `KILL` file is read by every desk (`src/wt/live/runner_o.py` `KILLS`, `src/wt/live/runner_s.py`
  `killed()`). A desk stays stopped while any file it reads exists.
- `make kill DESK=stocks` also writes the root file. Any `DESK` other than `s`, `options` or `stocks` is refused and
  writes nothing.
- Every `make kill` and `make unkill` above writes a `kill_on` or `kill_off` entry to the audit log.
- The runners re-read their files while running, so this takes effect at once.
- `make status` shows each desk's file on its own line. The dashboard's Risk page lists Gap Hunter's file and the
  root file, but not the clone's own `var/options/KILL`. Check the line for the desk you meant to stop.

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
