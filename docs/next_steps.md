# What Next — Execution Kickoff Plan

This is the immediate follow-up to `docs/implementation_spec.md`.

## Goal for the next 14 days
Build a thin but real vertical slice:
- connect LinkedIn account via OAuth
- create draft
- schedule post
- execute scheduled action through approval gate
- record audit trail

If this slice works end-to-end, the rest of the product becomes iterative expansion rather than architecture risk.

---

## Week 1 (foundation + auth + data)

## Day 1: Repo scaffold and local infra
- Create monorepo app/package structure from the spec.
- Add Docker Compose for Postgres + Redis.
- Add `.env.example` with required variables.

**Acceptance criteria**
- `pnpm dev` starts web + api + worker.
- API health endpoint returns 200.

## Day 2: Prisma baseline + migrations
- Add Prisma schema from `implementation_spec.md` (starting with core entities only):
  - users, workspaces, team_members
  - linkedin_accounts, oauth_tokens
  - post_drafts, scheduled_posts, approvals, audit_logs
- Run first migration.

**Acceptance criteria**
- Migration applies on a fresh DB.
- Seed script creates one workspace + owner user.

## Day 3: Auth + workspace context
- Implement magic-link (or dev-only password) auth.
- Add workspace membership middleware and role checks.

**Acceptance criteria**
- Authenticated user can access workspace-scoped routes.
- Unauthorized workspace access is blocked.

## Day 4: LinkedIn OAuth connect/disconnect
- Implement OAuth start + callback endpoints.
- Persist encrypted tokens + capability flags.
- Add connection status handling (`active`, `reauth_required`, `revoked`).

**Acceptance criteria**
- User can connect account from UI.
- DB row has capability flags populated.

## Day 5: Draft + schedule APIs
- Draft CRUD endpoints.
- Schedule endpoint with `policyMode` (`approval` or `auto`) and `scheduledFor`.
- Basic frontend forms for draft + scheduling.

**Acceptance criteria**
- User can save draft and schedule it.
- Scheduled post appears in calendar/list.

---

## Week 2 (automation engine slice)

## Day 6: Queue plumbing + scheduler
- Configure BullMQ queues.
- Add minute cron to enqueue due scheduled posts.

**Acceptance criteria**
- Due scheduled posts enqueue exactly once (idempotency key).

## Day 7: Approval gate workflow
- If account requires manual publish or capability missing:
  - create approval record
  - mark scheduled post `AWAITING_APPROVAL`
- Add Approvals inbox UI.

**Acceptance criteria**
- Due post generates approval instead of publishing when gated.

## Day 8: Publish executor (stub adapter)
- Build publish worker with adapter interface:
  - `publishPost(account, payload)`
- For now, use stub provider in non-prod to emulate success/failure.

**Acceptance criteria**
- Approved item triggers publish executor.
- Publish result stored in `published_posts`.

## Day 9: Audit logs + failure handling
- Write audit entries for:
  - schedule created
  - approval requested/approved/rejected
  - publish attempted/succeeded/failed
- Implement retries + dead-letter queue for publish job.

**Acceptance criteria**
- Every critical action is visible in audit trail.
- Failed job appears in DLQ with error reason.

## Day 10: Demo hardening + smoke tests
- Add API smoke test script for core flow:
  1) auth
  2) draft create
  3) schedule
  4) due dispatch
  5) approval
  6) publish success path
- Record a short loom/demo.

**Acceptance criteria**
- Single command runs smoke flow locally.
- Demo shows complete happy path.

---

## What to intentionally defer (for now)
- Full visual automation rule builder
- CRM deep integrations
- Multi-account orchestration
- Advanced analytics models
- Auto-replies in production mode

---

## Immediate technical debt checklist (keep small)
- Add request validation on all POST/PUT endpoints.
- Add structured logging with `workspaceId` and `traceId`.
- Add global idempotency utility for queue jobs.
- Add token refresh worker skeleton (even if no-op initially).

---

## Decision gates after 14 days
1. **Capability gate**: Do connected accounts actually expose required scopes?
2. **Reliability gate**: Is scheduled dispatch + approval + publish stable under retries?
3. **UX gate**: Can a non-technical user complete the full flow without support?

If all 3 pass, proceed to analytics and comment-intelligence expansion.
