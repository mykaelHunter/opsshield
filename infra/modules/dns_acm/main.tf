variable "domain_name" {
  type        = string
  description = "e.g. opsshield.io"
}

variable "parent_zone_name" {
  type        = string
  default     = null
  description = "Set this when domain_name is a subdomain of a zone already hosted in this same AWS account (e.g. domain_name = \"opsshield.terra-hunter.com\", parent_zone_name = \"terra-hunter.com\"). When set, Terraform creates the NS delegation record in the parent zone automatically instead of requiring a manual aws route53 change-resource-record-sets step. Leave null if the parent domain lives at an external registrar or a different AWS account — delegate manually in that case."
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_route53_zone" "this" {
  name = var.domain_name
  tags = var.tags
}

# Only looked up when parent_zone_name is actually set — avoids requiring
# route53:ListHostedZonesByName permissions or failing outright for anyone
# using this module without a same-account parent zone.
data "aws_route53_zone" "parent" {
  count = var.parent_zone_name != null ? 1 : 0
  name  = var.parent_zone_name
}

# The delegation step that was previously a manual `aws route53
# change-resource-record-sets` call — without this record existing, DNS
# queries for domain_name never reach the child zone above, and
# aws_acm_certificate_validation.this hangs indefinitely waiting for
# validation records it can never actually see publicly.
resource "aws_route53_record" "delegation" {
  count = var.parent_zone_name != null ? 1 : 0

  zone_id = data.aws_route53_zone.parent[0].zone_id
  name    = var.domain_name
  type    = "NS"
  ttl     = 300
  records = aws_route53_zone.this.name_servers
}

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  subject_alternative_names = ["*.${var.domain_name}"]

  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.this.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]

  # Not inferable from attribute references alone — without this, Terraform
  # has no reason to wait for the parent-zone NS delegation to exist before
  # starting this wait, and validation will hang the same way it did before
  # this record existed at all.
  depends_on = [aws_route53_record.delegation]
}

# A-record pointing the apex domain at the ALB — populated once ALB module exists
resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

variable "alb_dns_name" {
  type        = string
  description = "DNS name of the ALB, passed in from the alb module"
}

variable "alb_zone_id" {
  type        = string
  description = "Hosted zone ID of the ALB, passed in from the alb module"
}

output "zone_id" {
  value = aws_route53_zone.this.zone_id
}

output "name_servers" {
  value = aws_route53_zone.this.name_servers
}

output "certificate_arn" {
  value = aws_acm_certificate_validation.this.certificate_arn
}
