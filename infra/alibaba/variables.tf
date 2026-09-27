variable "region" {
  description = "Alibaba Cloud region shared by ECS and OSS, for example cn-hangzhou."
  type        = string
}

variable "availability_zone" {
  description = "An available zone in region with the selected instance type and disk category."
  type        = string
}

variable "instance_type" {
  description = "ECS instance type selected after checking regional availability and price."
  type        = string
}

variable "image_id" {
  description = "Current Alibaba Cloud Linux 3 image ID for the selected region."
  type        = string
}

variable "ecs_key_pair_name" {
  description = "Existing ECS key pair name used for SSH access. Keep the private key outside this project."
  type        = string
}

variable "admin_ssh_cidr" {
  description = "Optional administrator public IPv4 CIDR allowed to SSH, preferably x.x.x.x/32. Empty disables port 22 ingress."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_ssh_cidr == "" || (can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/32$", var.admin_ssh_cidr)) && can(cidrhost(var.admin_ssh_cidr, 0)))
    error_message = "Set admin_ssh_cidr to an administrator IPv4 /32 address, or leave it empty to disable SSH ingress."
  }
}

variable "bucket_name" {
  description = "Globally unique OSS bucket name used only for TradeFlow database backups."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a 3-63 character lowercase OSS name using letters, digits, or hyphens."
  }
}

variable "backup_prefix" {
  description = "Object prefix that the ECS RAM role may list, read and write."
  type        = string
  default     = "tradeflow"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$", var.backup_prefix))
    error_message = "backup_prefix must contain only letters, digits, dots, underscores, and hyphens."
  }
}

variable "backup_retention_days" {
  description = "OSS lifecycle retention for objects under the TradeFlow backup prefix."
  type        = number
  default     = 365

  validation {
    condition     = var.backup_retention_days >= 30 && var.backup_retention_days <= 3650
    error_message = "backup_retention_days must be between 30 and 3650 days."
  }
}

variable "ecs_snapshot_retention_days" {
  description = "Retention period for daily automatic ECS snapshots of the system and data disks."
  type        = number
  default     = 7

  validation {
    condition     = var.ecs_snapshot_retention_days >= 1 && var.ecs_snapshot_retention_days <= 365
    error_message = "ecs_snapshot_retention_days must be between 1 and 365 days."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "vswitch_cidr" {
  type    = string
  default = "10.42.1.0/24"
}

variable "data_disk_size_gib" {
  description = "Persistent ECS data disk size in GiB."
  type        = number
  default     = 40

  validation {
    condition     = var.data_disk_size_gib >= 20 && var.data_disk_size_gib <= 32768
    error_message = "data_disk_size_gib must be between 20 and 32768 GiB; confirm the selected disk category supports it."
  }
}

variable "data_disk_category" {
  description = "ECS data disk category available in the selected zone, such as cloud_essd_entry."
  type        = string
  default     = "cloud_essd_entry"
}

variable "system_disk_category" {
  description = "ECS system disk category available for the selected instance type and zone."
  type        = string
  default     = "cloud_essd_entry"
}

variable "system_disk_size_gib" {
  type    = number
  default = 40

  validation {
    condition     = var.system_disk_size_gib >= 40 && var.system_disk_size_gib <= 500
    error_message = "system_disk_size_gib must be between 40 and 500 GiB."
  }
}

variable "internet_bandwidth_mbps" {
  description = "Public outbound bandwidth cap; ECS is billed separately."
  type        = number
  default     = 5

  validation {
    condition     = var.internet_bandwidth_mbps >= 1 && var.internet_bandwidth_mbps <= 100
    error_message = "internet_bandwidth_mbps must be between 1 and 100 Mbps."
  }
}

variable "name_prefix" {
  type    = string
  default = "tradeflow"
}
