# A DEFAULT (shared, Always Free) vault with a software-protected key. The owner creates the secrets in the console
# (never Terraform: secret contents must not reach state). Deleting a vault strands its secrets for 7-30 days, so
# neither can be destroyed by an apply.
resource "oci_kms_vault" "lab" {
  compartment_id = oci_identity_compartment.lab.id
  display_name   = "trading-lab"
  vault_type     = "DEFAULT"
  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_kms_key" "secrets" {
  compartment_id      = oci_identity_compartment.lab.id
  display_name        = "trading-lab-secrets"
  management_endpoint = oci_kms_vault.lab.management_endpoint
  protection_mode     = "SOFTWARE"
  key_shape {
    algorithm = "AES"
    length    = 32
  }
  lifecycle {
    prevent_destroy = true
  }
}
