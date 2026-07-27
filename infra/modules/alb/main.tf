variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  type        = string
  description = "ACM cert ARN from the dns_acm module"
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb-sg"
  description = "Public HTTPS/HTTP only, HTTP redirects to HTTPS at the listener"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP, redirected to HTTPS, never forwarded to targets"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-alb-sg" })
}

resource "aws_lb" "this" {
  name               = "${var.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  # Access logs feed Security's log pipeline into Wazuh per the capstone brief
  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb"
    enabled = true
  }

  tags = merge(var.tags, { Name = "${var.name}-alb" })

  # access_logs.bucket only references the bucket resource, not the bucket
  # policy — AWS validates the policy at ALB creation/modify time, so
  # without this explicit dependency Terraform has no reason to wait for
  # the policy to actually be attached first (same failure class as the
  # VPC/IGW race this stack already hit once).
  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_s3_bucket" "alb_logs" {
  bucket = "${var.name}-alb-access-logs"
  tags   = var.tags
}

data "aws_region" "current" {}

# AWS's regional ELB log-delivery service account — this is NOT the same
# account in every region, and using the wrong one is a silent-until-apply
# failure (ModifyLoadBalancerAttributes: Access Denied). Source:
# https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html
# Add any region not listed here from that same page before deploying to it.
locals {
  elb_log_delivery_account_ids = {
    "us-east-1"      = "127311923021"
    "us-east-2"      = "033677994240"
    "us-west-1"      = "027434742980"
    "us-west-2"      = "797873946194"
    "af-south-1"     = "098369216593"
    "ca-central-1"   = "985666609251"
    "eu-central-1"   = "054676820928"
    "eu-north-1"     = "897822967062"
    "eu-south-1"     = "635631232127"
    "eu-west-1"      = "156460612806"
    "eu-west-2"      = "652711504416"
    "eu-west-3"      = "009996457667"
    "ap-east-1"      = "754344448648"
    "ap-northeast-1" = "582318560864"
    "ap-northeast-2" = "600734575887"
    "ap-northeast-3" = "383597477331"
    "ap-south-1"     = "718504428378"
    "ap-southeast-1" = "114774131450"
    "ap-southeast-2" = "783225319266"
    "me-south-1"     = "076674570225"
    "sa-east-1"      = "507241528517"
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { AWS = "arn:aws:iam::${local.elb_log_delivery_account_ids[data.aws_region.current.name]}:root" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.alb_logs.arn}/alb/AWSLogs/*"
    }]
  })
}

resource "aws_lb_target_group" "app" {
  name        = "${var.name}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # required for Fargate

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout              = 5
    matcher              = "200"
  }

  tags = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

output "dns_name" {
  value = aws_lb.this.dns_name
}

output "zone_id" {
  value = aws_lb.this.zone_id
}

output "target_group_arn" {
  value = aws_lb_target_group.app.arn
}

output "security_group_id" {
  value = aws_security_group.alb.id
}
