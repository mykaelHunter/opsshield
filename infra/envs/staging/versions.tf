terraform {
  required_version = ">= 1.10.0" # use_lockfile (native S3 locking) requires 1.10+

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State itself holds the DB password and JWT secrets in plaintext
  # (Terraform state always does) — this backend MUST be encrypted and
  # access-restricted. Create the bucket first (see README bootstrap
  # section) — region here MUST match the bucket's actual region exactly,
  # a mismatch causes a 301 redirect error on `terraform init`.
  backend "s3" {
    bucket       = "opsshield-terraform-state-prod"
    key          = "staging/terraform.tfstate" # separate state file, same state bucket — different key means Terraform never confuses the two environments
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true # native S3 locking (Terraform 1.10+) — no DynamoDB table needed
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "opsshield"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront (module.frontend) requires its ACM certificate in us-east-1
# specifically, regardless of var.aws_region — this is an AWS-wide
# constraint, not an OpsShield-specific choice. Every other resource in
# this stack uses the default (unaliased) provider above.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "opsshield"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}
