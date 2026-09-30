"""The OCI host's infrastructure as code (deploy/oci, ADR 0004): the reviewed design decisions, pinned by test.
Terraform itself is formatted and validated in CI (.github/workflows/infra.yml)."""
from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
OCI = ROOT / "deploy" / "oci"
TF = OCI / "terraform"


def tf(name: str) -> str:
    return (TF / name).read_text()


def cloud_init() -> dict:
    text = (OCI / "cloud-init.yaml.tftpl").read_text()
    assert text.startswith("#cloud-config\n")
    rendered = text.replace("${repo_url}", "https://example.invalid/repo.git").replace("$${", "${")
    return yaml.safe_load(rendered)


def test_no_oracle_identifiers_or_secrets_are_committed():
    ocid = re.compile(r"ocid1\.[a-z]+\.oc\d\.[a-z0-9-]*\.[a-z0-9]{20,}")
    for p in OCI.rglob("*"):
        if p.is_file():
            text = p.read_text(errors="replace")
            assert not ocid.search(text), f"an OCID is committed in {p.relative_to(ROOT)}"
            assert "PRIVATE KEY" not in text, p
    gi = (TF / ".gitignore").read_text()
    assert "*.tfstate" in gi and "*.tfvars" in gi


def test_one_quota_policy_in_the_order_that_keeps_a1_usable():
    block = re.search(r"statements = \[(.*?)\]", tf("quotas.tf"), re.S).group(1)
    statements = re.findall(r'"((?:zero|set) [^"]+)"', block)
    assert statements[:4] == [
        "zero compute-core quotas in tenancy",
        "set compute-core quota standard-a1-core-count to 2 in tenancy",
        "zero compute-memory quotas in tenancy",
        "set compute-memory quota standard-a1-memory-count to 12 in tenancy",
    ]
    assert tf("quotas.tf").count('resource "oci_limits_quota"') == 1


def test_no_inbound_traffic_from_the_internet():
    net = tf("network.tf")
    rules = re.findall(r"ingress_security_rules \{(.*?)\n  \}", net, re.S)
    assert len(rules) == 2
    for r in rules:
        if '"0.0.0.0/0"' in r:
            assert 'protocol = "1"' in r and "type = 3" in r and "code = 4" in r      # path-MTU ICMP only
        else:
            assert "source   = var.vcn_cidr" in r                                        # Bastion, inside the VCN
    assert "oci_core_default_security_list" in net                                      # the permissive default is managed


def test_the_instance_can_never_be_replaced_by_an_apply():
    inst = tf("instance.tf")
    assert "prevent_destroy = true" in inst
    assert "ignore_changes = [source_details[0].source_id, metadata]" in inst
    assert "are_legacy_imds_endpoints_disabled = true" in inst
    assert "ocpus         = 2" in inst and "memory_in_gbs = 12" in inst
    assert "depends_on = [oci_limits_quota.always_free" in inst
    assert 'retention_seconds = 21 * 24 * 3600' in inst and '"ONE_WEEK"' in inst      # at most 3 of 5 free backups


def test_the_vault_and_key_can_never_be_destroyed_and_hold_no_secret_values():
    v = tf("vault.tf")
    assert v.count("prevent_destroy = true") == 2
    assert 'vault_type     = "DEFAULT"' in v and 'protection_mode     = "SOFTWARE"' in v
    assert "oci_vault_secret" not in "".join(p.read_text() for p in TF.glob("*.tf"))   # secrets never in state


def test_first_boot_hardening():
    ci = cloud_init()
    files = {f["path"]: f["content"] for f in ci["write_files"]}
    assert "server 169.254.169.254" in files["/etc/chrony/sources.d/oci.sources"]
    assert "zram0" in files["/etc/systemd/zram-generator.conf"]                         # no swap on disk
    assert "override_rc" in files["/etc/needrestart/conf.d/wt.conf"]
    assert '"false"' in files["/etc/apt/apt.conf.d/52wt-unattended"]
    assert "Sat 16:00 UTC" in files["/etc/systemd/system/apt-daily-upgrade.timer.d/saturday.conf"]
    cmds = [" ".join(c) if isinstance(c, list) else c for c in ci["runcmd"]]
    assert any("--uid-owner wt" in c and "169.254.169.254" in c for c in cmds)
    assert any("uv/0.11.7" in c for c in cmds) and any("oci-cli==3.94.1" in c for c in cmds)
    assert any("apt-mark hold cloudflared" in c for c in cmds)
    assert not any("wt-routine.timer" in c or "wt-paper-b.timer" in c for c in cmds)    # the owner enables jobs


def test_every_host_file_cloud_init_installs_exists():
    for name in ("wt-fetch-secrets", "wt-alert", "wt-boot-reconcile", "wt-deploy", "wt-install-units"):
        p = OCI / "bin" / name
        assert p.exists() and p.stat().st_mode & 0o111, name
    for name in ("wt-secrets.service", "wt-secrets.timer", "wt-alert@.service", "wt-boot-reconcile.service"):
        assert (OCI / "systemd" / name).exists(), name


def test_the_pager_does_not_depend_on_the_secrets_it_may_be_reporting():
    unit = (OCI / "systemd" / "wt-alert@.service").read_text()
    assert "wt-secrets" not in unit.split("[Service]")[0].replace("# Deliberately no dependency on wt-secrets", "")
    assert "/etc/wt/paging" in (OCI / "bin" / "wt-alert").read_text()


def test_the_deploy_command_allows_only_its_verbs():
    text = (OCI / "bin" / "wt-deploy").read_text()
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    assert "SSH_ORIGINAL_COMMAND" in code
    assert not re.search(r"(^|[;&|(]|then|do)\s*sudo\s", code, re.M)     # sudo is never *run* (only named in a hint)
    verbs = re.findall(r"^\s{2}([a-z|\\ -]+(?:runtime-\*)?)\)", text, re.M)
    assert verbs == ["gate|status|preflight", "units-diff", "deploy", "rollback\\ runtime-*"]



def test_terraform_stays_compatible_with_resource_manager():
    """OCI Resource Manager's newest Terraform is 1.5.x: the stack must accept it, and CI must validate with it."""
    versions = (ROOT / "deploy/oci/terraform/versions.tf").read_text()
    assert 'required_version = ">= 1.5.0"' in versions
    infra = (ROOT / ".github/workflows/infra.yml").read_text()
    assert "terraform_version: 1.5.7" in infra
