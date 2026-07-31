# Architecture

## Overview

OpsShield is a multi-tenant SaaS platform: a Node.js/Express API backed by
Postgres (Prisma), a React/Vite frontend, and AWS infrastructure provisioned
entirely through modular Terraform. Every org-scoped resource is isolated by
`requireOrgMember` middleware, and all state-changing money/security events
(billing, audit log) are handled through dedicated, verified code paths.

## System diagram

```mermaid
flowchart TB
    subgraph Client
        FE[React/Vite SPA]
    end

    subgraph AWS["AWS (per infra/envs/prod)"]
        ALB[ALB<br/>HTTPS only, HTTP→HTTPS redirect]
        subgraph ECS["ECS Fargate"]
            APP[opsshield-app container]
        end
        RDS[(RDS Postgres<br/>private subnet, Multi-AZ)]
        SM[Secrets Manager<br/>DB URL, JWT secrets, Paystack key]
        S3F[S3<br/>frontend static assets]
        CW[CloudWatch<br/>logs + budget alarm]
        ECR[ECR<br/>opsshield image]
    end

    Paystack[Paystack webhooks]

    FE -->|static hosting| S3F
    FE -->|HTTPS API calls| ALB
    ALB --> APP
    APP --> RDS
    APP -.secrets at runtime.-> SM
    APP --> CW
    Paystack -->|HMAC-SHA512 signed| ALB
    ECR -->|image pull| ECS
```

## Request flow — authenticated org action

```mermaid
sequenceDiagram
    participant U as User (SPA)
    participant API as Express API
    participant MW as requireOrgMember
    participant DB as Postgres (Prisma)
    participant AL as Audit Log

    U->>API: Request with Bearer token + :orgId
    API->>API: JWT verify (src/lib/jwt.js)
    API->>MW: Check membership for orgId
    MW->>DB: Lookup membership
    DB-->>MW: Member / not a member
    alt not a member
        MW-->>U: 403
    else member
        MW->>API: proceed
        API->>DB: Explicit allowlisted fields only
        API->>AL: Append hash-chained entry
        API-->>U: 200 + result
    end
```

## Password reset flow

```mermaid
sequenceDiagram
    participant U as User
    participant API as Express API
    participant Mail as Mailer (SMTP)
    participant DB as Postgres

    U->>API: POST /api/auth/forgot-password {email}
    API->>DB: Store resetTokenHash + expiry (raw token never persisted)
    API->>Mail: Send reset link with raw token
    API-->>U: 200 generic message (no user enumeration)

    U->>API: POST /api/auth/reset-password {token, newPassword}
    API->>DB: Hash token, look up matching resetTokenHash
    alt token invalid or expired
        API-->>U: 400
    else valid
        API->>DB: Update password hash, clear resetTokenHash/expiry
        API->>DB: Revoke existing refresh sessions
        API-->>U: 200 — must log in again
    end
```

## Account lockout

Login checks `lockedUntil` before the bcrypt compare. Five failed attempts
(`failedLoginCount`, incremented atomically) locks the account for 15
minutes; a successful login or password reset clears both fields. A locked
account gets a distinct `423` response rather than the generic `401`, which
is a deliberate small enumeration trade-off — a user actively locked out
needs to know why.

## Deployment flow

```mermaid
flowchart LR
    A[terraform-setup-prod.sh] -->|"S3 state bucket + first terraform apply"| B[infra provisioned<br/>VPC, RDS, ALB, ECR, ECS, Secrets]
    B --> C[webapp-deployment-prod.sh]
    C -->|"1. docker build/push"| D[ECR image]
    D -->|"2. ecs update-service --force-new-deployment"| E[ECS service updated]
    E -->|"3. one-off ECS task"| F[Prisma migrate deploy]
    F -->|"4. one-off ECS task, skipped on migration failure"| FS[Seed task]
    FS -->|"5. npm run build + s3 sync"| G[Frontend on S3]
    H[cleanup.sh] -.->|teardown, reverse order| B
    I[terraform-setup-staging.sh] -->|"applies prod's module.ecr, then staging stack"| B
    I --> J[webapp-deployment-staging.sh]
```

## Design notes

- **Isolation**: every module in `infra/modules/` maps 1:1 to a security or
  cost boundary (e.g. `rds` is never publicly reachable; `secrets` holds one
  secret per credential rather than a shared blob).
- **No plaintext secrets at rest in the app layer**: ECS task definitions
  reference Secrets Manager ARNs only; JWT secrets are generated inside
  Terraform (`random_bytes`) so they never pass through a `.tfvars` file.
  See `infra/README.md` for the full rationale.
- **CI/CD trust boundary**: GitHub Actions authenticates via OIDC
  (`module.github_oidc`), restricted to `main`-branch workflow runs on this
  repo — no long-lived AWS credentials stored anywhere.
- **Migrations run out-of-band** from app startup, as a one-off Fargate task
  triggered by `webapp-deployment-prod.sh` / `webapp-deployment-staging.sh`,
  so a bad migration can't crash-loop the running service. The seed task
  runs immediately after as a second one-off task, and is skipped entirely
  if the migration task exits non-zero.
- **Secrets Manager dependency ordering**: `module.secrets`'s `secret_arns`
  output references the `*_version` resources (not the secret shells), so
  Terraform won't create anything that consumes a secret ARN — e.g.
  `module.ecs` — until the secret actually has a value. This closes the
  race described in `docs/runbook.md` where ECS could be pointed at a
  secret with zero versions.
- **ECR `force_delete = true`**: every merge to `main` pushes at least two
  tags (git SHA + `:latest`), so a repo is never actually empty by the time
  `cleanup.sh` runs `terraform destroy`. Unlike RDS, there's no data here
  worth protecting from accidental deletion, so the repo is destroyable
  even when non-empty.
