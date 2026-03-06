# linkedin_automation

Automation-first LinkedIn SaaS starter (now with a working vertical-slice API flow).

## What is implemented now
- LinkedIn account connect (mock capability flags)
- Draft creation/listing
- Post scheduling
- Due scheduler dispatch endpoint
- Approval queue and approve/reject actions
- Publish simulation + published post listing
- Audit logs

## Repo structure
- `apps/api`: Fastify API implementing the vertical slice
- `apps/worker`: BullMQ worker scaffold
- `packages/db`: Prisma core schema (next step: wire into API)
- `docs/implementation_spec.md`: full architecture
- `docs/next_steps.md`: 14-day execution plan

## Quickstart
1. Copy env:
   - `cp .env.example .env`
2. Install dependencies:
   - `npm install`
3. Start API:
   - `npm run dev:api`
4. (Optional) Start worker:
   - `npm run dev:worker`

## API endpoints (current)
- `GET /v1/internal/health`
- `GET /v1/auth/me`
- `POST /v1/linkedin/accounts/connect`
- `GET /v1/linkedin/accounts`
- `GET /v1/linkedin/accounts/:id/capabilities`
- `POST /v1/posts/drafts`
- `GET /v1/posts/drafts`
- `POST /v1/posts/scheduled`
- `GET /v1/posts/calendar`
- `POST /v1/internal/scheduler/dispatch-due`
- `GET /v1/approvals`
- `POST /v1/approvals/:id/approve`
- `POST /v1/approvals/:id/reject`
- `GET /v1/posts/published`
- `GET /v1/audit-logs`

## Smoke test (manual)
With API running:
- `./scripts/smoke_api.sh`

This executes end-to-end:
connect account → create draft → schedule due post → dispatch → approve → verify published post.

## Next build step
Wire `apps/api` handlers to Prisma (`packages/db`) so this flow persists to Postgres instead of in-memory arrays.
