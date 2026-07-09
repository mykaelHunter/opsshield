# OpsShield

> Internal ops and team management platform — built by the OpsShield founding engineering team.

---

## The situation

You are the founding engineering team of OpsShield. Series A closed 72 hours ago.  
Three weeks to investor demo, enterprise security audit, and public launch — on the same day.

Read the full brief before touching any code.

---

## What is already here

This repository contains the MVP scaffold — the foundation is built, the security patterns are established, and the architecture decisions are made. Your job is to complete it, harden it, and ship it.

**What exists:**
- Express + Node.js API with all security middleware wired (Helmet, CORS, rate limiting)
- JWT auth with refresh token rotation — register, login, logout, refresh
- IDOR-protected org-scoped middleware on every route
- Append-only audit log with SHA-256 hash chain
- Paystack webhook handler with HMAC-SHA512 signature verification
- Task creation, assignment, and approval workflow
- Member invite system with token-based acceptance
- Billing initiation via Paystack
- CI/CD pipeline with Semgrep, Gitleaks, and Trivy gates
- Full Prisma schema — users, orgs, members, tasks, approvals, billing, audit log

**What your team builds:**
- Password reset flow (token generation, email sending, single-use enforcement)
- Frontend — your team chooses React or server-rendered, commits on Day 1
- Terraform infrastructure — Cloud team owns this
- AWS deployment — ECS, RDS, ALB, Secrets Manager, CloudWatch
- Security hardening — GuardDuty, Security Hub, penetration test, audit report
- Feature flags for launch day control
- Everything else in the project brief

---

## Team quick start

### 1. Clone the repo (use the template — do not clone directly)

```bash
git clone https://github.com/expadox-lab/opsshield.git
cd opsshield
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment

```bash
cp .env.example .env
# Fill in values — ask the Cloud team for DATABASE_URL once RDS is provisioned
# Generate JWT secrets:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 4. Run locally with Docker

```bash
docker-compose up
# App: http://localhost:3000
# DB:  localhost:5432
```

### 5. Run migrations and seed

```bash
npm run db:migrate
npm run db:seed
# Admin:  admin@opsshield.io  / Password123!
# Member: member@opsshield.io / Password123!
```

### 6. Run tests

```bash
npm test
```

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

## Security patterns already implemented — read before you build

**IDOR protection:** Every org-scoped route uses `requireOrgMember` middleware. This verifies the authenticated user is a member of the org in the URL before any data is touched. Never query org data without this middleware in place.

**Mass assignment protection:** Every update endpoint uses an explicit allowlist. `req.body` is never passed directly to Prisma. Only permitted fields are extracted individually.

**Paystack webhook verification:** The webhook handler verifies HMAC-SHA512 signature using `crypto.timingSafeEqual` before processing any event. Do not remove or bypass this check.

**Audit log:** The audit log is append-only with a SHA-256 hash chain. Every write goes through `src/lib/audit.js`. Do not write directly to the AuditLog table from anywhere else.

**JWT secrets:** Must come from environment variables or AWS Secrets Manager. They are never hardcoded. The app throws at startup if they are missing.

---

## What the Security team must do before Week 2

- [ ] Threat model every route in this README before the DevOps team adds new ones
- [ ] Review the Prisma schema for data minimisation gaps
- [ ] Define Semgrep blocking threshold for the CI pipeline
- [ ] Confirm Gitleaks config covers all secret patterns for this stack
- [ ] Sign off on the JWT implementation in `src/lib/jwt.js` and `src/middleware/auth.js`
- [ ] Sign off on the Paystack webhook handler in `src/routes/webhooks.js`

---

## What the Cloud team must do before Week 1 ends

- [ ] VPC, ECS, RDS provisioned via Terraform
- [ ] Domain live with ACM certificate — HTTPS only
- [ ] Secrets Manager configured — `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PAYSTACK_SECRET_KEY`
- [ ] ECS task definition referencing Secrets Manager — no env vars in the task definition itself
- [ ] CloudWatch log group created and ECS configured to write to it
- [ ] RDS backup retention set to 7 days minimum

---

## Deployment

The CI pipeline (`.github/workflows/ci.yml`) runs on every push:

1. Gitleaks — secrets scan across full git history
2. Semgrep — static analysis against Node.js + OWASP Top 10 rules
3. Trivy — filesystem dependency scan (blocks on Critical/High)
4. Tests — Jest with coverage
5. Build + push to ECR (main branch only)
6. Trivy — container image scan (blocks on Critical)
7. Deploy to ECS via `update-service`

The pipeline uses OIDC — no stored AWS credentials anywhere.

---

*OpsShield — Expadox Lab Series A Capstone · Built by the founding engineering team*
