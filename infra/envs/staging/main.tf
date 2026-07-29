locals {
  name = "opsshield-staging"
  tags = {
    Project     = "opsshield"
    Environment = "staging"
  }
}

module "frontend" {
  source = "../../modules/frontend"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name        = local.name
  subdomain   = var.frontend_subdomain
  domain_name = var.domain_name
  # Reuses the zone dns_acm already created and already has delegation
  # configured for (via parent_zone_name) — no new hosted zone, no new
  # delegation step, since app.<domain_name> lives inside the same zone
  # as <domain_name> itself.
  zone_id = module.dns_acm.zone_id
  tags    = local.tags
}

# github_oidc is intentionally NOT instantiated here — the OIDC provider
# (aws_iam_openid_connect_provider) is a single account-level resource,
# and module.github_oidc in infra/envs/prod already creates it plus the
# deploy role. Widen that role's `allowed_branches` to include "develop"
# (see infra/envs/prod/main.tf) so CI can assume the same role when
# deploying to staging from the develop branch — do not create a second
# provider here, it will fail with "already exists".

module "vpc" {

  source = "../../modules/vpc"

  name                  = local.name
  azs                   = var.azs
  public_subnet_cidrs   = ["10.30.0.0/24", "10.30.1.0/24"]
  private_subnet_cidrs  = ["10.30.10.0/24", "10.30.11.0/24"]
  tags                  = local.tags
}

# Named "opsshield" (not local.name/"opsshield-prod") deliberately — this
# must exactly match the repo name ci.yml's docker build/push steps use
# ("$ECR_REGISTRY/opsshield:$IMAGE_TAG"). One shared repo across
# environments is standard for ECR; only image tags differ per deploy,
# not the repository itself.
# ECR is NOT created here — module.ecr in infra/envs/prod already owns
# the "opsshield" repository, and repo names are account/region-unique,
# so instantiating the module again here would collide with prod's
# real resource. Staging reuses the same repo (different image tags
# per deploy, same as prod) via a data lookup instead.
data "aws_ecr_repository" "opsshield" {
  name = "opsshield"
}

# ── Bootstrap ordering note ────────────────────────────────────────────
# dns_acm needs the ALB's DNS name, and the ALB needs the ACM cert ARN.
# Resolve with a two-step apply the first time:
#   1. terraform apply -target=module.dns_acm.aws_acm_certificate.this \
#        -target=module.alb
#   2. terraform apply (everything else, including the Route53 alias record)
# After the first apply this is no longer an issue — normal applies work
# cleanly since the resources already exist and only diffs are calculated.

module "dns_acm" {
  source = "../../modules/dns_acm"

  domain_name      = var.domain_name
  parent_zone_name = var.parent_zone_name
  alb_dns_name     = module.alb.dns_name
  alb_zone_id      = module.alb.zone_id
  tags             = local.tags
}

module "alb" {
  source = "../../modules/alb"

  name              = local.name
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = module.dns_acm.certificate_arn
  tags              = local.tags

  # Explicit module-level dependency, not just the attribute references
  # above: the IGW and its public route table association have no
  # attribute in common with public_subnet_ids, so Terraform's graph
  # doesn't otherwise know to wait for the route to actually exist before
  # creating the ALB — AWS validates that route at ALB-creation time and
  # fails with "VPC has no internet gateway" if it loses the race.
  depends_on = [module.vpc]
}

module "rds" {
  source = "../../modules/rds"

  name                       = local.name
  vpc_id                     = module.vpc.vpc_id
  private_subnet_ids         = module.vpc.private_subnet_ids
  allowed_security_group_ids = [module.ecs.task_security_group_id]
  backup_retention_days      = 7
  tags                       = local.tags
}

module "secrets" {
  source = "../../modules/secrets"

  name                     = local.name
  database_url             = module.rds.database_url
  paystack_secret_key      = var.paystack_secret_key
  smtp_pass                = var.smtp_pass
  recovery_window_in_days  = var.secrets_recovery_window_in_days
  tags                = local.tags
}

module "cloudwatch" {
  source = "../../modules/cloudwatch"

  name                = local.name
  budget_alert_email  = var.budget_alert_email
  monthly_budget_usd  = 100 # smaller footprint than prod — 1 task, no HA minimum
  tags                = local.tags
}

# guardduty and security_hub are NOT instantiated here — both create
# account-level, region-level singleton resources (one GuardDuty detector,
# one Security Hub subscription per account per region), which
# infra/envs/prod already owns. A second instantiation here would fail
# with "already exists". Both already cover this account's staging
# resources automatically — no per-environment opt-in is possible or
# needed.

module "ecs" {
  source = "../../modules/ecs"

  name                   = local.name
  vpc_id                 = module.vpc.vpc_id
  private_subnet_ids     = module.vpc.private_subnet_ids
  alb_security_group_id  = module.alb.security_group_id
  alb_target_group_arn   = module.alb.target_group_arn
  image_uri              = var.image_uri
  log_group_name         = module.cloudwatch.log_group_name
  secret_arns            = module.secrets.secret_arns
  desired_count           = 1 # staging doesn't need prod's HA minimum of 2

  non_secret_env = {
    NODE_ENV         = "production"
    PORT             = "3000"
    FRONTEND_URL     = module.frontend.frontend_url
    ALLOWED_ORIGINS  = module.frontend.frontend_url
    SMTP_HOST        = var.smtp_host
    SMTP_PORT        = var.smtp_port
    SMTP_USER        = var.smtp_user
    EMAIL_FROM       = var.email_from
    LOG_LEVEL        = "info"
  }

  tags = local.tags
}
