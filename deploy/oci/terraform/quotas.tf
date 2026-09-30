# One quota policy, statements in this order (most restrictive across policies wins, so a separate "zero compute"
# policy would block A1 too). It keeps the tenancy inside Always Free even on Pay As You Go: 2 Ampere OCPUs and
# 12 GB, no other compute, 200 GB of block storage and 5 backups, no paid private vaults.
resource "oci_limits_quota" "always_free" {
  compartment_id = var.tenancy_ocid
  name           = "always-free-only"
  description    = "Keep the trading-lab tenancy inside OCI Always Free (plan v4.2)."
  statements = [
    "zero compute-core quotas in tenancy",
    "set compute-core quota standard-a1-core-count to 2 in tenancy",
    "zero compute-memory quotas in tenancy",
    "set compute-memory quota standard-a1-memory-count to 12 in tenancy",
    "set block-storage quota total-storage-gb to 200 in tenancy",
    "set block-storage quota backup-count to 5 in tenancy",
    "zero kms quota virtual-private-vault-count in tenancy",
  ]
}

resource "oci_budget_budget" "tripwire" {
  compartment_id = var.tenancy_ocid
  display_name   = "always-free-tripwire"
  description    = "Any spend at all means something left Always Free."
  amount         = 1
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.tenancy_ocid]
}

resource "oci_budget_alert_rule" "any_spend" {
  budget_id      = oci_budget_budget.tripwire.id
  display_name   = "any-actual-spend"
  type           = "ACTUAL"
  threshold      = 50
  threshold_type = "PERCENTAGE"
  recipients     = var.owner_email
  message        = "OCI spend is above US$0.50 this month: something is outside Always Free. Check Cost Analysis."
}

resource "oci_budget_alert_rule" "forecast" {
  budget_id      = oci_budget_budget.tripwire.id
  display_name   = "forecast-spend"
  type           = "FORECAST"
  threshold      = 100
  threshold_type = "PERCENTAGE"
  recipients     = var.owner_email
  message        = "OCI forecasts spend above US$1 this month."
}
