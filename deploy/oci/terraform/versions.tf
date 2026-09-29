terraform {
  required_version = ">= 1.6.0"
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
