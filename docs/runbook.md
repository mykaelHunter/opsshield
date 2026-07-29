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

---

## 3. Incident response quick reference

| Symptom | First checks |
|---|---|
| 5xx from ALB | ECS service events (`aws ecs describe-services`), CloudWatch app logs |
| Migration task failed | `aws ecs describe-tasks` exit code/reason from step 3 above; check Prisma migration SQL for conflicts |
| Paystack webhook rejected | Confirm signature verification isn't failing on a stale/rotated secret in Secrets Manager |
| Audit log verify endpoint reports broken chain | Do not attempt to "fix" the chain — treat as a possible tamper event, preserve state, escalate |
| CI blocked on Trivy/Semgrep | Check severity thresholds in `.github/workflows/ci.yml`; do not lower them to unblock without security sign-off |

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
