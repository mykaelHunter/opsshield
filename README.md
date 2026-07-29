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
| Security hardening (GuardDuty, Security Hub, pen test, audit report) | ⬜ Not started |
| Feature flags for launch day | ⬜ Not started |
| Staging environment (`infra/envs/staging`) | ⬜ Not started |

---

## Repository structure

```
opsshield/
├── src/                        Express API
│   ├── controllers/             auth, organisations, tasks, members, billing
│   ├── routes/                  route definitions incl. webhooks
│   ├── middleware/               auth, validate, error handling
│   ├── lib/                     jwt, audit log, mailer, logger, prisma client
│   └── __tests__/               Jest test suites
├── prisma/                      schema, migrations, seed script
├── frontend/                    React + Vite SPA (auth, tasks, members, billing)
├── infra/                       Terraform, module-based (see infra/README.md)
│   ├── modules/                 vpc, dns_acm, ecr, rds, secrets, alb, ecs, cloudwatch, github_oidc
│   └── envs/prod/                composed prod stack
├── scripts/                     deployment & lifecycle automation
│   ├── terraform-setup.sh        bootstrap state bucket + first infra apply
│   ├── webapp-deployment.sh       build/push image, run migrations, deploy backend + frontend
│   └── cleanup.sh                 tear down all AWS resources for the stack
├── docs/                        runbook.md, architecture.md (this change)
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

All three scripts live in `scripts/` and are meant to be run from there
(each does `cd ..` internally to reach the repo root). See
[`docs/runbook.md`](docs/runbook.md) for the full walkthrough, order of
operations, and troubleshooting.

1. **`terraform-setup.sh`** — creates the encrypted/versioned S3 state
   bucket, then runs the first `terraform plan`/`apply` in `infra/envs/prod`.
2. **`webapp-deployment.sh`** — builds and pushes the backend image to ECR,
   applies the ECS module, runs Prisma migrations as a one-off ECS task,
   then builds and syncs the frontend to S3.
3. **`cleanup.sh`** — full teardown: DB snapshot, deletion protection,
   ECR images, frontend bucket, `terraform destroy`, state bucket, and
   CloudWatch log groups.

All three require variables (`ACCOUNT_ID`, `AWS_REGION`, bucket/state names)
to be edited in place before running, and export `TF_VAR_paystack_secret_key`
/ `TF_VAR_smtp_pass` for the Terraform run.

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
| POST | `/api/webhooks/paystack` | Paystack HMAC | Payment webhook |
| GET | `/health` | None | Health check |

---

## Security patterns implemented

- **IDOR protection** — every org-scoped route uses `requireOrgMember` middleware.
- **Mass assignment protection** — update endpoints use explicit field allowlists, never raw `req.body`.
- **Paystack webhook verification** — HMAC-SHA512 via `crypto.timingSafeEqual` before processing.
- **Append-only audit log** — SHA-256 hash chain, all writes go through `src/lib/audit.js`.
- **JWT secrets** — from env vars / Secrets Manager only, app throws at startup if missing.
- **Password reset** — random token hashed at rest, single-use, short TTL, refresh sessions revoked on reset.

See [`docs/architecture.md`](docs/architecture.md) for how these fit together, and
[`infra/README.md`](infra/README.md) for Terraform-specific design decisions.

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system architecture and request/deploy flow diagrams
- [`docs/runbook.md`](docs/runbook.md) — operational runbook: deploy, rollback, teardown, incident response
- [`infra/README.md`](infra/README.md) — Terraform module layout and bootstrap steps

---

*OpsShield — Expadox Lab Capstone*
