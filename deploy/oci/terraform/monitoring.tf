resource "oci_ons_notification_topic" "ops" {
  compartment_id = oci_identity_compartment.lab.id
  name           = "trading-lab-ops"
  description    = "Infrastructure alarms for the trading host."
}

resource "oci_ons_subscription" "owner" {
  compartment_id = oci_identity_compartment.lab.id
  topic_id       = oci_ons_notification_topic.ops.id
  protocol       = "EMAIL"
  endpoint       = var.owner_email
}

# No CPU metric for 10 minutes means the instance is stopped, reclaimed or wedged. (OCI alarms can't fire if the
# whole account is suspended: healthchecks.io and the Vercel watchdog cover that from outside.)
resource "oci_monitoring_alarm" "host_silent" {
  count                        = var.enable_instance ? 1 : 0
  compartment_id               = oci_identity_compartment.lab.id
  metric_compartment_id        = oci_identity_compartment.lab.id
  display_name                 = "trading-host-silent"
  namespace                    = "oci_computeagent"
  query                        = "CpuUtilization[5m]{resourceId = \"${oci_core_instance.host[0].id}\"}.absent()"
  severity                     = "CRITICAL"
  pending_duration             = "PT10M"
  destinations                 = [oci_ons_notification_topic.ops.id]
  is_enabled                   = true
  body                         = "The trading host has reported no metrics for 10 minutes (stopped, reclaimed or hung)."
  repeat_notification_duration = "PT4H"
}
