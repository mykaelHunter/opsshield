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

variable "parent_zone_name" {
  type        = string
  default     = null
  description = "Set when domain_name is a subdomain of a zone already hosted in this same AWS account (e.g. domain_name = \"opsshield.terra-hunter.com\", parent_zone_name = \"terra-hunter.com\"). Leave null if the parent zone is at an external registrar or a different account."
}

variable "frontend_subdomain" {
  type        = string
  default     = "app"
  description = "The frontend is served at <this>.<domain_name>, e.g. app.opsshield.terra-hunter.com"
}

variable "secrets_recovery_window_in_days" {
  type        = number
  default     = 0
  description = "0 = secrets delete immediately on destroy, no AWS recovery window (convenient while iterating, e.g. this project's frequent destroy/recreate cycles). Set to 7-30 once this is a real environment you don't expect to tear down casually — see modules/secrets/variables for the tradeoff."
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

variable "github_org" {
  type        = string
  description = "GitHub org/user that owns this repo - scopes who can assume the deploy role via OIDC"
}

variable "github_repo" {
  type        = string
  default     = "opsshield"
  description = "Repo name only, no org prefix"
}

