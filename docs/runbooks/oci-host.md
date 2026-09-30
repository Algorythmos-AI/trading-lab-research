# The OCI trading host: provision, operate, rebuild (ADR 0004)

The trading jobs move from the Mac to one OCI **Always Free** Ampere VM (2 OCPU / 12 GB) in **ap-sydney-1**.
Owner steps are marked **(owner)**; Claude never types a secret, applies the stack, or (re)loads units.

## 0. Account (owner, once)
1. Wait until the console stops showing "account provisioning is in progress".
2. **Upgrade to Pay As You Go**: Billing > Upgrade and Manage Payment. Oracle places a US$100 authorization
   (reversed) and the upgrade can take a day or two. PAYG stops idle reclamation and helps with Ampere capacity; you
   pay nothing while usage stays inside Always Free, and the stack's quota policy keeps it there. **The shadow run
   and the cutover wait for the PAYG confirmation email.** Use a real card, not a virtual one.
3. Turn on MFA for your console user.

## 1. Phase 1: quotas, network, IAM, Vault, budget (owner)
1. Resource Manager > Stacks > Create stack > "My configuration": upload `deploy/oci/terraform` (zip the folder).
2. Variables: `owner_email` = your email. Leave `enable_instance = false`.
3. Plan, read it (nothing should cost money: quotas, a VCN with no inbound rule, a DEFAULT vault, a US$1 budget),
   then Apply. Confirm the email subscription Oracle sends for the alarm topic.

## 2. Secrets (owner, in the console; never in Terraform)
Vault `trading-lab` > Secrets > Create secret, encryption key `trading-lab-secrets`. The **secret name is the
variable name**:

| Required | Optional |
|---|---|
| `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` (the *second* paper account during the shadow run) | `HC_PING_KEY` |
| `DASHBOARD_INGEST_URL`, `DASHBOARD_INGEST_SECRET` | `WT_HOST_ID` (e.g. `oci-syd`), `WT_ROLE` (`shadow`, later `primary`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` |
| `NTFY_TOPIC` (a *separate* `[shadow]` topic during the shadow run) | `CLOUDFLARED_TOKEN` (step 4) |

## 3. Phase 2: the VM (owner)
1. Compute > Images > Platform images: **Canonical Ubuntu 24.04** for **aarch64** (not "Minimal"). Copy its OCID
   into the stack variable `image_ocid`; set `enable_instance = true`. Plan, then Apply.
2. "Out of host capacity": Sydney has one availability domain; wait and Apply again later (PAYG helps).
3. First boot takes ~10 minutes (packages, uv, the locked environment). Nothing trades: no job timer is enabled.

## 4. Admin access through Cloudflare (owner)
1. Zero Trust > Networks > Tunnels > Create tunnel "trading-lab-host" (cloudflared). Copy the token into the
   vault as `CLOUDFLARED_TOKEN`. The VM picks it up within 10 minutes (wt-secrets.timer) and wt-tunnel starts.
2. In the tunnel, add a public hostname for SSH (service `ssh://localhost:22`).
3. Zero Trust > Access > Applications > Self-hosted, that hostname. Policies:
   - "owner": Allow, your Google account (one-time PIN as the fallback identity);
   - "claude-deploy": **Service Auth**, a service token you create (Access > Service credentials), 1-year expiry,
     expiry notification on.
4. On the Mac: `.env` gets `VM_SSH_HOST`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. Install the pinned
   cloudflared **2026.5.1** (2026.6.0+ ignores service tokens) and point `CLOUDFLARED` at it if it isn't first on PATH.
5. Claude's key: `ssh-keygen -t ed25519 -f ~/.ssh/wt-deploy` on the Mac. On the VM (your session), add to
   `/home/wt/.ssh/authorized_keys`: `restrict,command="/usr/local/bin/wt-deploy" ssh-ed25519 AAAA… wt-deploy`.
   That key can only run `gate | status | preflight | deploy | units-diff | rollback runtime-…`, as `wt`, no sudo.
6. Break-glass: OCI Bastion (managed SSH session; the plugin is enabled) or the serial console (set a local password
   for `ubuntu` from a Bastion session and keep it in your password manager).

## 5. Acceptance (Claude runs, you watch)
`make vm-deploy VERB=preflight`, then `VERB=deploy` (runs the full test suite on ARM64; rolls back on failure).
Checks: no open ports from outside; `wt` can't reach 169.254.169.254; secrets only in `/run/wt-secrets/env`
(`wt:wt 0400`); `restic` restore test (O-3); healthchecks and the OCI alarm fire when a test unit is stopped.

## 6. Units (owner)
`sudo wt-install-units` renders the job units from the code and enables their timers. It refuses while the deploy
gate is closed. During the shadow run the VM uses the second paper account, `WT_ROLE=shadow`, KILL on.

## Rebuild (new VM)
**Terminate the old instance first**: 2 OCPU running all month is 1,488 of the 1,500 free OCPU-hours, so two VMs
at once is billed. Then Apply phase 2 again (same `image_ocid`), and restore state from R2 (O-3 runbook).

## If the OCI account is lost
Oracle has deleted Always Free accounts without notice. The Mac takes over from the R2 backups: install the
launchd agents again (`make install-trading-agents`), restore `var/` and `data/live/` from restic, regenerate the
trading account's Alpaca key (the VM's copy dies with it), KILL on for the first night.
