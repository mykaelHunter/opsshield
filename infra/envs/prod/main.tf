locals {
  name = "opsshield-prod"
  tags = {
    Project     = "opsshield"
    Environment = "prod"
  }
}

module "vpc" {
  source = "../../modules/vpc"

  name                  = local.name
  azs                   = var.azs
  public_subnet_cidrs   = ["10.20.0.0/24", "10.20.1.0/24"]
  private_subnet_cidrs  = ["10.20.10.0/24", "10.20.11.0/24"]
  tags                  = local.tags
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

  domain_name  = var.domain_name
  alb_dns_name = module.alb.dns_name
  alb_zone_id  = module.alb.zone_id
  tags         = local.tags
}

module "alb" {
  source = "../../modules/alb"

  name              = local.name
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = module.dns_acm.certificate_arn
  tags              = local.tags
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

  name                = local.name
  database_url        = module.rds.database_url
  paystack_secret_key = var.paystack_secret_key
  smtp_pass           = var.smtp_pass
  tags                = local.tags
}

module "cloudwatch" {
  source = "../../modules/cloudwatch"

  name                = local.name
  budget_alert_email  = var.budget_alert_email
  monthly_budget_usd  = 300
  tags                = local.tags
}

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
  desired_count           = 2

  non_secret_env = {
    NODE_ENV         = "production"
    PORT             = "3000"
    FRONTEND_URL     = "https://${var.domain_name}"
    ALLOWED_ORIGINS  = "https://${var.domain_name}"
    SMTP_HOST        = var.smtp_host
    SMTP_PORT        = var.smtp_port
    SMTP_USER        = var.smtp_user
    EMAIL_FROM       = var.email_from
    LOG_LEVEL        = "info"
  }

  tags = local.tags
}
