data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

locals {
  # ap-sydney-1 has one availability domain; capacity retries use fault domains (docs/runbooks/oci-host.md).
  ad = data.oci_identity_availability_domains.ads.availability_domains[0].name
}

# Phase 2 only (enable_instance = true), after the Vault secrets exist and the account is Pay As You Go.
resource "oci_core_instance" "host" {
  count               = var.enable_instance ? 1 : 0
  compartment_id      = oci_identity_compartment.lab.id
  availability_domain = local.ad
  display_name        = "trading-lab-host"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 2 # the whole Always Free Ampere allowance (1,488 of 1,500 OCPU-hours a month)
    memory_in_gbs = 12
  }

  source_details {
    source_type             = "image"
    source_id               = var.image_ocid
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.host.id
    assign_public_ip = true
    hostname_label   = "host"
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  agent_config {
    are_all_plugins_disabled = false
    is_management_disabled   = false
    is_monitoring_disabled   = false
    plugins_config {
      name          = "Bastion" # break-glass access through the OCI Bastion service
      desired_state = "ENABLED"
    }
    plugins_config {
      name          = "Compute Instance Monitoring" # the metrics the instance-down alarm reads
      desired_state = "ENABLED"
    }
  }

  # First boot only. Later host changes ship through wt-deploy, never user_data (changing it would reimage the VM).
  metadata = {
    user_data = base64encode(templatefile("${path.module}/../cloud-init.yaml.tftpl", {
      repo_url = var.repo_url
    }))
    wt_vault_id = oci_kms_vault.lab.id # read by wt-fetch-secrets from instance metadata; not a secret
  }

  preserve_boot_volume = false

  lifecycle {
    prevent_destroy = true
    # A new Oracle image or an edited cloud-init must never recreate or reimage the running host.
    ignore_changes = [source_details[0].source_id, metadata]
    precondition {
      condition     = var.image_ocid != ""
      error_message = "Set image_ocid (Canonical Ubuntu 24.04 aarch64) before enabling the instance."
    }
  }

  depends_on = [oci_limits_quota.always_free, oci_identity_policy.host_reads_its_secrets]
}

# User-defined: one weekly incremental backup kept 21 days (3 at most). Oracle's Silver/Gold keep more than the
# 5 Always Free backups.
resource "oci_core_volume_backup_policy" "weekly" {
  compartment_id = oci_identity_compartment.lab.id
  display_name   = "weekly-21d"
  schedules {
    backup_type       = "INCREMENTAL"
    period            = "ONE_WEEK"
    day_of_week       = "SATURDAY"
    hour_of_day       = 16
    offset_type       = "STRUCTURED"
    retention_seconds = 21 * 24 * 3600
    time_zone         = "UTC"
  }
}

resource "oci_core_volume_backup_policy_assignment" "boot" {
  count     = var.enable_instance ? 1 : 0
  asset_id  = oci_core_instance.host[0].boot_volume_id
  policy_id = oci_core_volume_backup_policy.weekly.id
}
