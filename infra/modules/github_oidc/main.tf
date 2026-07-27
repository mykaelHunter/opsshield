variable "github_org" {
  type        = string
  description = "GitHub org/user that owns the repo, e.g. \"your-org\""
}

variable "github_repo" {
  type        = string
  description = "Repo name only, no org prefix, e.g. \"opsshield\""
}

variable "github_owner_id" {
  type        = string
  description = "Numeric GitHub owner (org/user) ID. Required because GitHub's sub claim now uses the immutable format `repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/BRANCH` rather than names alone — find it via `gh api users/<owner>` or `gh api orgs/<owner>` (the `id` field), or from a CloudTrail AssumeRoleWithWebIdentity event's real `sub` claim."
}

variable "github_repo_id" {
  type        = string
  description = "Numeric GitHub repository ID — same immutable-claim reasoning as github_owner_id. Find via `gh api repos/<owner>/<repo>` (the `id` field)."
}

variable "allowed_branches" {
  type        = list(string)
  default     = ["main"]
  description = "Branches allowed to assume this role. CI only pushes to AWS from these refs (see ci.yml's build/deploy `if: github.ref == 'refs/heads/main'` guard)."
}

variable "ecr_repository_arn" {
  type        = string
  description = "From module.ecr — scopes push/pull to this repo only, not ecr:*"
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}

# GitHub's OIDC thumbprint is stable and documented by GitHub/AWS, but AWS
# also lets you fetch it dynamically — using the static value here avoids a
# dependency on being able to reach GitHub's TLS endpoint at apply time.
# Source: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = var.tags
}

# Trust policy: only workflow runs from this exact repo, on one of
# allowed_branches, may assume this role. `sub` claim format is
# documented at the link above — narrowing to `repo:org/repo:ref:refs/heads/BRANCH`
# (rather than `repo:org/repo:*`) means a PR from a fork, or a push to any
# other branch, cannot assume this role even with a leaked workflow file.
resource "aws_iam_role" "deploy" {
  name = "opsshield-github-actions-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          # Immutable subject format (GitHub, opted in / repos created after
          # 2026-07-15): repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/BRANCH
          # Confirmed against this repo's actual CloudTrail sub claim — do
          # not revert to the name-only "repo:org/repo:ref:..." form, it
          # will silently stop matching and every AssumeRoleWithWebIdentity
          # call will fail with a generic "Not authorized" error.
          "token.actions.githubusercontent.com:sub" = [
            for b in var.allowed_branches :
            "repo:${var.github_org}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:ref:refs/heads/${b}"
          ]
        }
      }
    }]
  })

  tags = var.tags
}

# ECR push/pull, scoped to the single opsshield repository.
resource "aws_iam_role_policy" "ecr" {
  name = "opsshield-deploy-ecr"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*" # this specific action has no resource-level permissions in ECR
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
        ]
        Resource = var.ecr_repository_arn
      }
    ]
  })
}

# terraform apply itself needs to create/update/read every resource type
# this stack manages. This is intentionally broad (not narrowed per-resource)
# because `terraform apply` on this root module touches VPC, ALB, RDS, ECS,
# IAM, Route53, ACM, S3, CloudWatch, Secrets Manager, and Budgets — trying
# to hand-scope each one is a maintenance trap that silently breaks future
# applies. Tighten with permission boundaries / SCPs at the org level
# instead of narrowing this policy resource-by-resource.
resource "aws_iam_role_policy_attachment" "deploy_poweruser" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# PowerUserAccess explicitly excludes IAM management, but this stack's ecs
# and vpc modules both create/update IAM roles (execution role, task role,
# flow-logs role) on every apply — so the deploy role needs its own scoped
# IAM grant, limited to the roles this stack actually owns (name prefix
# "opsshield-"), not iam:* on every role in the account.
resource "aws_iam_role_policy" "deploy_iam_scoped" {
  name = "opsshield-deploy-iam-scoped"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole",
      ]
      Resource = [
        "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/opsshield-*",
      ]
    }]
  })
}

output "role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN secret in the GitHub repo"
  value       = aws_iam_role.deploy.arn
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}
