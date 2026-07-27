terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      # CloudFront requires its ACM cert in us-east-1 regardless of which
      # region everything else runs in — this alias must be passed in from
      # the root module (envs/prod), which is the only place a second
      # provider block can actually be configured.
      configuration_aliases = [aws.us_east_1]
    }
  }
}

variable "name" {
  type = string
}

variable "subdomain" {
  type        = string
  default     = "app"
  description = "Subdomain the frontend is served on, e.g. \"app\" -> app.<domain_name>"
}

variable "domain_name" {
  type        = string
  description = "The apex/backend domain, e.g. opsshield.terra-hunter.com — the frontend is served at <subdomain>.<domain_name>"
}

variable "zone_id" {
  type        = string
  description = "Route53 zone ID to add the frontend's records to — reuse dns_acm's zone_id, no new hosted zone or delegation needed since this subdomain lives inside the already-delegated zone"
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}

locals {
  full_domain = "${var.subdomain}.${var.domain_name}"
  # S3 bucket names are globally unique across every AWS account, not just
  # this one — a plain "<name>-frontend" is generic enough to already be
  # taken by someone else's account. Appending the account ID guarantees
  # no collision without needing a random suffix that'd change on every
  # `terraform plan` for no reason.
  bucket_name = "${var.name}-frontend-${data.aws_caller_identity.current.account_id}"
}

# ── Certificate — MUST be us-east-1 for CloudFront, independent of the
# ALB's cert (modules/dns_acm), which is correctly in the deploy region.
# ACM certs are regional resources; a cert issued in eu-west-1 cannot be
# attached to a CloudFront distribution no matter what domain it covers.
resource "aws_acm_certificate" "frontend" {
  provider          = aws.us_east_1
  domain_name       = local.full_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}

resource "aws_route53_record" "frontend_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.frontend.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = var.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "frontend" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for r in aws_route53_record.frontend_cert_validation : r.fqdn]
}

# ── S3 bucket — private, no public access at all; CloudFront reaches it
# exclusively via Origin Access Control below.
# S3 bucket names are unique across ALL AWS accounts globally, not just
# S3 bucket names are unique across ALL AWS accounts globally, not just
# within this one — a generic name like "opsshield-prod-frontend" collides
# easily with buckets in completely unrelated accounts. local.bucket_name
# (defined above) already appends the account ID for this reason.
resource "aws_s3_bucket" "frontend" {
  bucket = local.bucket_name
  tags   = var.tags
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.name}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Grants CloudFront (via this specific distribution's OAC, enforced by the
# SourceArn condition) read access — the bucket has no other path in.
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
        }
      }
    }]
  })
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [local.full_domain]
  price_class         = "PriceClass_100" # US/Canada/Europe edge locations — cheapest tier, adjust if you need global reach

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  # React Router uses client-side routing — a direct hit on e.g.
  # /accept-invite has no matching S3 object, so without this CloudFront
  # returns S3's raw 403/404 instead of loading index.html and letting
  # the router take over.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.frontend.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = var.tags
}

resource "aws_route53_record" "frontend_alias" {
  zone_id = var.zone_id
  name    = local.full_domain
  type    = "A"

  alias {
    # Fixed, well-known hosted zone ID for all CloudFront distributions —
    # not regional, this exact value applies regardless of which region
    # any provider in this file is configured for.
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

output "bucket_name" {
  value = aws_s3_bucket.frontend.id
}

output "distribution_id" {
  description = "Needed by CI to invalidate the CloudFront cache after each deploy"
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.frontend.domain_name
}

output "frontend_url" {
  value = "https://${local.full_domain}"
}
