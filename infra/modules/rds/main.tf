variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  type        = list(string)
  description = "Security groups allowed to reach Postgres on 5432 — the ECS task SG, nothing else"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage" {
  type    = number
  default = 20
}

variable "backup_retention_days" {
  type    = number
  default = 7
  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "README requires a minimum 7-day backup retention."
  }
}

variable "db_name" {
  type    = string
  default = "opsshield"
}

variable "master_username" {
  type    = string
  default = "opsshield"
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "random_password" "master" {
  length  = 32
  special = false # avoid characters that need URL-encoding in DATABASE_URL
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db-subnets"
  subnet_ids = var.private_subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds-sg"
  description = "Allow Postgres only from the ECS task security group"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from ECS tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-rds-sg" })
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-db"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage  = var.allocated_storage * 4 # storage autoscaling ceiling
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.master_username
  password = random_password.master.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false # never expose RDS directly to the internet

  backup_retention_period = var.backup_retention_days
  backup_window            = "03:00-04:00"
  maintenance_window        = "mon:04:30-mon:05:30"

  multi_az                  = true
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-db-final-snapshot"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = var.tags
}

output "endpoint" {
  value = aws_db_instance.this.endpoint
}

output "database_url" {
  # Consumed by the secrets module and never written to a state-adjacent
  # file — this only ever lives in Terraform state, which should itself
  # be encrypted (S3 backend + KMS, configured at the root level).
  value     = "postgresql://${var.master_username}:${random_password.master.result}@${aws_db_instance.this.endpoint}/${var.db_name}"
  sensitive = true
}

output "security_group_id" {
  value = aws_security_group.rds.id
}
