output "ecs_instance_id" {
  value = alicloud_instance.tradeflow.id
}

output "ecs_public_ip" {
  value = alicloud_instance.tradeflow.public_ip
}

output "oss_bucket_name" {
  value = alicloud_oss_bucket.backups.bucket
}

output "oss_region" {
  value = var.region
}

output "backup_prefix" {
  value = var.backup_prefix
}

output "ram_role_name" {
  value = alicloud_ram_role.tradeflow_ecs.id
}

output "data_disk_id" {
  value       = alicloud_ecs_disk.data.id
  description = "New blank encrypted disk; verify its device with lsblk before formatting and mounting it."
}
