resource "oci_core_vcn" "lab" {
  compartment_id = oci_identity_compartment.lab.id
  display_name   = "trading-lab"
  cidr_blocks    = [var.vcn_cidr]
  dns_label      = "tradinglab"
}

resource "oci_core_internet_gateway" "out" {
  compartment_id = oci_identity_compartment.lab.id
  vcn_id         = oci_core_vcn.lab.id
  display_name   = "outbound"
  enabled        = true
}

resource "oci_core_default_route_table" "default" {
  manage_default_resource_id = oci_core_vcn.lab.default_route_table_id
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.out.id
  }
}

# The VCN's default security list allows SSH from anywhere until it is managed: here it allows no inbound traffic
# except path-MTU ICMP and SSH from inside the VCN (the Bastion service). Admin access is the Cloudflare tunnel,
# which only connects outwards.
resource "oci_core_default_security_list" "default" {
  manage_default_resource_id = oci_core_vcn.lab.default_security_list_id
  display_name               = "no-inbound"
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "1" # ICMP
    icmp_options {
      type = 3
      code = 4
    }
  }
  ingress_security_rules {
    source   = var.vcn_cidr
    protocol = "6" # TCP
    tcp_options {
      min = 22
      max = 22
    }
  }
}

resource "oci_core_subnet" "host" {
  compartment_id             = oci_identity_compartment.lab.id
  vcn_id                     = oci_core_vcn.lab.id
  display_name               = "host"
  cidr_block                 = var.subnet_cidr
  dns_label                  = "host"
  prohibit_public_ip_on_vnic = false # an ephemeral public IP, for outbound traffic only
  security_list_ids          = [oci_core_vcn.lab.default_security_list_id]
  route_table_id             = oci_core_vcn.lab.default_route_table_id
}
