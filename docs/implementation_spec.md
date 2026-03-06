# LinkedIn Automation SaaS — Implementation Spec (Automation-First, Policy-Safe)

This document translates the product blueprint into concrete implementation artifacts: architecture modules, Prisma schema, API contracts, queue contracts, workflow definitions, and rollout plan.

## 1) Operating Constraints and Capability Policy

### Product policy
- Maximize automation only where supported by official APIs and approved app scopes.
- Default to **approval gates** for public write actions unless capability checks pass and account-level safe mode allows full automation.
- Never depend on private endpoints, scraping, UI bots, or cold DM growth tactics.

### Capability flags (per connected LinkedIn account)
Persist these booleans and enforce everywhere:
- `can_publish_posts`
- `can_read_comments`
- `can_write_comment_replies`
- `can_read_post_analytics`
- `has_webhook_support`
- `requires_manual_publish`
- `requires_manual_reply`

Rules:
- If write scope missing, force approval/manual mode.
- If tokens stale/revoked, transition account to `reauth_required` and suspend automations.

---

## 2) Monorepo and Module Boundaries

## Repo layout

```txt
/apps
  /web                # Next.js
  /api                # NestJS API (REST)
  /worker             # NestJS/BullMQ worker process
/packages
  /db                 # Prisma schema + generated client
  /shared             # zod schemas, event types, constants
  /config             # env validation
/docs
```

## API modules (NestJS)
- `auth`
- `workspaces`
- `team-members`
- `linkedin`
- `posts`
- `comments`
- `analytics`
- `automations`
- `approvals`
- `notifications`
- `webhooks`
- `billing`
- `admin`
- `audit`

## Worker modules
- `publish-worker`
- `comment-sync-worker`
- `analytics-worker`
- `ai-worker`
- `rule-engine-worker`
- `notification-worker`
- `webhook-worker`

---

## 3) Environment and Secrets

Required env vars:
- App: `NODE_ENV`, `APP_BASE_URL`, `WEB_BASE_URL`
- Database: `DATABASE_URL`
- Redis: `REDIS_URL`
- Auth/session: `JWT_SECRET`, `JWT_REFRESH_SECRET`
- LinkedIn OAuth: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`
- Encryption: `KMS_KEY_ID` (or `TOKEN_ENCRYPTION_KEY` for non-prod)
- AI: `AI_API_KEY`, `AI_MODEL_DEFAULT`
- Email/notifications: `RESEND_API_KEY` (or equivalent)
- Observability: `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- Billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

Security requirements:
- Never store plaintext OAuth tokens.
- Use envelope encryption and per-environment keys.
- Redact secrets and tokens from logs.

---

## 4) Prisma Schema (Implementation-Ready)

> Use Postgres UUIDs, `timestamptz`, soft-delete only where needed.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum TeamRole {
  OWNER
  ADMIN
  EDITOR
  REVIEWER
  VIEWER
}

enum LinkedInConnectionStatus {
  ACTIVE
  REAUTH_REQUIRED
  REVOKED
  ERROR
}

enum DraftStatus {
  DRAFT
  READY
  ARCHIVED
}

enum ScheduledPostState {
  PENDING
  AWAITING_APPROVAL
  APPROVED
  PUBLISHING
  PUBLISHED
  FAILED
  CANCELED
}

enum ApprovalStatus {
  PENDING
  APPROVED
  REJECTED
  EXPIRED
}

enum AutomationRunStatus {
  STARTED
  WAITING_APPROVAL
  COMPLETED
  FAILED
  DEAD_LETTER
}

enum NotificationChannel {
  IN_APP
  EMAIL
  SLACK
  WEBHOOK
}

enum DeliveryStatus {
  PENDING
  SENT
  FAILED
}

model User {
  id            String       @id @default(uuid())
  email         String       @unique
  name          String?
  status        String       @default("active")
  lastLoginAt   DateTime?
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  teamMembers   TeamMember[]
  approvalsMade Approval[]   @relation("ApprovalDecider")
  notifications Notification[]
}

model Workspace {
  id                    String                 @id @default(uuid())
  name                  String
  timezone              String                 @default("UTC")
  planTier              String                 @default("free")
  settingsJson          Json?
  createdAt             DateTime               @default(now())
  updatedAt             DateTime               @updatedAt

  teamMembers           TeamMember[]
  linkedInAccounts      LinkedInAccount[]
  postDrafts            PostDraft[]
  scheduledPosts        ScheduledPost[]
  publishedPosts        PublishedPost[]
  comments              Comment[]
  analyticsSnapshots    AnalyticsSnapshot[]
  automationRules       AutomationRule[]
  automationRuns        AutomationRun[]
  approvals             Approval[]
  notifications         Notification[]
  webhooks              Webhook[]
  auditLogs             AuditLog[]
  billingSubscription   BillingSubscription?
}

model TeamMember {
  id          String    @id @default(uuid())
  workspaceId String
  userId      String
  role        TeamRole
  invitedBy   String?
  joinedAt    DateTime?
  createdAt   DateTime  @default(now())

  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, userId])
  @@index([workspaceId, role])
}

model LinkedInAccount {
  id                       String                    @id @default(uuid())
  workspaceId              String
  linkedinMemberId         String
  displayName              String
  connectionStatus         LinkedInConnectionStatus  @default(ACTIVE)
  scopesJson               Json
  canPublishPosts          Boolean                   @default(false)
  canReadComments          Boolean                   @default(false)
  canWriteCommentReplies   Boolean                   @default(false)
  canReadPostAnalytics     Boolean                   @default(false)
  hasWebhookSupport        Boolean                   @default(false)
  requiresManualPublish    Boolean                   @default(true)
  requiresManualReply      Boolean                   @default(true)
  lastSyncedAt             DateTime?
  createdAt                DateTime                  @default(now())
  updatedAt                DateTime                  @updatedAt

  workspace                Workspace                 @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  oauthTokens              OauthToken[]
  scheduledPosts           ScheduledPost[]

  @@unique([workspaceId, linkedinMemberId])
  @@index([workspaceId, connectionStatus])
}

model OauthToken {
  id                String   @id @default(uuid())
  linkedInAccountId String
  accessTokenEnc    String
  refreshTokenEnc   String?
  expiresAt         DateTime
  revokedAt         DateTime?
  tokenVersion      Int      @default(1)
  createdAt         DateTime @default(now())

  linkedInAccount   LinkedInAccount @relation(fields: [linkedInAccountId], references: [id], onDelete: Cascade)

  @@index([linkedInAccountId, expiresAt])
}

model PostDraft {
  id              String      @id @default(uuid())
  workspaceId     String
  authorUserId    String
  title           String?
  content         String
  mediaJson       Json?
  aiMetadataJson  Json?
  status          DraftStatus @default(DRAFT)
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  workspace       Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  scheduledPost   ScheduledPost?
}

model ScheduledPost {
  id                 String             @id @default(uuid())
  workspaceId        String
  draftId            String             @unique
  linkedInAccountId  String
  scheduledFor       DateTime
  policyMode         String             @default("approval") // approval | auto
  state              ScheduledPostState @default(PENDING)
  idempotencyKey     String?
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt

  workspace          Workspace          @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  draft              PostDraft          @relation(fields: [draftId], references: [id], onDelete: Cascade)
  linkedInAccount    LinkedInAccount    @relation(fields: [linkedInAccountId], references: [id], onDelete: Cascade)
  publishedPost      PublishedPost?

  @@index([workspaceId, scheduledFor])
  @@index([state, scheduledFor])
}

model PublishedPost {
  id                String   @id @default(uuid())
  workspaceId       String
  scheduledPostId   String   @unique
  linkedinPostUrn   String   @unique
  publishedAt       DateTime
  publishResultJson Json?
  createdAt         DateTime @default(now())

  workspace         Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  scheduledPost     ScheduledPost @relation(fields: [scheduledPostId], references: [id], onDelete: Cascade)
  comments          Comment[]
  analyticsSnapshots AnalyticsSnapshot[]

  @@index([workspaceId, publishedAt])
}

model Comment {
  id                  String   @id @default(uuid())
  workspaceId         String
  publishedPostId     String
  linkedinCommentId   String   @unique
  body                String
  authorName          String?
  sentiment           String?
  intent              String?
  aiSuggestionsJson   Json?
  repliedAt           DateTime?
  createdAt           DateTime @default(now())

  workspace           Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  publishedPost       PublishedPost @relation(fields: [publishedPostId], references: [id], onDelete: Cascade)

  @@index([workspaceId, sentiment, createdAt])
  @@index([publishedPostId, createdAt])
}

model AnalyticsSnapshot {
  id               String   @id @default(uuid())
  workspaceId      String
  publishedPostId  String?
  snapshotAt       DateTime
  impressions      Int?
  reactions        Int?
  commentsCount    Int?
  shares           Int?
  engagementRate   Float?
  ctr              Float?
  createdAt        DateTime @default(now())

  workspace        Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  publishedPost    PublishedPost? @relation(fields: [publishedPostId], references: [id], onDelete: Cascade)

  @@unique([publishedPostId, snapshotAt])
  @@index([workspaceId, snapshotAt])
}

model AutomationRule {
  id               String   @id @default(uuid())
  workspaceId      String
  name             String
  triggerType      String
  enabled          Boolean  @default(true)
  latestVersionId  String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  workspace        Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  versions         AutomationRuleVersion[]
  runs             AutomationRun[]

  @@index([workspaceId, enabled, triggerType])
}

model AutomationRuleVersion {
  id               String   @id @default(uuid())
  ruleId           String
  version          Int
  definitionJson   Json
  createdBy        String
  isPublished      Boolean  @default(false)
  createdAt        DateTime @default(now())

  rule             AutomationRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)

  @@unique([ruleId, version])
  @@index([ruleId, isPublished])
}

model AutomationRun {
  id               String              @id @default(uuid())
  workspaceId      String
  ruleId           String
  eventId          String
  status           AutomationRunStatus
  startedAt        DateTime            @default(now())
  endedAt          DateTime?
  errorJson        Json?

  workspace        Workspace           @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  rule             AutomationRule      @relation(fields: [ruleId], references: [id], onDelete: Cascade)

  @@index([workspaceId, startedAt])
  @@index([ruleId, status])
}

model Approval {
  id                     String         @id @default(uuid())
  workspaceId            String
  actionType             String
  actionPayloadJson      Json
  status                 ApprovalStatus @default(PENDING)
  requestedBySystemAt    DateTime       @default(now())
  decidedByUserId        String?
  decidedAt              DateTime?
  expiresAt              DateTime?

  workspace              Workspace      @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  decidedBy              User?          @relation("ApprovalDecider", fields: [decidedByUserId], references: [id])

  @@index([workspaceId, status, requestedBySystemAt])
}

model Notification {
  id               String             @id @default(uuid())
  workspaceId      String
  userId           String?
  channel          NotificationChannel
  templateKey      String
  payloadJson      Json
  status           DeliveryStatus     @default(PENDING)
  sentAt           DateTime?
  createdAt        DateTime           @default(now())

  workspace        Workspace          @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user             User?              @relation(fields: [userId], references: [id])

  @@index([workspaceId, status, createdAt])
}

model Webhook {
  id               String   @id @default(uuid())
  workspaceId      String
  targetUrl        String
  secretEnc        String
  eventTypesJson   Json
  enabled          Boolean  @default(true)
  createdAt        DateTime @default(now())

  workspace        Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, enabled])
}

model AuditLog {
  id               String   @id @default(uuid())
  workspaceId      String
  actorType        String
  actorId          String?
  action           String
  entityType       String
  entityId         String
  diffJson         Json?
  ip               String?
  userAgent        String?
  createdAt        DateTime @default(now())

  workspace        Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, createdAt])
  @@index([entityType, entityId])
}

model BillingSubscription {
  id                String   @id @default(uuid())
  workspaceId       String   @unique
  provider          String
  providerCustomerId String
  providerSubId     String
  status            String
  currentPeriodEnd  DateTime
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  workspace         Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([status, currentPeriodEnd])
}
```

---

## 5) API Contract (OpenAPI-Oriented)

## Auth
- `POST /v1/auth/signup`
- `POST /v1/auth/login/magic-link`
- `POST /v1/auth/session/refresh`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`

## LinkedIn
- `GET /v1/linkedin/oauth/start?workspaceId=...`
- `GET /v1/linkedin/oauth/callback?code=...&state=...`
- `GET /v1/linkedin/accounts`
- `GET /v1/linkedin/accounts/:id/capabilities`
- `POST /v1/linkedin/accounts/:id/disconnect`

## Posts
- `POST /v1/posts/drafts`
  - Body: `{ "title?": "", "content": "", "media?": [], "goal?": "thought_leadership" }`
- `POST /v1/posts/drafts/:id/generate-variants`
  - Body: `{ "tones": ["expert","story","direct"], "count": 3 }`
- `POST /v1/posts/scheduled`
  - Body: `{ "draftId":"", "linkedInAccountId":"", "scheduledFor":"ISO", "policyMode":"approval|auto" }`
- `GET /v1/posts/calendar?from=...&to=...`
- `POST /v1/posts/scheduled/:id/approve`
- `POST /v1/posts/scheduled/:id/cancel`

## Comments
- `GET /v1/comments?postId=&sentiment=&cursor=`
- `POST /v1/comments/:id/generate-replies`
- `POST /v1/comments/:id/replies`
  - Body: `{ "mode": "approve|send", "replyText": "..." }`

## Analytics
- `GET /v1/analytics/posts/:publishedPostId?window=7d`
- `GET /v1/analytics/account/summary?from=&to=`
- `GET /v1/analytics/reports/weekly/:isoWeek`

## Automations
- `GET /v1/automations/rules`
- `POST /v1/automations/rules`
  - Body: `{ "name":"", "triggerType":"comment.new", "definition": {...} }`
- `POST /v1/automations/rules/:id/versions`
- `POST /v1/automations/rules/:id/publish-version/:version`
- `POST /v1/automations/rules/:id/toggle`
- `GET /v1/automations/runs?ruleId=&status=`

## Approvals
- `GET /v1/approvals?status=pending`
- `POST /v1/approvals/:id/approve`
- `POST /v1/approvals/:id/reject`

## Notifications
- `GET /v1/notifications`
- `PUT /v1/notifications/preferences`
- `POST /v1/notifications/test`

## Internal/Admin
- `POST /v1/internal/jobs/enqueue`
- `POST /v1/internal/webhooks/:provider`
- `GET /v1/internal/health`
- `GET /v1/internal/metrics`

---

## 6) Event and Queue Contracts

## Canonical event envelope
```json
{
  "id": "evt_uuid",
  "workspaceId": "ws_uuid",
  "type": "comment.new",
  "occurredAt": "2026-01-01T00:00:00Z",
  "source": "comments-service",
  "entity": { "type": "comment", "id": "c_uuid" },
  "payload": {}
}
```

## Events to implement first
- `post.schedule.due`
- `post.publish.requested`
- `post.published`
- `post.publish.failed`
- `comment.new`
- `comment.enriched`
- `analytics.snapshot.created`
- `engagement.threshold.crossed`
- `approval.requested`
- `approval.approved`
- `approval.rejected`
- `report.weekly.generated`

## Queues
- `q:publish`
- `q:comment_sync`
- `q:analytics`
- `q:ai`
- `q:automation`
- `q:notifications`
- `q:webhook_delivery`
- `q:dead_letter`

## Job metadata standard
Each job payload includes:
- `jobId`
- `workspaceId`
- `idempotencyKey`
- `attempt`
- `traceId`

---

## 7) Automation Engine DSL (V1)

## JSON rule definition
```json
{
  "trigger": { "type": "comment.new" },
  "conditions": [
    { "field": "comment.sentiment", "op": "in", "value": ["negative", "question"] }
  ],
  "actions": [
    { "type": "ai.generate_reply_suggestions", "params": { "count": 3 } },
    { "type": "approval.create", "params": { "actionType": "comment.reply" } }
  ]
}
```

Operators (V1): `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`.

Action catalog (V1):
- `linkedin.publish_post`
- `linkedin.reply_comment`
- `analytics.collect_snapshot`
- `ai.generate_draft`
- `ai.generate_reply_suggestions`
- `notifications.send`
- `approval.create`
- `webhook.emit`

Policy gate algorithm:
1. Resolve action type.
2. Resolve account capabilities and workspace safe-mode.
3. If disallowed/uncertain => transform to `approval.create`.
4. Execute and log action decision in `audit_logs`.

---

## 8) Idempotency, Retries, and DLQ

### Idempotency keys
- Publish: `publish:{scheduledPostId}`
- Snapshot: `snapshot:{publishedPostId}:{bucketIso}`
- Comment sync insert: `comment:{linkedinCommentId}`
- Notification delivery: `notif:{notificationId}:{channel}`

### Retry classes
- Transient (429/5xx/network): exponential backoff with jitter, max 5-7 attempts.
- Permanent (401 invalid token/403 scope denied/400 schema): no retry, create incident + approval fallback.

### Dead-letter policy
- On max attempts exceeded or permanent errors where human remediation required:
  - push to `q:dead_letter`
  - persist root cause
  - create notification for owner/admin
  - provide replay endpoint after fix

---

## 9) Observability and SLOs

### Logs
- Structured JSON logs with fields:
  - `timestamp`, `level`, `service`, `traceId`, `workspaceId`, `eventType`, `jobId`, `errorCode`

### Metrics (minimum)
- `publish_success_rate`
- `publish_latency_p95`
- `comment_sync_lag_seconds`
- `analytics_snapshot_completion_rate`
- `approval_backlog_count`
- `rule_execution_fail_rate`
- `webhook_delivery_success_rate`

### Initial SLOs
- Publish success (capable accounts): >= 99%
- Snapshot completion (scheduled buckets): >= 98%
- Notification delivery success: >= 99%

---

## 10) Frontend Implementation Plan (Next.js)

Pages/routes:
- `/onboarding/connect-linkedin`
- `/studio/drafts`
- `/studio/calendar`
- `/inbox/comments`
- `/analytics/overview`
- `/automations/rules`
- `/approvals`
- `/settings/integrations`
- `/settings/team`

Critical UX constraints:
- Every action that may become manual must show clear reason code (missing scope, policy lock, reauth required).
- Always display whether action was auto-executed or approval-gated.
- Include full audit trail panel per post/comment.

---

## 11) 30/60/90 Delivery Checklist (Engineering)

### Day 0–30
- [ ] Prisma schema + migrations
- [ ] OAuth connect + capability extraction
- [ ] Draft/schedule flows
- [ ] Approval system
- [ ] Publish queue + idempotency
- [ ] Analytics snapshot pipeline
- [ ] Comment sync + sentiment + reply suggestions
- [ ] Weekly reports

### Day 31–60
- [ ] Rule builder UI v1
- [ ] Slack/webhook notifications
- [ ] Underperforming-post recommendations
- [ ] Billing plans + limits
- [ ] Hardened monitoring and alerting

### Day 61–90
- [ ] Multi-account per workspace
- [ ] Advanced optimization copilots
- [ ] Improved governance (multi-step approvals)
- [ ] Enterprise audit exports

---

## 12) Non-Negotiables (Do/Do-Not)

### Do
- Build on official API capabilities and dynamically degrade with approval gates.
- Make workflow reliability and compliance auditability the product core.
- Use capability-aware orchestration to avoid broken promises.

### Do not
- Promise unsupported autonomous actions.
- Couple growth to scraping or prohibited automation.
- Execute external write actions without idempotency, audit logs, and policy checks.
