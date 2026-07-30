# Runbook

Operational procedures for provisioning, deploying, and tearing down OpsShield.
Run all `scripts/*.sh` commands from inside `scripts/` — each script does
`cd ..` internally to reach the repo root before touching `infra/` or
`frontend/`.

## 0. Prerequisites

- AWS CLI configured with credentials for the target account
- Terraform ≥ 1.10 (native S3 locking, no DynamoDB table needed)
- Docker
- Node.js ≥ 18
- `infra/envs/prod/terraform.tfvars` created from `terraform.tfvars.example`

Before running any script, edit its placeholder variables in place:
`ACCOUNT_ID`, `AWS_REGION`, and (for `cleanup.sh`) `FRONTEND_BUCKET` /
`STATE_STORE`. All three scripts also expect
`TF_VAR_paystack_secret_key` and `TF_VAR_smtp_pass` exported before they run.

---

## Before you apply anything to prod

Earned the hard way: a `terraform apply` against `infra/envs/prod` that
recreated the `database-url` secret without writing a paired version left
the secret in a state where it existed but had no `AWSCURRENT` version —
every subsequent ECS task placement failed at
`ResourceInitializationError: unable to pull secrets` until it was caught
and fixed with `terraform apply -replace=...`. Check these two things
*before* any apply that touches `module.secrets` or `module.ecs` in prod:

1. **The two genuinely user-supplied secrets are exported in this shell,
   every time.** `database_url` is not one of these — it's built entirely
   inside `module.rds` from a Terraform-generated `random_password` plus
   the RDS endpoint (`infra/modules/rds/main.tf`), so there's nothing to
   export or know for it on a fresh install. JWT secrets are similarly
   self-generated inside `module.secrets`. Only these two come from you:
   ```bash
   echo "${TF_VAR_paystack_secret_key:?missing}" > /dev/null
   echo "${TF_VAR_smtp_pass:?missing}" > /dev/null
   ```
   If either prints "missing" instead of erroring silently — stop and
   export it before proceeding. An apply that's missing one of these
   against prod is a stop-and-check moment, not something to push through
   on a prompt or a stale default.

2. **After any apply that touches `module.secrets`, confirm every secret
   still has a current version before forcing an ECS deployment** — this
   catches a broken secret before it takes prod down, rather than after:
   ```bash
   for s in database-url jwt-secret jwt-refresh-secret paystack-secret-key smtp-pass; do
     echo -n "${s}: "
     aws secretsmanager list-secret-version-ids --secret-id "opsshield-prod/${s}" --region eu-west-1 \
       --query 'Versions[?contains(VersionStages, `AWSCURRENT`)]' --output text
   done
   ```
   Any blank line means that secret has no `AWSCURRENT` version and any
   deployment that references it will fail the same way — fix it
   (`terraform apply -replace=module.secrets.aws_secretsmanager_secret_version.<name>`)
   before forcing a new ECS deployment.

Also worth setting `secrets_recovery_window_in_days` to `7` (not `0`) for
prod specifically — it doesn't prevent a bad apply from breaking a
version, but it removes the "force-delete + instantly recreate under the
same name" race that's the most likely way a secret ends up in this state
in the first place. Staging can stay at `0` for fast iteration.

---

## 1. First-time provisioning — `terraform-setup.sh`

```bash
cd scripts
./terraform-setup.sh
```

What it does:
1. Waits 10s (cancel window) after reminding you to check `tfvars`.
2. Creates the `opsshield-terraform-state-prod` S3 bucket in `eu-west-1`
   with versioning and AES256 encryption enabled.
3. Runs `terraform init`, `plan`, and `apply` in `infra/envs/prod`.

Notes:
- This performs a *plain* `terraform apply`, not the two-stage bootstrap
  described in `infra/README.md` (ECR-first, then the rest). If this is a
  genuinely first-ever apply into an empty account, follow the ordered
  bootstrap in `infra/README.md` instead (ECR → image push → full apply),
  since `ecs` needs a real `image_uri` and `github_oidc`'s role needs to
  exist before CI can use it.
- Re-running this script on an already-provisioned stack is a normal
  `terraform apply` and safe to repeat.

---

## 2. Deploying an update — `webapp-deployment.sh`

```bash
cd scripts
./webapp-deployment.sh
```

What it does, in order:
1. Logs into ECR, builds the backend Docker image, tags and pushes it.
2. Applies only `module.ecs` with the new `image_uri`.
3. Reads the ECS cluster/task-def/subnets/security-group from Terraform
   outputs, and runs a **one-off Fargate task** overriding the container
   command to `node node_modules/prisma/build/index.js migrate deploy`.
4. Waits for that migration task to stop, then prints its exit code and
   reason — **check this before assuming the deploy succeeded.**
5. Builds the frontend (`npm run build`) and syncs `dist/` to the S3
   frontend bucket with `--delete`.

Rollback if a migration fails: the ECS service is still running the
previous image (step 2 only updates the task definition/service, it
doesn't yet have failed data), so first fix and re-run the migration task
manually, or re-apply `module.ecs` with the last-known-good `image_uri`.
Prisma migrations in this project are additive/forward-only — there's no
scripted down-migration, so a bad migration needs a manual fix-forward or
a restore from an RDS snapshot.

---

## 2a. Deploying to staging

`infra/envs/staging` reuses two account-level resources created only in
`infra/envs/prod`'s state — the ECR repository and the GitHub OIDC deploy
role. Don't run `terraform-setup.sh` unmodified against staging as-is; it
hardcodes the prod path. Instead, from `infra/envs/staging`:

```bash
cd infra/envs/staging
cp terraform.tfvars.example terraform.tfvars   # fill in values
export TF_VAR_paystack_secret_key="sk_test_..."
export TF_VAR_smtp_pass="..."
terraform init
terraform apply -var="image_uri=placeholder"   # first apply, same ordering caveats as prod — see infra/README.md
```

`webapp-deployment.sh` targets `infra/envs/prod` by path; for staging,
either parameterize the script's `cd` target or run the equivalent steps
manually against `infra/envs/staging`. CI's `develop`-branch builds should
point at the staging stack's Terraform outputs, not prod's.

**After the first apply of either GuardDuty or the SNS topic in
`infra/envs/prod`**: check the inbox for `security_alert_email` and
confirm the SNS subscription. An unconfirmed subscription silently drops
every finding — you won't get an error, you just won't get alerted.

**Ordering dependency — apply prod's ECR before staging, every time:**
`infra/envs/staging/main.tf` does not create its own ECR repository. It
does a `data "aws_ecr_repository" "opsshield"` lookup against the repo
that only `module.ecr` in `infra/envs/prod` creates (repos are shared
across environments; only image tags differ). A `data` source can't
create anything, so if that repo doesn't exist yet — prod never applied,
or was torn down via `cleanup.sh` — staging's `terraform apply`/`plan`
fails immediately with:

```
Error: reading ECR Repository (opsshield): couldn't find resource
  with data.aws_ecr_repository.opsshield,
  on main.tf line 56, in data "aws_ecr_repository" "opsshield":
```

Fix, in order:
1. Confirm the repo actually exists where staging expects it:
   ```bash
   aws ecr describe-repositories --repository-names opsshield --region eu-west-1
   ```
2. If that also 404s, create at least prod's ECR piece first, then retry staging:
   ```bash
   cd infra/envs/prod
   terraform apply -target=module.ecr -var="image_uri=placeholder"
   cd ../staging
   terraform apply -var="image_uri=placeholder"
   ```
3. If the repo *does* exist, staging's `var.aws_region` (in its
   `terraform.tfvars` or provider config) points at a different region
   than prod's `eu-west-1` — ECR repos are region-scoped, so a same-name
   repo in another region won't satisfy the lookup. Align the region and
   retry.

Same dependency applies to the GitHub OIDC deploy role referenced above —
if CI fails to assume a role for staging deploys, check that prod's
`module.github_oidc` has actually been applied and that its
`allowed_branches` includes `develop`.

**VPC `cidr_block` must be overridden to match the subnet ranges you pass:**
`modules/vpc` defaults `cidr_block` to `10.20.0.0/16` (prod's range).
Prod's subnets (`10.20.0.0/24`, `10.20.1.0/24`, `10.20.10.0/24`,
`10.20.11.0/24`) fall inside that default, so prod's `main.tf` never needs
to set it explicitly. Staging's subnets use the `10.30.x.0/24` range
instead, but if `cidr_block` isn't also overridden to `10.30.0.0/16`, the
VPC is still created as `10.20.0.0/16` and every subnet apply fails with:

```
Error: creating EC2 Subnet: ... api error InvalidSubnet.Range: The CIDR '10.30.0.0/24' is invalid.
```

(The message is misleading — the CIDR syntax is fine, it just doesn't
fall inside the VPC's own block.) Fix: pass `cidr_block = "10.30.0.0/16"`
in staging's `module "vpc"` block, matching the subnet ranges already
listed there. Any future environment that picks its own subnet range
(e.g. a `10.40.x` env) needs the same explicit override.

---

## 3. Incident response quick reference

| Symptom | First checks |
|---|---|
| 5xx from ALB | ECS service events (`aws ecs describe-services`), CloudWatch app logs |
| Migration task failed | `aws ecs describe-tasks` exit code/reason from step 3 above; check Prisma migration SQL for conflicts |
| Paystack webhook rejected | Confirm signature verification isn't failing on a stale/rotated secret in Secrets Manager |
| Audit log verify endpoint reports broken chain | Do not attempt to "fix" the chain — treat as a possible tamper event, preserve state, escalate |
| CI blocked on Trivy/Semgrep | Check severity thresholds in `.github/workflows/ci.yml`; do not lower them to unblock without security sign-off |
| `staging` apply fails: `couldn't find resource ... data.aws_ecr_repository.opsshield` | Prod's `module.ecr` hasn't been applied yet (or was destroyed), or staging's region doesn't match prod's — see "Ordering dependency" under §2a |
| `InvalidSubnet.Range` on `module.vpc.aws_subnet.*` | The env's `cidr_block` wasn't overridden to contain its subnet CIDRs — see "VPC cidr_block" note under §2a |
| ECS task fails: `ResourceInitializationError: unable to pull secrets ... ResourceNotFoundException ... AWSCURRENT` | The referenced secret has no current version — check with the loop under "Before you apply anything to prod", fix with `terraform apply -replace=module.secrets.aws_secretsmanager_secret_version.<name>`, then `--force-new-deployment` |

---

## 4. Full teardown — `cleanup.sh`

**Destructive. Confirm you actually want to delete the environment before running.**

```bash
cd scripts
./cleanup.sh
```

Before running:
- Manually empty and delete the ALB access-log S3 bucket first — `terraform
  destroy` will otherwise fail because the ALB itself has been writing logs
  into it during the stack's lifetime.
- Double-check `FRONTEND_BUCKET` and `STATE_STORE` are edited to the correct
  bucket names for this environment — this script deletes bucket contents.

What it does, in order:
1. 30s cancel window.
2. Deletes any existing final DB snapshot with the same identifier (so the
   next step doesn't collide with it).
3. Removes RDS deletion protection.
4. Batch-deletes all images in the `opsshield` ECR repository.
5. Empties the frontend S3 bucket (all versions).
6. Runs `terraform destroy` for the full stack.
7. **Manual gate**: if `terraform destroy` failed, stop here — do not
   proceed to delete the state bucket while resources may still exist in
   state.
8. Empties and deletes the Terraform state S3 bucket (objects + delete
   markers, then the bucket itself).
9. 30s pause, then deletes the VPC flow log, ECS Container Insights, and
   RDS CloudWatch log groups (optional — the script pauses to let you
   cancel if you want to keep them for post-mortem).

After cleanup, `infra/envs/prod` has no remote backend to reinitialize
against — treat the next provisioning run as a fresh first-time bootstrap
(see `infra/README.md`).
