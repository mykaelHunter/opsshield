variable "name" {
  type = string
}

variable "database_url" {
  type      = string
  sensitive = true
  description = "Full Postgres connection string. Pass via TF_VAR_database_url at apply time — never commit to a .tfvars file."
}

variable "paystack_secret_key" {
  type      = string
  sensitive = true
  description = "Pass via TF_VAR_paystack_secret_key at apply time — never commit."
}

variable "smtp_pass" {
  type      = string
  sensitive = true
  description = "Pass via TF_VAR_smtp_pass at apply time — never commit."
}

variable "tags" {
  type    = map(string)
  default = {}
}

# JWT secrets are generated here, not passed in — nothing outside this
# state file (and whoever has access to it) ever needs to know them,
# and there's no .tfvars file anywhere holding them in plaintext.
resource "random_bytes" "jwt_secret" {
  length = 64
}

resource "random_bytes" "jwt_refresh_secret" {
  length = 64
}

# One secret per credential rather than one JSON blob for all of them.
# This lets the ECS task role be scoped per-secret if you ever need to
# split permissions (e.g. a worker process that needs DATABASE_URL but
# not PAYSTACK_SECRET_KEY), and makes rotation of one credential not
# touch the others.

resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.name}/database-url"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = var.database_url
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name = "${var.name}/jwt-secret"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_bytes.jwt_secret.hex
}

resource "aws_secretsmanager_secret" "jwt_refresh_secret" {
  name = "${var.name}/jwt-refresh-secret"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "jwt_refresh_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_refresh_secret.id
  secret_string = random_bytes.jwt_refresh_secret.hex
}

resource "aws_secretsmanager_secret" "paystack_secret_key" {
  name = "${var.name}/paystack-secret-key"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "paystack_secret_key" {
  secret_id     = aws_secretsmanager_secret.paystack_secret_key.id
  secret_string = var.paystack_secret_key
}

resource "aws_secretsmanager_secret" "smtp_pass" {
  name = "${var.name}/smtp-pass"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "smtp_pass" {
  secret_id     = aws_secretsmanager_secret.smtp_pass.id
  secret_string = var.smtp_pass
}

output "secret_arns" {
  description = "Map of secret name to ARN, consumed by the ecs module's task definition"
  value = {
    database_url         = aws_secretsmanager_secret.database_url.arn
    jwt_secret           = aws_secretsmanager_secret.jwt_secret.arn
    jwt_refresh_secret   = aws_secretsmanager_secret.jwt_refresh_secret.arn
    paystack_secret_key  = aws_secretsmanager_secret.paystack_secret_key.arn
    smtp_pass            = aws_secretsmanager_secret.smtp_pass.arn
  }
}
