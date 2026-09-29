# ADR 0004: The trading host moves to an OCI Always Free VM

- **Status:** proposed, 2026-09-30 (plan v4.2 §3)
- **Context:** the Mac's disk and swap made jobs refuse (2026-09-29); the owner chose Oracle Cloud's free tier.

## Decision
1. **One Ampere A1 VM, 2 OCPU / 12 GB, Ubuntu 24.04 aarch64, ap-sydney-1**, Pay As You Go (no idle reclamation),
   held inside Always Free by a single ordered quota policy and a US$1 budget tripwire.
2. **No inbound traffic.** The default security list allows only path-MTU ICMP and SSH from inside the VCN
   (Bastion). Admin access is a Cloudflare tunnel (outbound) behind Cloudflare Access.
3. **Secrets live in OCI Vault**, entered by the owner, read once per boot by root through the instance principal
   into tmpfs (`wt:wt 0400`); paging config is also kept on disk so a Vault outage still pages. The job user can't
   reach the metadata service. Swap is zram (RAM only).
4. **systemd units generated from `JOBS`** (`wt.ops.units`), timers in America/New_York; the job runner handles
   SIGTERM; units restart on failure within a budget; `wt-boot-reconcile` restarts paper-b/forward after a reboot
   inside their windows.
5. **Claude deploys through a forced command** (`wt-deploy`) with an Access service token; the owner installs units.
6. **The host is rebuildable from code** (Terraform in two phases, cloud-init once); backups and anchors live off
   OCI (Cloudflare R2, O-3); healthchecks.io and the Vercel watchdog watch it from outside.

## Consequences
- The deploy gate, the collector and the job runner work on both hosts (`wt.ops.host`); the Mac keeps research.
- Always Free can change without notice (the 2026 halving): the quota and budget make any drift visible, and the
  Mac is the documented fall-back.
