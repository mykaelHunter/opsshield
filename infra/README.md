# OpsShield Terraform

Module-based structure, one root config per environment.

```
infra/
├── modules/
│   ├── vpc/          VPC, public/private subnets, NAT, VPC Flow Logs
│   ├── dns_acm/      Route53 hosted zone, ACM cert (DNS validated)
│   ├── ecr/          Container repository, scan-on-push, lifecycle policy
│   ├── rds/          Postgres, private subnet only, 7-day backups, Multi-AZ
│   ├── secrets/      Secrets Manager — one secret per credential
│   ├── alb/          ALB, HTTPS-only listener, HTTP→HTTPS redirect, access logs
│   ├── ecs/          Fargate cluster, task def, service, autoscaling, IAM roles
│   ├── cloudwatch/   App log group, monthly budget alert
│   ├── guardduty/    Threat detection, EventBridge → SNS email alert on findings
│   └── security_hub/ CIS + AWS Foundational standards, ingests GuardDuty findings
└── envs/
    ├── prod/         Composes the modules above into one deployable stack
    │   ├── main.tf
    │   ├── variables.tf
    │   ├── outputs.tf
    │   ├── versions.tf
    │   └── terraform.tfvars.example
    └── staging/      Same composition, smaller sizing, separate state file
```

## GuardDuty & Security Hub

Both are account-level services (one detector / one Security Hub
subscription per account per region). If either is already enabled
elsewhere in the AWS account — e.g. via AWS Organizations delegated
admin — these resources will fail with an "already exists" error on
apply. In that case, import the existing resource instead of creating a
new one:

```bash
terraform import module.guardduty.aws_guardduty_detector.this <detector-id>
terraform import module.security_hub.aws_securityhub_account.this <account-id>
```

GuardDuty findings at or above severity 4.0 (configurable via
`minimum_severity_to_alert`) are routed through EventBridge to an SNS
topic with an email subscription — confirm the subscription email
(check your inbox after the first apply) or you won't receive alerts.
Security Hub automatically ingests GuardDuty findings once both are
enabled in the same account/region; no extra wiring is required beyond
enabling both modules.

Add `envs/staging/` later by copying `envs/prod/` and changing `local.name`,
CIDR ranges, and instance sizes — each environment gets its own state file
and its own two-AZ VPC, so staging changes can never touch prod resources.

## Bootstrap (first time only)

The S3 backend referenced in `versions.tf` must exist *before* this config
can initialize. Create it with a small separate one-off step first — this
is the standard Terraform chicken-and-egg problem with remote state.

Locking is handled natively by S3 (`use_lockfile = true`, Terraform 1.10+) —
no DynamoDB table is needed.

```bash
# us-east-1 is a special case: it's the only region where you must NOT pass
# --create-bucket-configuration. Every other region requires it, and the
# LocationConstraint value must exactly match --region or you'll hit a
# "301 redirect" error on `terraform init` later.
aws s3api create-bucket --bucket opsshield-terraform-state-prod --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1

# Verify it actually landed where you think it did before moving on:
aws s3api get-bucket-location --bucket opsshield-terraform-state-prod

aws s3api put-bucket-versioning --bucket opsshield-terraform-state-prod \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket opsshield-terraform-state-prod \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
aws s3api put-public-access-block --bucket opsshield-terraform-state-prod \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

If you already created the bucket without `--create-bucket-configuration`
(common mistake — S3 silently defaults to `us-east-1` when it's omitted),
delete it and recreate it rather than fighting the region mismatch:

```bash
aws s3 rb s3://opsshield-terraform-state-prod --force
# then re-run the create-bucket command above
```

## Applying

```bash
cd envs/prod
cp terraform.tfvars.example terraform.tfvars   # fill in non-sensitive values
export TF_VAR_paystack_secret_key="sk_live_..."
export TF_VAR_smtp_pass="..."

terraform init
```

**First apply only** — three things need resolving in order, since each
depends on something that doesn't exist yet:

1. `dns_acm` and `alb` reference each other's outputs (cert → ALB, ALB DNS
   name → Route53 alias record).
2. The `ecs` module needs a real `image_uri`, but you can't push an image to
   a repository that doesn't exist yet — and the `ecr` module is what
   creates that repository.

```bash
# Step 1: create the ECR repo (and resolve the dns_acm/alb ordering) —
# use a placeholder image_uri here, it's only needed to satisfy the ecs
# module's variable type; ecs itself isn't targeted in this step.
terraform apply \
  -target=module.ecr \
  -target=module.dns_acm.aws_acm_certificate.this \
  -target=module.alb \
  -var="image_uri=placeholder"

# Step 2: build and push a real image now that the repo exists
terraform output ecr_repository_url
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin $(terraform output -raw ecr_repository_url | cut -d/ -f1)
docker build -t opsshield .
docker tag opsshield:latest "$(terraform output -raw ecr_repository_url):latest"
docker push "$(terraform output -raw ecr_repository_url):latest"

# Step 3: apply everything else with the real image
terraform apply -var="image_uri=$(terraform output -raw ecr_repository_url):latest"
```

Every apply after that is a normal `terraform apply` — no more targeting needed,
since the resources already exist.

## CI/CD deploy role (bootstrap, first time only)

`ci.yml`'s `build` and `deploy` jobs assume an AWS role via GitHub OIDC
(`role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}`). That role is created
by `module.github_oidc` in this same stack — same chicken-and-egg problem as
step 1 above: CI can't apply Terraform until the role it needs to assume
already exists, so the first apply has to happen from a local/admin session,
not from CI.

```bash
# Uses your local AWS credentials, not CI's — the role doesn't exist yet.
terraform apply -target=module.github_oidc -var="image_uri=placeholder"

terraform output github_deploy_role_arn
```

Then set that ARN as a repo secret: **Settings > Secrets and variables >
Actions > New repository secret**, name it `AWS_DEPLOY_ROLE_ARN`. Also make
sure `AWS_REGION` is set as a secret (`eu-west-1`) — both are referenced in
`ci.yml`. After that, every push to `main` can authenticate on its own and
`terraform apply` runs from CI as normal.

The role's trust policy only allows `sts:AssumeRoleWithWebIdentity` from
workflow runs on `github_org/github_repo`'s `main` branch (see
`allowed_branches` in `variables.tf`) — a PR from a fork or a push to any
other branch can't assume it, even with a copy of the workflow file.

CI/CD passes the image tag explicitly rather than it living in a `.tfvars` file:

```bash
terraform apply -var="image_uri=<account>.dkr.ecr.eu-west-1.amazonaws.com/opsshield:<git-sha>"
```

## Design decisions worth knowing before you touch this

- **ECR tag mutability is `MUTABLE`, not `IMMUTABLE`** — because `ci.yml`
  currently re-pushes the `:latest` tag on every build, which `IMMUTABLE`
  would reject on the second push. `IMMUTABLE` is the safer choice (a
  compromised CI run can't silently overwrite an existing tag) but requires
  CI to stop pushing `:latest` and rely solely on the git-SHA tag first.
- **No secret values ever appear in a task definition** — the `ecs` module's
  container definition only holds Secrets Manager ARNs (`secrets` block, not
  `environment`). This satisfies the README's "no env vars in the task
  definition itself" requirement structurally, not by convention.
- **JWT secrets are generated inside Terraform** (`random_bytes`, in the
  `secrets` module) rather than passed in as variables — so they never sit in
  a `.tfvars` file or a CI variable store in plaintext form; they only ever
  exist in Terraform state and Secrets Manager.
- **RDS is never publicly accessible** and only reachable from the ECS task
  security group specifically — not a broad CIDR, not "anything in the VPC."
- **One NAT gateway per AZ**, not a single shared one — costs roughly 2x but
  means an AZ outage doesn't take down egress for every private subnet.
  If cost pressure shows up before the investor demo, this is the first
  place to trade availability for spend — flip to a single NAT + variable
  toggle in the `vpc` module.
- **State itself contains the DB password and other secrets in plaintext**
  (this is normal for Terraform, not a bug) — the S3 backend needs
  encryption-at-rest and IAM-restricted access, which the bootstrap step
  above sets up. Don't skip that.
