# Only non-secret settings. Identifiers (OCIDs) are passed at apply time (Resource Manager variables or an
# untracked terraform.tfvars); nothing here names a real resource.

variable "tenancy_ocid" {
  description = "Tenancy OCID (Resource Manager fills it in)."
  type        = string
}

variable "region" {
  description = "Home region: Always Free resources exist only here."
  type        = string
  default     = "ap-sydney-1"
}

variable "owner_email" {
  description = "Where budget, alarm and notification emails go."
  type        = string
}

variable "compartment_name" {
  type    = string
  default = "trading-lab"
}

variable "enable_instance" {
  description = "Phase 1 (false): quotas, network, IAM, Vault, budget, alarm. Phase 2 (true), after the owner has entered the Vault secrets and the account is PAYG: the VM."
  type        = bool
  default     = false
}

variable "image_ocid" {
  description = "Canonical Ubuntu 24.04 aarch64 (not Minimal) image OCID, resolved ONCE and pinned here. A new Oracle image release must never replace the boot volume."
  type        = string
  default     = ""
  validation {
    condition     = var.image_ocid == "" || can(regex("^ocid1\\.image\\.", var.image_ocid))
    error_message = "image_ocid must be an image OCID (ocid1.image...)."
  }
}

variable "vcn_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "subnet_cidr" {
  type    = string
  default = "10.40.1.0/24"
}

variable "boot_volume_gb" {
  description = "Boot volume size. Always Free allows 200 GB of block storage in total."
  type        = number
  default     = 100
  validation {
    condition     = var.boot_volume_gb >= 50 && var.boot_volume_gb <= 150
    error_message = "Keep the boot volume between 50 and 150 GB (200 GB is the Always Free total)."
  }
}

variable "repo_url" {
  description = "HTTPS clone URL of the trading repository (public today; a read-only deploy key once private)."
  type        = string
  default     = "https://github.com/Algorythmos-AI/trading-lab-research.git"
}
