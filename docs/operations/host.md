# The trading host

One GCP VM runs every scheduled job (ADR 0010). This page says what the host is and how it is put together. The
step-by-step provisioning, secrets, resize and rebuild procedures are in [gcp-host.md](../runbooks/gcp-host.md).
This page is public, so it holds no IP addresses, project or account IDs, or secret values.

## What it is (read live on 2026-11-25, read-only `gcloud compute instances describe`)

| | |
|---|---|
| Name and zone | `trading-lab-host`, `us-east1-b` |
| Machine | `e2-standard-2` (2 vCPU, 8 GB). It was created as a free-tier `e2-micro` and resized later; the original create command is kept in [gcp-host.md](../runbooks/gcp-host.md) |
| Boot disk | 60 GB `pd-balanced` |
| OS | Ubuntu 24.04, first boot from `deploy/gcp/cloud-init.yaml` |
| Cloud credentials on the VM | None: no service account is attached |
| Shielded VM | Secure boot, vTPM and integrity monitoring on |
| Inbound | SSH on tcp:22 from Google's IAP range only (`gcloud compute ssh --tunnel-through-iap`). Besides that, only GCP's default ICMP and internal-network rules |
| Optional admin path | A Cloudflare tunnel (`wt-tunnel`), outbound only, when `/etc/cloudflared/token` exists |

## Users and directories

| User | Runs | Home / files |
|---|---|---|
| `wt` | Every job unit, `wt-deploy`, the backups | `/home/wt/trading` (the live checkout, its `.venv`, `var/`, `data/`, `logs/`) |
| `wt-webull` | `wt-webull-pull` only, from a root-owned copy of `src/wt/webull` in `/opt/wt-webull` (ADR 0011) | its own state directory; the key comes through systemd `LoadCredential` |
| `cloudflared` | `wt-tunnel` | `/etc/cloudflared/token` |
| root | `wt-secrets` (boot), `wt-boot-reconcile`, the owner's `sudo` helpers | `/etc/wt/` |

## Secrets flow (names in [env-vars.md](../reference/env-vars.md))

```
owner, in an SSH session ── sudo wt-set-secrets ──► /etc/wt/secrets.env       (root, 0600, on disk)
boot: wt-secrets.service ── wt-fetch-secrets ─────► /run/wt-secrets/env      (tmpfs, wt:wt 0400)
                                                └─► /etc/wt/paging           (ntfy settings, so a failed fetch still pages)
every job unit: EnvironmentFile=/run/wt-secrets/env
Webull: sudo wt-set-webull-secret ─► /etc/wt/webull.env ─► LoadCredential= for wt-webull-pull only
```

`/etc/wt/secrets-source` says where the fetch reads from. GCP's cloud-init writes `file`
(`deploy/gcp/cloud-init.yaml`). Without that file `wt-fetch-secrets` defaults to OCI Vault, the source designed for
the OCI host that was never provisioned (ADR 0004).

## The host helpers (`deploy/oci/bin`, installed to `/usr/local/bin`)

The folder is named `oci` because the helpers were written for the OCI host (ADR 0004). The GCP host runs them
unchanged (ADR 0010).

| Helper | Who runs it | What it does |
|---|---|---|
| `wt-deploy` | `wt`, as `sudo -u wt /usr/local/bin/wt-deploy <cmd>` | The only deploy entry point: `gate`, `status`, `preflight`, `deploy [<sha>]`, `units-diff`, `rollback runtime-<tag>` ([deploy.md](deploy.md)) |
| `wt-install-units` | owner, `sudo` | Installs the rendered job units and the static units, and enables the timers. Refuses while the deploy gate is closed |
| `wt-set-secrets` | owner, `sudo` | Prompts for each secret (hidden) and writes `/etc/wt/secrets.env` |
| `wt-set-webull-secret` | owner, `sudo` | Writes `/etc/wt/webull.env` |
| `wt-fetch-secrets` | root, at boot | Copies the secrets into tmpfs; writes the paging file |
| `wt-boot-reconcile` | root, at boot | Starts a desk or job whose window the boot fell into |
| `wt-alert` | root, on a unit's failure | Pages the owner through ntfy |
| `wt-webull-code` | `wt-install-units` | Installs the Webull reader's code, only at the tree hash the owner names |

`deploy/gcp/bin` holds two GCP-only helpers:
- `wt-seed-vm` runs on the Mac and carries runtime state to the host;
- `wt-tune-host` brings an existing host in line with the current cloud-init.

## Units

See [jobs.md](jobs.md): the generated job units, and the static units in `deploy/oci/systemd`.

## What only the owner does here

These are never done by an automated contributor ([AGENTS.md](../../AGENTS.md), rules 3 and 4):

- install or change units (`sudo wt-install-units`);
- set secrets;
- create or remove `var/deploy/AUTO_ON`;
- resize, stop or rebuild the VM;
- stop a desk's unit.

## Not readable from the code (host state, unverified 2026-11-25)

- whether `var/deploy/AUTO_ON` exists;
- whether the installed units match the code;
- the host's `WT_ROLE`, and which `APCA_*` key pairs it holds;
- which optional timers (backup, Webull) are enabled.
