# Security Audit Report

**Status: draft — pending GuardDuty/Security Hub burn-in period and a scheduled
penetration test.** This document is the living record referenced in the
README's "Security team" checklist. Update it as each item below closes out.

---

## 1. Scope

- Backend API (`src/`) — Express, Prisma/Postgres
- Frontend (`frontend/`) — React/Vite SPA
- Infrastructure (`infra/`) — Terraform-managed AWS resources, `prod` and `staging`
- CI/CD (`.github/workflows/ci.yml`)

## 2. Automated tooling in place

| Tool | Stage | What it checks | Blocking? |
|---|---|---|---|
| Gitleaks | CI, every push | Secrets committed to git history | Yes |
| Semgrep (`p/nodejs`, `p/owasp-top-ten`, `p/jwt`, `p/express`) | CI, every push | Static analysis against known Node/Express/JWT vulnerability patterns | Depends on Semgrep policy config — confirm blocking threshold with Security team |
| Trivy (filesystem) | CI, every push | Dependency CVEs, Critical/High | Yes (`exit-code: 1`) |
| Trivy (container image) | CI, main branch build | Image CVEs, Critical | Yes |
| GuardDuty | Continuous, account-level | Threat detection — anomalous API calls, compromised credentials, malware on EBS | Alerts via SNS email, not a CI gate |
| Security Hub (CIS + AWS Foundational) | Continuous, account-level | Configuration drift against CIS AWS Foundations Benchmark v1.4 and AWS's own best-practice standard | Alerts only, not a CI gate |

## 3. Application-level controls already implemented

- **IDOR protection** — `requireOrgMember` middleware on every org-scoped route; verified before any data access.
- **Mass assignment protection** — every update endpoint uses an explicit field allowlist, never raw `req.body` passed to Prisma.
- **Paystack webhook verification** — HMAC-SHA512 signature check via `crypto.timingSafeEqual` before any event is processed.
- **Append-only audit log** — SHA-256 hash chain; all writes go through `src/lib/audit.js`; a `/audit-log/verify` endpoint checks chain integrity.
- **JWT secret handling** — sourced from env vars / Secrets Manager only; app refuses to start if missing; secrets themselves are generated inside Terraform (`random_bytes`) so they never sit in a `.tfvars` file.
- **Password reset** — random token, hashed at rest, single-use (cleared on success), short TTL, and existing refresh sessions are revoked on a successful reset.
- **RDS isolation** — private subnets only, reachable exclusively from the ECS task security group (not a broad CIDR).
- **No secrets in ECS task definitions** — container definitions reference Secrets Manager ARNs in the `secrets` block, never plaintext `environment` values.
- **CI/CD trust boundary** — GitHub Actions authenticates via OIDC, restricted to `main`/`develop` branch workflow runs on this specific repo; no long-lived AWS credentials stored anywhere.

## 4. Threat model — per route

> Per the README's Security-team checklist item: "Threat model every route
> before the DevOps team adds new ones." Table below is a starting pass —
> Security team to review and expand before Week 2 sign-off.

| Route | Primary threat | Mitigation | Residual risk |
|---|---|---|---|
| `POST /api/auth/register` | Account enumeration, credential stuffing | Rate limiting (`express-rate-limit`), bcrypt hashing | No CAPTCHA/bot detection yet |
| `POST /api/auth/login` | Brute force, credential stuffing | Rate limiting, bcrypt, generic error messages | No account lockout after N failed attempts |
| `POST /api/auth/forgot-password` | User enumeration via response timing/content | Generic success message regardless of account existence | Confirm response timing doesn't leak existence (constant-time DB lookup path not yet verified) |
| `POST /api/auth/reset-password` | Token guessing, replay | Hashed token at rest, short TTL, single-use, session revocation | — |
| `*/org/:orgId/*` (all org-scoped routes) | IDOR — accessing another org's data | `requireOrgMember` middleware | Verify middleware is applied consistently on any *new* route before merge (this is why the checklist item exists) |
| `PATCH /api/organisations/:orgId` | Privilege escalation via mass assignment | Explicit allowlist | — |
| `POST /api/webhooks/paystack` | Forged payment events | HMAC-SHA512 signature verification | Confirm webhook endpoint is not exempted from rate limiting; consider replay-window check on timestamp |
| `GET /api/organisations/:orgId/audit-log/verify` | Tampering with financial/audit history | Hash chain verification | If chain is ever found broken, this is a tamper event — treat as an incident, not a bug (see `docs/runbook.md`) |

## 5. Outstanding items before Week 2 sign-off

- [ ] Security team review and expand the threat model table above
- [ ] Review Prisma schema for data minimisation gaps
- [ ] Confirm Semgrep blocking threshold (currently unclear if findings fail the build or only report)
- [ ] Confirm Gitleaks config covers all secret patterns relevant to this stack (Paystack keys, SMTP creds, JWT secrets)
- [ ] Sign off on `src/lib/jwt.js` and `src/middleware/auth.js`
- [ ] Sign off on `src/routes/webhooks.js`
- [ ] Schedule and run a penetration test against `staging` (not `prod`) — recommend an authenticated OWASP ZAP baseline scan as a first pass, ahead of/in addition to any contracted pen test
- [ ] Confirm GuardDuty/Security Hub email subscriptions are actually confirmed (check inbox after first apply — unconfirmed SNS subscriptions silently drop findings)
- [ ] Decide on account lockout / CAPTCHA for login and registration before public launch

## 6. Findings log

_No findings recorded yet — GuardDuty and Security Hub were enabled as of
this draft and need a burn-in period before results are meaningful. Populate
this section from the AWS Console (GuardDuty → Findings, Security Hub →
Findings) or by exporting via the AWS CLI, once available._

| Date | Source | Severity | Finding | Status |
|---|---|---|---|---|
| — | — | — | — | — |
