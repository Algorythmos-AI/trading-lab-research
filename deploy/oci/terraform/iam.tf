resource "oci_identity_compartment" "lab" {
  compartment_id = var.tenancy_ocid
  name           = var.compartment_name
  description    = "Trading Lab paper-trading host (ADR 0004)."
  enable_delete  = false
}

# Any instance in the compartment (so a rebuilt VM keeps working without an IAM change).
resource "oci_identity_dynamic_group" "host" {
  compartment_id = var.tenancy_ocid
  name           = "wt-host"
  description    = "Instances in the trading-lab compartment."
  matching_rule  = "ALL {instance.compartment.id = '${oci_identity_compartment.lab.id}'}"
}

# The only thing the VM's instance principal may do: read the secret bundles of this one vault.
resource "oci_identity_policy" "host_reads_its_secrets" {
  compartment_id = var.tenancy_ocid
  name           = "wt-host-reads-its-secrets"
  description    = "The trading VM reads its own secrets at boot, nothing else."
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.host.name} to read secret-bundles in compartment ${oci_identity_compartment.lab.name} where target.vault.id = '${oci_kms_vault.lab.id}'",
  ]
}
