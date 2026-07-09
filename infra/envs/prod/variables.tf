variable "aws_region" {
  type    = string
  default = "eu-west-1"
}

variable "azs" {
  type    = list(string)
  default = ["eu-west-1a", "eu-west-1b"]
}

variable "domain_name" {
  type        = string
  description = "e.g. opsshield.io"
}

variable "image_uri" {
  type        = string
  description = "ECR image URI + tag — passed by CI/CD (e.g. -var=\"image_uri=...\") not hardcoded here"
}

# ── Secrets that come from outside Terraform's own state ──────────────
# Set these via environment variables at apply time, e.g.:
#   export TF_VAR_paystack_secret_key=sk_live_xxx
#   export TF_VAR_smtp_pass=xxx
# Never put these in a .tfvars file that gets committed.
variable "paystack_secret_key" {
  type      = string
  sensitive = true
}

variable "smtp_pass" {
  type      = string
  sensitive = true
}

variable "smtp_host" {
  type    = string
  default = "smtp.gmail.com"
}

variable "smtp_port" {
  type    = string
  default = "587"
}

variable "smtp_user" {
  type = string
}

variable "email_from" {
  type    = string
  default = "noreply@opsshield.io"
}

variable "budget_alert_email" {
  type = string
}
