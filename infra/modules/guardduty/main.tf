variable "name" {
  type = string
}

variable "finding_publishing_frequency" {
  type    = string
  default = "FIFTEEN_MINUTES"
  description = "How often GuardDuty exports findings to CloudWatch Events. FIFTEEN_MINUTES is the fastest option and costs nothing extra over the default."
}

variable "alert_email" {
  type        = string
  description = "Where high/medium severity findings get emailed — same inbox as the budget alert is fine for a lab environment."
}

variable "minimum_severity_to_alert" {
  type    = number
  default = 4.0
  description = "GuardDuty severity is 0.1-8.9+. 4.0 is the low/medium boundary — alerting from here up avoids paging on informational findings while still catching real issues."
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ── Detector ─────────────────────────────────────────────────────────
# One detector per account per region. If GuardDuty is already enabled
# account-wide (e.g. via AWS Organizations delegated admin), this
# resource will fail with "detector already exists" — import the
# existing one instead of creating a second detector.
resource "aws_guardduty_detector" "this" {
  enable                       = true
  finding_publishing_frequency = var.finding_publishing_frequency

  datasources {
    s3_logs {
      enable = true
    }
    kubernetes {
      audit_logs {
        enable = false # no EKS in this stack — ECS Fargate only
      }
    }
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes {
          enable = true
        }
      }
    }
  }

  tags = merge(var.tags, { Name = "${var.name}-guardduty" })
}

# ── Alerting path: GuardDuty finding -> EventBridge -> SNS -> email ──
resource "aws_sns_topic" "findings" {
  name = "${var.name}-guardduty-findings"
  tags = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.findings.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_event_rule" "findings" {
  name        = "${var.name}-guardduty-findings"
  description = "Routes GuardDuty findings at or above the configured severity to SNS"

  event_pattern = jsonencode({
    source      = ["aws.guardduty"]
    detail-type = ["GuardDuty Finding"]
    detail = {
      severity = [{ numeric = [">=", var.minimum_severity_to_alert] }]
    }
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "sns" {
  rule      = aws_cloudwatch_event_rule.findings.name
  target_id = "sns"
  arn       = aws_sns_topic.findings.arn
}

# EventBridge needs explicit permission to publish to this topic — without
# this policy, findings match the rule but silently never reach SNS.
resource "aws_sns_topic_policy" "allow_eventbridge" {
  arn = aws_sns_topic.findings.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventBridgePublish"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.findings.arn
    }]
  })
}

output "detector_id" {
  value = aws_guardduty_detector.this.id
}

output "findings_topic_arn" {
  value = aws_sns_topic.findings.arn
}
