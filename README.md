# linkedin_automation

Automation-first LinkedIn SaaS starter with a working vertical-slice API flow.

## What is implemented now
- LinkedIn account connect (capability flags)
- Draft creation/listing
- Post scheduling
- Due scheduler dispatch endpoint
- Approval queue and approve/reject actions
- Publish simulation + published post listing
- Audit logs
- Storage abstraction with runtime driver selection:
  - `memory` (default)
  - `prisma` (when Prisma client + DB are available)

## Repo structure
- `apps/api`: Fastify API implementing the vertical slice
- `apps/worker`: BullMQ worker scaffold
- `packages/db`: Prisma core schema
- `docs/implementation_spec.md`: full architecture
- `docs/next_steps.md`: 14-day execution plan

## Quickstart (memory mode)
1. Copy env:
   - `cp .env.example .env`
2. Ensure storage driver is memory:
   - `STORAGE_DRIVER=memory`
3. Install dependencies:
   - `npm install`
4. Start API:
   - `npm run dev:api`
5. Run smoke flow:
   - `./scripts/smoke_api.sh`

## Quickstart (Prisma mode)
1. Set in `.env`:
   - `STORAGE_DRIVER=prisma`
   - `DATABASE_URL=...`
2. Generate Prisma client and apply schema:
   - `npm run prisma:generate -w packages/db`
   - `npm run prisma:push -w packages/db`
3. Start API:
   - `npm run dev:api`
4. Verify storage driver:
   - `GET /v1/internal/storage`

If Prisma is unavailable at runtime, API safely falls back to memory mode.

## API endpoints (current)
- `GET /v1/internal/health`
- `GET /v1/internal/storage`
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

This executes:
connect account → create draft → schedule due post → dispatch → approve → verify published post.
