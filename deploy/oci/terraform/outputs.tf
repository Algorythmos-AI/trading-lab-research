output "compartment_id" {
  value = oci_identity_compartment.lab.id
}

output "vault_id" {
  description = "Create the secrets in this vault (docs/runbooks/oci-host.md) before phase 2."
  value       = oci_kms_vault.lab.id
}

output "secrets_key_id" {
  value = oci_kms_key.secrets.id
}

output "instance_id" {
  value = var.enable_instance ? oci_core_instance.host[0].id : null
}
