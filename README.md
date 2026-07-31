# OpsShield

> Multi-tenant ops and team management SaaS — Expadox Lab Series A Capstone.

---

## Status

The MVP scaffold, backend hardening, infrastructure, frontend, and deployment
automation are all in place. This is a working, deployable stack.

| Area | Status |
|------|--------|
| Backend API (auth, orgs, tasks, members, billing, webhooks) | ✅ Complete |
| Password reset flow (token + email + single-use) | ✅ Complete |
| Frontend (React/Vite) | ✅ Complete |
| Terraform infrastructure (`infra/`) | ✅ Complete — modular, one stack per env |
| CI/CD (Gitleaks, Semgrep, Trivy, tests, ECR/ECS deploy via OIDC) | ✅ Complete |
| Deployment automation scripts (`scripts/`) | ✅ Complete |
| Security hardening — GuardDuty + Security Hub | 🟨 Infra in place, burn-in + pen test pending — see `docs/audit-report.md` |
| Feature flags for launch day | ✅ Complete — global flags via CLI, per-org overrides via API — see below |
| Staging environment (`infra/envs/staging`) | ✅ Complete — shares prod's ECR repo & GitHub OIDC role, separate VPC/state |

---

## Repository structure

```
opsshield/
├── src/                        Express API
│   ├── controllers/             auth, organisations, tasks, members, billing
│   ├── routes/                  route definitions incl. webhooks
│   ├── middleware/               auth, validate, error handling
│   ├── lib/                     jwt, audit log, mailer, logger, prisma client, feature flags
│   └── __tests__/               Jest test suites
├── prisma/                      schema, migrations, seed script
├── frontend/                    React + Vite SPA (auth, tasks, members, billing)
├── infra/                       Terraform, module-based (see infra/README.md)
│   ├── modules/                 vpc, dns_acm, ecr, rds, secrets, alb, ecs, cloudwatch,
│   │                            github_oidc, guardduty, security_hub
│   └── envs/
│       ├── prod/                 composed prod stack (owns account-level singletons)
│       └── staging/               same composition, reuses prod's ECR repo & OIDC role
├── scripts/                     deployment & lifecycle automation
│   ├── terraform-setup-prod.sh    bootstrap state bucket + first infra apply (prod)
│   ├── terraform-setup-staging.sh  applies prod's ECR module, then bootstraps staging
│   ├── webapp-deployment-prod.sh   build/push image, migrate, seed, deploy backend + frontend (prod)
│   ├── webapp-deployment-staging.sh same, targeting the staging stack
│   ├── cleanup.sh                 tear down all AWS resources for the stack (prod or staging)
│   └── manage-feature-flags.js    create/enable/disable global feature flags
├── docs/                        architecture.md, runbook.md, audit-report.md
├── .github/workflows/ci.yml     security scan → test → build/push → deploy
├── Dockerfile                   multi-stage, non-root, stripped npm at runtime
├── docker-compose.yml           local app + Postgres
└── README.md
```

---

## Quick start (local)

```bash
git clone https://github.com/expadox-lab/opsshield.git
cd opsshield
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"  # JWT secrets

docker-compose up          # app: http://localhost:3000, db: localhost:5432
npm run db:migrate
npm run db:seed            # admin@opsshield.io / member@opsshield.io, Password123!
npm test
```

---

## Deployment scripts

All scripts live in `scripts/` and are meant to be run from there
(each does `cd ..` internally to reach the repo root). Provisioning and
deployment are now split into prod/staging variants. See
[`docs/runbook.md`](docs/runbook.md) for the full walkthrough, order of
operations, and troubleshooting.

1. **`terraform-setup-prod.sh`** — creates the encrypted/versioned S3 state
   bucket, then runs the first `terraform plan`/`apply` in `infra/envs/prod`.
2. **`terraform-setup-staging.sh`** — applies `infra/envs/prod`'s `module.ecr`
   first (staging reuses prod's ECR repo), then bootstraps `infra/envs/staging`.
3. **`webapp-deployment-prod.sh`** / **`webapp-deployment-staging.sh`** —
   build and push the backend image to ECR, force a new ECS deployment,
   run Prisma migrations as a one-off ECS task, then run the seed task
   (skipped if migrations fail), then build and sync the frontend to S3.
4. **`cleanup.sh`** — full teardown for either stack (set `ENV`): DB
   snapshot, deletion protection, ECR images, frontend bucket,
   `terraform destroy`, state bucket, and CloudWatch log groups.

`ACCOUNT_ID` and `AWS_REGION` are now resolved automatically from the AWS
CLI (`aws sts get-caller-identity` / `aws configure get region`) rather
than hardcoded — only `ENV`, bucket/state names still need editing in
place. All scripts export `TF_VAR_paystack_secret_key` / `TF_VAR_smtp_pass`
for the Terraform run.

---

## API reference

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/auth/register` | None | Register and create org |
| POST | `/api/auth/login` | None | Login |
| POST | `/api/auth/refresh` | None | Rotate refresh token |
| POST | `/api/auth/logout` | Bearer | Logout |
| POST | `/api/auth/forgot-password` | None | Request password reset |
| POST | `/api/auth/reset-password` | None | Reset with token |
| GET | `/api/auth/me` | Bearer | Current user + orgs |
| GET | `/api/organisations/:orgId` | Bearer + Member | Org details |
| PATCH | `/api/organisations/:orgId` | Bearer + Admin | Update org |
| GET | `/api/organisations/:orgId/audit-log` | Bearer + Admin | Audit log |
| GET | `/api/organisations/:orgId/audit-log/verify` | Bearer + Admin | Verify hash chain |
| GET | `/api/organisations/:orgId/feature-flags` | Bearer + Admin | List flags + effective state for org |
| PUT | `/api/organisations/:orgId/feature-flags/:key` | Bearer + Admin | Set an org-level override |
| DELETE | `/api/organisations/:orgId/feature-flags/:key` | Bearer + Admin | Clear override, revert to global default |
| GET | `/api/tasks/org/:orgId` | Bearer + Member | List tasks |
| POST | `/api/tasks/org/:orgId` | Bearer + Member | Create task |
| GET | `/api/tasks/org/:orgId/:taskId` | Bearer + Member | Get task |
| PATCH | `/api/tasks/org/:orgId/:taskId` | Bearer + Member | Update task |
| DELETE | `/api/tasks/org/:orgId/:taskId` | Bearer + Admin | Delete task |
| POST | `/api/tasks/org/:orgId/:taskId/approve` | Bearer + Admin | Approve task |
| POST | `/api/tasks/org/:orgId/:taskId/reject` | Bearer + Admin | Reject task |
| POST | `/api/members/org/:orgId/invite` | Bearer + Admin | Invite member |
| POST | `/api/members/accept-invite` | None | Accept invite |
| DELETE | `/api/members/org/:orgId/:memberId` | Bearer + Admin | Remove member |
| PATCH | `/api/members/org/:orgId/:memberId/role` | Bearer + Admin | Change role |
| GET | `/api/billing/org/:orgId` | Bearer + Member | Billing history |
| POST | `/api/billing/org/:orgId/initiate` | Bearer + Admin | Start Paystack payment |
| POST | `/api/webhooks/paystack` | Paystack HMAC | Payment webhook — handles `charge.success`, `subscription.create`, `subscription.disable` |
| GET | `/health` | None | Health check |

---

## Feature flags

Two levels, matching who's actually allowed to touch what:

- **Global flags** — the platform-wide default (on or off). There's no
  platform-level admin role in the app yet (only org-scoped admins), so
  global flags are managed via a CLI script against the DB directly —
  not an HTTP endpoint — using the same trust model as `scripts/`:
  whoever can run it already has DB access.

  ```bash
  node scripts/manage-feature-flags.js list
  node scripts/manage-feature-flags.js create beta-dashboard --description "New dashboard UI"
  node scripts/manage-feature-flags.js enable beta-dashboard
  node scripts/manage-feature-flags.js disable beta-dashboard
  node scripts/manage-feature-flags.js delete beta-dashboard
  ```

- **Per-org overrides** — an org admin can opt their own org into (or out
  of) any existing flag, independent of the global default. Useful for
  staged rollouts ("turn this on for one pilot customer before flipping
  it globally") or letting a specific tenant opt out of something new.
  Exposed via the API — see the table above.

**Using a flag in route/controller code:**

```js
const featureFlags = require('../lib/featureFlags');

if (await featureFlags.isEnabled('beta-dashboard', req.organisation.id)) {
  // gated behavior
}
```

Resolution order: org override → global default → `false` if the flag
key doesn't exist at all (fails closed, so a typo'd key degrades safely
instead of throwing). Results are cached in-memory for ~10 seconds, so
toggling a flag takes effect quickly without a restart, but checks
aren't hitting the DB on every request.

---

## Security patterns implemented

- **IDOR protection** — every org-scoped route uses `requireOrgMember` middleware.
- **Mass assignment protection** — update endpoints use explicit field allowlists, never raw `req.body`.
- **Paystack webhook verification** — HMAC-SHA512 via `crypto.timingSafeEqual` before processing.
- **Subscription tracking** — `subscription.create`/`subscription.disable` events update `Organisation.subscriptionStatus`, `paystackSubscriptionCode`, and `paystackCustomerCode`; since these events don't carry our internal org id, the handler resolves it by subscription code → customer code → member email, in that order. A disabled subscription downgrades the org to the `FREE` plan.
- **Append-only audit log** — SHA-256 hash chain, all writes go through `src/lib/audit.js`.
- **JWT secrets** — from env vars / Secrets Manager only, app throws at startup if missing.
- **Password reset** — random token hashed at rest, single-use, short TTL, refresh sessions revoked on reset.
- **Invite tokens** — hashed at rest (`tokenHash`, not the raw token), same pattern as password reset.
- **Account lockout** — 5 failed logins locks the account for 15 minutes (`failedLoginCount`/`lockedUntil` on `User`); cleared on successful login or password reset. Uses an atomic `increment` update to avoid undercounting concurrent attempts.
- **Org soft delete** — `deletedAt` on `Organisation`, `Member`, `Invite`, and `Task`; reads that should exclude deleted rows (e.g. `/api/auth/me`) filter explicitly rather than relying on hard deletes.

See [`docs/architecture.md`](docs/architecture.md) for how these fit together, and
[`infra/README.md`](infra/README.md) for Terraform-specific design decisions.

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system architecture and request/deploy flow diagrams
- [`docs/runbook.md`](docs/runbook.md) — operational runbook: deploy, rollback, teardown, incident response
- [`docs/audit-report.md`](docs/audit-report.md) — security audit tracking: threat model, tooling, outstanding sign-offs
- [`infra/README.md`](infra/README.md) — Terraform module layout and bootstrap steps

---

*OpsShield — Expadox Lab Capstone*
