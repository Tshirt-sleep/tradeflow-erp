resource "alicloud_vpc" "tradeflow" {
  vpc_name   = "${var.name_prefix}-vpc"
  cidr_block = var.vpc_cidr
}

resource "alicloud_vswitch" "tradeflow" {
  vpc_id       = alicloud_vpc.tradeflow.id
  cidr_block   = var.vswitch_cidr
  zone_id      = var.availability_zone
  vswitch_name = "${var.name_prefix}-vswitch"
}

resource "alicloud_security_group" "tradeflow" {
  security_group_name = "${var.name_prefix}-sg"
  description         = "TradeFlow HTTPS ingress; SSH only from an optional administrator CIDR."
  vpc_id              = alicloud_vpc.tradeflow.id
}

resource "alicloud_security_group_rule" "http" {
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "80/80"
  nic_type          = "intranet"
  policy            = "accept"
  priority          = 1
  security_group_id = alicloud_security_group.tradeflow.id
  cidr_ip           = "0.0.0.0/0"
  description       = "HTTP for redirect and certificate validation only."
}

resource "alicloud_security_group_rule" "https" {
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "443/443"
  nic_type          = "intranet"
  policy            = "accept"
  priority          = 1
  security_group_id = alicloud_security_group.tradeflow.id
  cidr_ip           = "0.0.0.0/0"
  description       = "HTTPS reverse proxy."
}

resource "alicloud_security_group_rule" "ssh" {
  count = var.admin_ssh_cidr == "" ? 0 : 1

  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "22/22"
  nic_type          = "intranet"
  policy            = "accept"
  priority          = 1
  security_group_id = alicloud_security_group.tradeflow.id
  cidr_ip           = var.admin_ssh_cidr
  description       = "Restricted administrator SSH source."
}

resource "alicloud_instance" "tradeflow" {
  instance_name              = "${var.name_prefix}-app"
  instance_type              = var.instance_type
  image_id                   = var.image_id
  instance_charge_type       = "PostPaid"
  internet_charge_type       = "PayByTraffic"
  internet_max_bandwidth_out = var.internet_bandwidth_mbps
  availability_zone          = var.availability_zone
  vswitch_id                 = alicloud_vswitch.tradeflow.id
  security_groups            = [alicloud_security_group.tradeflow.id]
  key_name                   = var.ecs_key_pair_name
  system_disk_category       = var.system_disk_category
  system_disk_size           = var.system_disk_size_gib
  system_disk_encrypted      = true

  tags = {
    Application = "TradeFlow"
    ManagedBy   = "Terraform"
  }

}

resource "alicloud_ecs_disk" "data" {
  zone_id              = var.availability_zone
  disk_name            = "${var.name_prefix}-data"
  category             = var.data_disk_category
  size                 = var.data_disk_size_gib
  encrypted            = true
  delete_with_instance = false

  tags = {
    Application = "TradeFlow"
    ManagedBy   = "Terraform"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_ecs_disk_attachment" "data" {
  disk_id     = alicloud_ecs_disk.data.id
  instance_id = alicloud_instance.tradeflow.id
}

resource "alicloud_ecs_auto_snapshot_policy" "tradeflow" {
  auto_snapshot_policy_name = "${var.name_prefix}-daily-snapshots"
  repeat_weekdays           = ["1", "2", "3", "4", "5", "6", "7"]
  retention_days            = var.ecs_snapshot_retention_days
  time_points               = ["3"]

  tags = {
    Application = "TradeFlow"
    ManagedBy   = "Terraform"
  }
}

resource "alicloud_ecs_auto_snapshot_policy_attachment" "system_disk" {
  auto_snapshot_policy_id = alicloud_ecs_auto_snapshot_policy.tradeflow.id
  disk_id                 = alicloud_instance.tradeflow.system_disk_id
}

resource "alicloud_ecs_auto_snapshot_policy_attachment" "data_disk" {
  auto_snapshot_policy_id = alicloud_ecs_auto_snapshot_policy.tradeflow.id
  disk_id                 = alicloud_ecs_disk.data.id
}

resource "alicloud_oss_bucket" "backups" {
  bucket          = var.bucket_name
  storage_class   = "Standard"
  redundancy_type = "LRS"

  server_side_encryption_rule {
    sse_algorithm = "AES256"
  }

  lifecycle_rule {
    id      = "tradeflow-backup-retention"
    prefix  = "${var.backup_prefix}/"
    enabled = true

    expiration {
      days = var.backup_retention_days
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_oss_bucket_acl" "backups" {
  bucket = alicloud_oss_bucket.backups.bucket
  acl    = "private"
}

resource "alicloud_ram_role" "tradeflow_ecs" {
  role_name   = "${var.name_prefix}-ecs-backup"
  description = "Instance role limited to the TradeFlow backup prefix in OSS."
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = ["ecs.aliyuncs.com"] }
    }]
  })
}

resource "alicloud_ram_policy" "oss_backup" {
  policy_name = "${var.name_prefix}-oss-backup"
  description = "List, read and write only TradeFlow backup objects."
  force       = false
  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["oss:ListObjects"]
        Resource = ["acs:oss:*:*:${var.bucket_name}"]
        Condition = {
          StringLike = {
            "oss:Prefix" = ["${var.backup_prefix}/", "${var.backup_prefix}/*"]
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["oss:GetObject", "oss:PutObject"]
        Resource = ["acs:oss:*:*:${var.bucket_name}/${var.backup_prefix}/*"]
      }
    ]
  })
}

resource "alicloud_ram_role_policy_attachment" "oss_backup" {
  role_name   = alicloud_ram_role.tradeflow_ecs.id
  policy_name = alicloud_ram_policy.oss_backup.policy_name
  policy_type = "Custom"
}

resource "alicloud_ecs_ram_role_attachment" "tradeflow" {
  instance_id   = alicloud_instance.tradeflow.id
  ram_role_name = alicloud_ram_role.tradeflow_ecs.id

  depends_on = [alicloud_ram_role_policy_attachment.oss_backup]
}
