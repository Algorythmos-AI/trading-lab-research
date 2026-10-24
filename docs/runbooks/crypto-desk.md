# Crypto desk (closed)

The crypto desk (ADR 0005, DEC-0012) ran on the trading host next to the stocks desk from 2026-10-02: Kraken's
public market data, simulated fills on its own paper book, its own snapshot, no venue credentials. **DEC-0036
closed it on 2026-10-24**: every registered rule failed gate C1, and the desk takes no further trial. The
runbook as it stood while the desk ran is in git history before that date.

## What this release changed

- The four jobs (`crypto`, `dashboard-crypto`, `crypto-challengers`, `crypto-learn`) are no longer in
  `src/wt/ops/schedule.py`, so no `wt-crypto*` unit is rendered. The `make` controls for the desk are gone.
- The desk's code (`wt.crypto`), its `Desk` record, `config/crypto.yaml`, `scripts/crypto_*.py` and the
  dashboard's crypto ingest contract stay until the next release, which removes them. `var/crypto/` on the
  host is left as it is until then: its journal is still anchored by the backup.
- The dashboard shows one page at `/crypto` that states the record; `/api/health` reports the desk's state as
  `closed`; the off-host watchdog does not watch a closed desk.

## Owner steps on the host

1. Deploy this release (`wt-deploy deploy`; it changes owner paths, so the host does not take it on its own).
2. `sudo wt-install-units` (gate open): the installer removes the units that are no longer rendered, since
   `/etc/wt/installed-units.txt` lists them. Until it runs, a leftover `wt-crypto*.timer` still fires:
   `wt.ops.jobs run <name>` for a retired name exits 0 at once and runs nothing (no lock, no heartbeat, no
   ping, no child), so nothing pages. `var/crypto.MOVED` (ADR 0005 §7) is not needed for that, but it does no
   harm if it exists.
3. Check: `systemctl list-timers 'wt-*'` shows no `wt-crypto*`; `make status` lists no crypto cadence line.
4. healthchecks.io: pause or delete `wt-crypto`, `wt-crypto-challengers` and `wt-crypto-learn`, or they page
   for jobs that no longer run (see [dead-man switches](dead-man-switches.md)).

## Pages that can still arrive

| Page | Meaning | First step |
|---|---|---|
| `wt-crypto*` (healthchecks) | the check was not paused after the units were removed | pause or delete the check |
| Evidence chain broken: crypto entries off | the nightly backup found a break in `crypto_journal.jsonl` | do not edit the file; compare with the last anchor and the restic snapshot ([backups](backups-and-lease.md)). The ledger leaves with the code in the next release |
