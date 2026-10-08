# The GCP free-tier trading host: provision, operate, rebuild

A second home for the trading jobs while OCI has no Ampere capacity: one Google Cloud **e2-micro** in **us-east1**,
inside the always-free tier. It uses the same host helpers and units as the OCI host (`deploy/oci/bin`,
`deploy/oci/systemd`, [oci-host.md](oci-host.md)); only the first boot (`deploy/gcp/cloud-init.yaml`) and the
secrets source differ. Owner steps are marked **(owner)**. Claude never types a secret, creates resources in your
cloud account, or (re)loads units.

| | |
|---|---|
| Machine | e2-micro (2 shared vCPU, 1 GB RAM) with zram swap in RAM, Ubuntu 24.04 x86-64 |
| Disk | 30 GB `pd-standard` boot disk (the free-tier maximum) |
| Free-tier conditions | one e2-micro in us-west1, us-central1 or us-east1; standard disk ≤ 30 GB; 1 GB egress a month. Snapshots are ~45 KB every ~15 min, about 130 MB a month |
| Cloud credentials on the VM | none: the VM is created **without a service account**, and the `wt` user is also firewalled off the metadata server |
| Inbound | SSH only, only from Google's IAP range `35.235.240.0/20` (`gcloud compute ssh --tunnel-through-iap` or the console's SSH button). No public port |
| Secrets | `/etc/wt/secrets.env`, root 0600, typed by you with `sudo wt-set-secrets`; copied at boot to tmpfs `/run/wt-secrets/env` (`wt:wt 0400`) |

The secrets file is on the persistent disk (Google encrypts it at rest). That is weaker than a vault: root on the
VM and anyone with owner rights on the project can read it. Accepted for a paper-only host; rotate with
`sudo wt-set-secrets` ([secret-rotation.md](secret-rotation.md)).

## 0. Project and billing (owner, once)
1. Use a project of its own (not one shared with other products). Link a billing account: Compute Engine needs one
   even inside the free tier.
2. Billing > Budgets & alerts: a **US$1** budget on this project, email alerts at 50/90/100%.

## 1. Network and VM (owner, in Cloud Shell of that project)
```bash
PROJECT=<project id from: gcloud projects list>
gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com iap.googleapis.com

# SSH only through IAP; nothing else inbound.
gcloud compute firewall-rules delete default-allow-ssh default-allow-rdp --quiet
gcloud compute firewall-rules create allow-ssh-from-iap --network default --direction INGRESS \
  --action allow --rules tcp:22 --source-ranges 35.235.240.0/20

curl -fsSLo wt-cloud-init.yaml \
  https://raw.githubusercontent.com/Algorythmos-AI/trading-lab-research/main/deploy/gcp/cloud-init.yaml
gcloud compute instances create trading-lab-host --zone us-east1-b --machine-type e2-micro \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-standard \
  --no-service-account --no-scopes \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata enable-oslogin=TRUE --metadata-from-file user-data=wt-cloud-init.yaml \
  --deletion-protection
```
First boot takes 10–20 minutes on an e2-micro (packages, uv, the locked environment). Nothing trades: no job timer
is enabled. Follow it with:
```bash
gcloud compute instances get-serial-port-output trading-lab-host --zone us-east1-b | grep -E "cloud-init|Trading Lab" | tail
gcloud compute ssh trading-lab-host --zone us-east1-b --tunnel-through-iap -- \
  'cloud-init status --wait; ls /var/lib/wt-bootstrap-done && free -h && swapon --show'
```

## 2. Secrets (owner)
Have these ready first:
- **Alpaca:** the keys of a *second* paper account (the shadow run never uses the Mac's account).
- **ntfy:** a new `[shadow]` topic, subscribed on your phone. Never reuse the Mac's topic.
- **Dashboard key:** a new secret for key id `gcp-use1` (`openssl rand -hex 32`). In Vercel, Production, add it
  to `DASHBOARD_INGEST_KEYS` as JSON (`{"gcp-use1":"<secret>"}`, merged into any existing map), Sensitive, then
  redeploy the dashboard with the deploy gate open. `PRIMARY_HOST` stays unset, so the Mac stays primary and this
  host's snapshots land in `shadow/latest.json`, which no page or watchdog reads.
- `DASHBOARD_INGEST_URL` and `VERCEL_AUTOMATION_BYPASS_SECRET`: the same values as on the Mac.

Then:
```bash
gcloud compute ssh trading-lab-host --zone us-east1-b --tunnel-through-iap
sudo wt-set-secrets        # hidden prompts; Enter keeps a value; ends with "wt-secrets: ok"
```
`WT_ROLE` stays `shadow` and `DASHBOARD_KEY_ID` stays `gcp-use1`: a shadow host with the default key id refuses to
publish.

## 3. Shadow run (owner enables, Claude checks)
1. KILL on: `sudo -u wt make -C /home/wt/trading kill REASON="GCP shadow"`.
2. `sudo wt-install-units` (refuses while the deploy gate is closed).
3. At least five sessions, then the determinism check and the cutover, as in [oci-host.md](oci-host.md)
   ("Shadow → cutover"). Watch memory on the first sessions: `journalctl -k | grep -i oom` must stay empty.

## Rebuild
Rebuilds come from code. Turn off deletion protection
(`gcloud compute instances update trading-lab-host --zone us-east1-b --no-deletion-protection`), delete the
instance, run the create command in step 1 again, then step 2 again. A primary host restores `var/` from R2 first
([backups-and-lease.md](backups-and-lease.md)).

## Primary host (cutover v2, 2026-10)

The machine-learning environment (`.venv-ml`) needs the system's OpenMP library, which a wheel cannot carry:
`sudo apt-get install -y libgomp1` (first boot installs it; a host built before 2026-10-08 needs it once). A
deploy never swaps in an environment that cannot import its libraries, and `make sync-ml` says whether the live
one can.
The VM is the only host that runs jobs. The Mac is a console for writing code and running these commands.

| | |
|---|---|
| Machine | e2-medium (2 vCPU, 4 GB), us-east1-b, pd-balanced 30 GB, daily snapshot schedule `wt-daily` (7 days) |
| Memory fuses | routine/forward/weekly MemoryHigh 1.5G, MemoryMax 2G; publisher 1G; paper-b uncapped (OOMScoreAdjust -500) |
| Tuning an existing VM | `sudo wt-tune-host` (zram, journald, needrestart, gh and time, git identity); `--check` only reports |

**Moving the state (`wt.ops.hostsync`).** From a checkout of main on the Mac:
```bash
deploy/gcp/bin/wt-seed-vm              # rehearsal: copy and verify into /home/wt/seed-rehearsal, nothing swapped
APPLY=1 deploy/gcp/bin/wt-seed-vm      # cutover: the Mac's com.wt agents must be unloaded first
```
- **What moves:** the forward ledger and the paper journal (hash chains verified), the virtual account and plans, the watchlist, heartbeats, routine output, alert state, and the market data the nightly jobs read (`data/daily`, `edgar`, `pm`, `pm_bars`, `candidates`, `minute`, the volume curve).
- **What never moves:** secrets, the venv, KILL, git-tracked files, the dashboard cache, deploy records, locks, spooled pages, the chain-broken flag, the rate-limit state, and research-only minute data.
- **How `apply` works:** it archives the VM's copy under `/home/wt/archive/hostsync-<stamp>/` and swaps unit by unit, holding every job lock and the deploy lock. A seed that differs from its manifest by one byte, or has a broken chain, is refused.

**Rollback to the Mac** runs the same tool in the other direction:
1. On the VM, run `hostsync manifest` and tar the listed files.
2. On the Mac, extract into a new directory, then `hostsync verify` and `hostsync apply --root ~/trading`.
