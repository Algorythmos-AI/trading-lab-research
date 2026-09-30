terraform {
  # OCI Resource Manager runs Terraform 1.5.x at most (and Cloud Shell ships 1.5.7): stay 1.5-compatible.
  required_version = ">= 1.5.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 7.0.0, < 10.0.0"
    }
  }
}

# Applied by the owner in OCI Resource Manager (the stack's region and tenancy come from there), or locally with
# an API key profile. No state and no tfvars are ever committed (.gitignore).
provider "oci" {
  region = var.region
}
