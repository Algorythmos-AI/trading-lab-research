# ADR 0010: The trading host is a GCP free-tier VM running the OCI host's helpers

- **Status:** accepted on merge by the owner. Supersedes [ADR 0004](0004-oci-trading-host.md).
- **Context:** ADR 0004 chose an Oracle Cloud Always Free VM. Oracle had no Ampere capacity, so the jobs moved to a
  Google Cloud VM instead (`trading-lab-host`), and it has run them since. ADR 0004 still read "proposed" and
  described a host that never existed.

## Decision

1. **The host is one Google Cloud VM**, provisioned and operated as [docs/runbooks/gcp-host.md](../runbooks/gcp-host.md)
   describes. The runbook is the source for its size, region, disk and costs, not this record.
2. **It runs the OCI host's code unchanged:** the helpers in `deploy/oci/bin`, the systemd units generated from
   `wt.ops.schedule` (`wt.ops.units`), timers in America/New_York. Only the first boot (`deploy/gcp/cloud-init.yaml`)
   and the secrets source differ.
3. **No inbound port.** SSH only through Google's IAP range; the VM has no service account, and the `wt` user is
   firewalled off the metadata server.
4. **Secrets live in `/etc/wt/secrets.env`** (root 0600), typed by the owner with `sudo wt-set-secrets`, copied at
   boot to tmpfs. This is weaker than a vault and is accepted for a paper-only host. *Amended by
   [ADR 0011](0011-webull-readonly-host.md): the host also holds the owner's Webull key, which can place real
   orders; that key is kept apart from these secrets, under the controls ADR 0011 lists.*
5. **GitHub access is one fine-grained token** used through `gh` as the git credential helper, because the
   organisation does not allow deploy keys. The repositories are private.
6. **Deploys follow ADR 0008 and ADR 0009:** the gated automatic deploy takes the green tip of `main`; changes to
   the owner paths are deployed by the owner by hand.

## Consequences

- Every reference to "the OCI host" in code names the helpers, not the cloud: `deploy/oci/` keeps its name.
- [docs/runbooks/oci-host.md](../runbooks/oci-host.md) stays as the rebuild path if Oracle capacity returns; it is not
  the running host.
- Rebuilding the host is the GCP runbook from step 0; the Mac is not a fall-back for the scheduled jobs.
