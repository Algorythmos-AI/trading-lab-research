# Evidence backups, anchors and the primary lease (OCI host, ADR 0004)

## Nightly (wt-backup.timer, 19:30 ET after the forward test)
`python -m wt.ops.backup nightly`:
1. Verifies the hash chains of the forward ledger and the paper journal. A break writes
   `var/evidence/chain-broken` (paper-B entries off, exits still managed) and pages "Evidence chain broken".
2. `restic backup` of `var/`, `data/live/`, `logs/` (Saturdays also `data/`) to R2 bucket `wt-backups`.
3. Writes `anchors/<ET-date>.json` (line count and head hash of each chain) to R2 bucket `wt-anchors`,
   write-once. "already anchored with DIFFERENT heads" means history was rewritten after anchoring: investigate
   before anything else.
4. Writes `var/dashboard/evidence_digest.json` for the dashboard.

**Chain broken.** Compare the ledger with the last anchor and the restic snapshots (`restic snapshots`,
`restic restore <id> --target /tmp/x --include <ledger>`). Once explained and repaired, the owner removes
`var/evidence/chain-broken` (and records why in `research/lessons_learned/`).

## Weekly restore test (Saturday 12:00 ET)
`python -m wt.ops.backup restore-test` restores the latest snapshot's ledgers into a temp dir and verifies their
chains. A failure means the backups can't be trusted: fix before the next session.

## Pruning (the Mac, monthly)
`python -m wt.ops.backup prune` keeps 45 days. The bucket lock protects `data/` and `snapshots/` for 30 days, so
some objects can't be removed yet; that is expected ("unable to remove" is a warning). Alert at 8 GB (R2 free is 10).

## R2 setup (owner, once)
Buckets `wt-backups` (lock: prefixes `data/` and `snapshots/`, 30 days), `wt-anchors` (lock: whole bucket, 400
days), `wt-leases` (no lock). One API token per bucket (Object Read & Write, that bucket only). Vault secrets:
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `RESTIC_REPOSITORY`
(`s3:https://<account>.r2.cloudflarestorage.com/wt-backups`), `RESTIC_PASSWORD` (also in your password manager:
without it the backups are unreadable). Initialise once: `restic init`.

## The primary lease
On the VM, paper B arms entries only while it holds `wt-leases/paper-b` (20 h, the store's clock). Refused
("held by …", "lost a race", "unreachable") means entries off, exits managed, page "no primary lease".
**Break it** (owner, only when the other holder is certainly stopped): `python -m wt.ops.lease break`.

## Shadow role
`WT_ROLE=shadow` (Vault) makes the VM's runner turn entries off for every session and wraps its broker so any
order call raises. Its dashboard snapshots (key id `DASHBOARD_KEY_ID`) land in `shadow/latest.json` until the
dashboard's `PRIMARY_HOST` names it.
