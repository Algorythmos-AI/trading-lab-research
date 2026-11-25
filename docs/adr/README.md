# Architecture decision records

Each record keeps the decision as it was taken. Later changes are added to the record as amendments, or made in a
new record that supersedes it. Read the "Now" column first: it says what holds today.

| ADR | Decision | Status | Now |
|---|---|---|---|
| [0001](0001-vercel-dashboard.md) | Status dashboard on Vercel, fed by a signed push | accepted 2026-09-29 | Holds. The push now comes from the GCP host (`wt-dashboard` unit), not the Mac (ADR 0010) |
| [0002](0002-runtime-state-and-deploy-gate.md) | Runtime state outside git; a computed deploy gate | accepted 2026-09-29 | Holds. Jobs run under systemd on the GCP host, not launchd on the Mac (ADR 0010); the gate is in `src/wt/ops/window.py`, the deploy in `src/wt/ops/deploy.py` |
| 0003 | Number not used | — | — |
| [0004](0004-oci-trading-host.md) | Trading host on an OCI Always Free VM | superseded by 0010 on 2026-10-24 | Never provisioned. Its helpers and units (`deploy/oci/bin`, `deploy/oci/systemd`) are what the GCP host runs; its Terraform is a rebuild path only |
| [0005](0005-desks.md) | Desks | accepted 2026-10-04, addenda 2026-10-24/25 | Holds for the stocks and options desks. The crypto desk is closed (DEC-0036) and its code deleted |
| [0006](0006-external-desk.md) | An external desk on the status site | accepted 2026-10-11 | Holds |
| [0007](0007-deploy-notice.md) | The host says when a deploy is ready | accepted 2026-10-12 | The notice holds (`deploy-notify` job). Its "the owner still deploys" part is superseded by 0008 |
| [0008](0008-automatic-deploy.md) | The host deploys itself, inside the same gate | accepted 2026-10-13 (#215) | Holds where the owner has created `var/deploy/AUTO_ON` (`deploy-auto` job) |
| [0009](0009-integration-branch.md) | Work lands on `integration`; `main` is production | accepted 2026-10-18 (#228, #233) | Holds |
| [0010](0010-gcp-trading-host.md) | The trading host is a GCP VM running the OCI host's helpers | accepted 2026-10-24 | Holds. The VM was later resized beyond the free tier; see [gcp-host.md](../runbooks/gcp-host.md) |
| [0011](0011-webull-readonly-host.md) | The owner's Webull account is read on the trading host, read only | accepted 2026-11-15, amended 2026-11-16 | Holds |

Merge dates for 0008 to 0011 come from the commit that added each file to `integration`.

A new record takes the next free number and adds a row here. A test checks that this table lists every file in
this folder (`tests/unit/test_docs_truth.py`).
