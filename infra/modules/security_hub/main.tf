variable "name" {
  type = string
}

variable "enable_cis_standard" {
  type    = bool
  default = true
  description = "CIS AWS Foundations Benchmark — the standard most auditors/investors expect to see enabled."
}

variable "enable_aws_foundational_standard" {
  type    = bool
  default = true
  description = "AWS Foundational Security Best Practices — broader coverage than CIS alone, AWS's own baseline."
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ── Account-level enablement ─────────────────────────────────────────
# Like GuardDuty, this is one-per-account-per-region. If Security Hub is
# already enabled centrally (Organizations delegated admin), import the
# existing resource rather than creating a duplicate.
resource "aws_securityhub_account" "this" {}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  cis_standard_arn = "arn:aws:securityhub:${data.aws_region.current.name}::standards/cis-aws-foundations-benchmark/v/1.4.0"
  fsbp_standard_arn = "arn:aws:securityhub:${data.aws_region.current.name}::standards/aws-foundational-security-best-practices/v/1.0.0"
}

resource "aws_securityhub_standards_subscription" "cis" {
  count         = var.enable_cis_standard ? 1 : 0
  standards_arn = local.cis_standard_arn
  depends_on    = [aws_securityhub_account.this]
}

resource "aws_securityhub_standards_subscription" "fsbp" {
  count         = var.enable_aws_foundational_standard ? 1 : 0
  standards_arn = local.fsbp_standard_arn
  depends_on    = [aws_securityhub_account.this]
}

# GuardDuty findings flow into Security Hub automatically once both are
# enabled in the same account/region — no extra wiring needed here. This
# module intentionally has no dependency on the guardduty module's
# resources; enabling both in the same infra/envs/<env>/main.tf is
# sufficient for the integration to work.

output "account_id" {
  value = aws_securityhub_account.this.id
}

output "enabled_standards" {
  value = compact([
    var.enable_cis_standard ? "cis-aws-foundations-benchmark/v/1.4.0" : "",
    var.enable_aws_foundational_standard ? "aws-foundational-security-best-practices/v/1.0.0" : "",
  ])
}
