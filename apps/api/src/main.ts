import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { store, writeAuditLog } from './store.js';
import type { Approval, CapabilityFlags, Draft, PublishedPost, ScheduledPost } from './types.js';

const app = Fastify({ logger: true });
const PORT = Number(process.env.APP_PORT ?? 4000);

await app.register(cors, { origin: true });

const connectLinkedInSchema = z.object({
  workspaceId: z.string().uuid(),
  linkedinMemberId: z.string().min(1),
  displayName: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  capabilities: z
    .object({
      canPublishPosts: z.boolean().default(false),
      canReadComments: z.boolean().default(false),
      canWriteCommentReplies: z.boolean().default(false),
      canReadPostAnalytics: z.boolean().default(false),
      hasWebhookSupport: z.boolean().default(false),
      requiresManualPublish: z.boolean().default(true),
      requiresManualReply: z.boolean().default(true),
    })
    .optional(),
});

const draftSchema = z.object({
  workspaceId: z.string().uuid(),
  authorUserId: z.string().uuid(),
  content: z.string().min(1),
  title: z.string().optional(),
  media: z.array(z.string().url()).optional(),
});

const scheduleSchema = z.object({
  workspaceId: z.string().uuid(),
  draftId: z.string().uuid(),
  linkedInAccountId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
  policyMode: z.enum(['approval', 'auto']).default('approval'),
});

const approvalDecisionSchema = z.object({
  decidedByUserId: z.string().uuid(),
});

function defaultCapabilities(): CapabilityFlags {
  return {
    canPublishPosts: false,
    canReadComments: false,
    canWriteCommentReplies: false,
    canReadPostAnalytics: false,
    hasWebhookSupport: false,
    requiresManualPublish: true,
    requiresManualReply: true,
  };
}

function publishScheduledPost(scheduledPost: ScheduledPost): PublishedPost {
  scheduledPost.state = 'PUBLISHING';

  const publishedPost: PublishedPost = {
    id: crypto.randomUUID(),
    workspaceId: scheduledPost.workspaceId,
    scheduledPostId: scheduledPost.id,
    linkedinPostUrn: `urn:li:share:${Date.now()}`,
    publishedAt: new Date().toISOString(),
  };

  store.publishedPosts.push(publishedPost);
  scheduledPost.state = 'PUBLISHED';

  writeAuditLog({
    workspaceId: scheduledPost.workspaceId,
    actorType: 'system',
    action: 'post.published',
    entityType: 'scheduled_post',
    entityId: scheduledPost.id,
  });

  return publishedPost;
}

function createApproval(workspaceId: string, scheduledPostId: string): Approval {
  const approval: Approval = {
    id: crypto.randomUUID(),
    workspaceId,
    actionType: 'linkedin.publish_post',
    actionPayload: { scheduledPostId },
    status: 'PENDING',
    requestedBySystemAt: new Date().toISOString(),
  };

  store.approvals.push(approval);

  writeAuditLog({
    workspaceId,
    actorType: 'system',
    action: 'approval.requested',
    entityType: 'approval',
    entityId: approval.id,
  });

  return approval;
}

app.get('/v1/internal/health', async () => ({ status: 'ok', service: 'api' }));

app.get('/v1/auth/me', async () => ({
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'founder@example.com',
  },
  workspaces: [],
}));

app.post('/v1/linkedin/accounts/connect', async (req, reply) => {
  const parsed = connectLinkedInSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const body = parsed.data;
  const existing = store.linkedInAccounts.find(
    (a) => a.workspaceId === body.workspaceId && a.linkedinMemberId === body.linkedinMemberId,
  );
  if (existing) return reply.code(409).send({ error: 'LinkedIn account already connected' });

  const account = {
    id: crypto.randomUUID(),
    workspaceId: body.workspaceId,
    linkedinMemberId: body.linkedinMemberId,
    displayName: body.displayName,
    connectionStatus: 'ACTIVE' as const,
    scopes: body.scopes,
    capabilities: body.capabilities ?? defaultCapabilities(),
    createdAt: new Date().toISOString(),
  };

  store.linkedInAccounts.push(account);
  writeAuditLog({
    workspaceId: account.workspaceId,
    actorType: 'user',
    action: 'linkedin.account.connected',
    entityType: 'linkedin_account',
    entityId: account.id,
  });

  return reply.code(201).send({ account });
});

app.get('/v1/linkedin/accounts', async (req) => {
  const { workspaceId } = req.query as { workspaceId?: string };
  return {
    accounts: workspaceId
      ? store.linkedInAccounts.filter((a) => a.workspaceId === workspaceId)
      : store.linkedInAccounts,
  };
});

app.get('/v1/linkedin/accounts/:id/capabilities', async (req, reply) => {
  const { id } = req.params as { id: string };
  const account = store.linkedInAccounts.find((a) => a.id === id);
  if (!account) return reply.code(404).send({ error: 'LinkedIn account not found' });
  return { accountId: account.id, capabilities: account.capabilities };
});

app.post('/v1/posts/drafts', async (req, reply) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const draft: Draft = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...parsed.data,
  };

  store.drafts.push(draft);
  writeAuditLog({
    workspaceId: draft.workspaceId,
    actorType: 'user',
    actorId: draft.authorUserId,
    action: 'draft.created',
    entityType: 'post_draft',
    entityId: draft.id,
  });

  return reply.code(201).send({ draft });
});

app.get('/v1/posts/drafts', async (req) => {
  const { workspaceId } = req.query as { workspaceId?: string };
  return {
    drafts: workspaceId ? store.drafts.filter((d) => d.workspaceId === workspaceId) : store.drafts,
  };
});

app.post('/v1/posts/scheduled', async (req, reply) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const body = parsed.data;
  const draft = store.drafts.find((d) => d.id === body.draftId && d.workspaceId === body.workspaceId);
  if (!draft) return reply.code(404).send({ error: 'Draft not found' });

  const account = store.linkedInAccounts.find(
    (a) => a.id === body.linkedInAccountId && a.workspaceId === body.workspaceId,
  );
  if (!account) return reply.code(404).send({ error: 'LinkedIn account not found' });

  const scheduledPost: ScheduledPost = {
    id: crypto.randomUUID(),
    idempotencyKey: `publish:${body.draftId}:${body.scheduledFor}`,
    state: 'PENDING',
    createdAt: new Date().toISOString(),
    ...body,
  };

  store.scheduledPosts.push(scheduledPost);
  writeAuditLog({
    workspaceId: scheduledPost.workspaceId,
    actorType: 'user',
    action: 'scheduled_post.created',
    entityType: 'scheduled_post',
    entityId: scheduledPost.id,
  });

  return reply.code(201).send({ scheduledPost });
});

app.get('/v1/posts/calendar', async (req) => {
  const { workspaceId } = req.query as { workspaceId?: string };
  return {
    scheduledPosts: workspaceId
      ? store.scheduledPosts.filter((p) => p.workspaceId === workspaceId)
      : store.scheduledPosts,
  };
});

app.post('/v1/internal/scheduler/dispatch-due', async (req) => {
  const now = new Date();
  const duePosts = store.scheduledPosts.filter(
    (p) => (p.state === 'PENDING' || p.state === 'APPROVED') && new Date(p.scheduledFor) <= now,
  );

  const summary = {
    dueCount: duePosts.length,
    createdApprovals: 0,
    publishedCount: 0,
  };

  for (const post of duePosts) {
    const account = store.linkedInAccounts.find((a) => a.id === post.linkedInAccountId);
    if (!account) {
      post.state = 'FAILED';
      continue;
    }

    const forceApproval =
      post.policyMode === 'approval' ||
      account.capabilities.requiresManualPublish ||
      !account.capabilities.canPublishPosts;

    if (forceApproval && post.state !== 'APPROVED') {
      post.state = 'AWAITING_APPROVAL';
      createApproval(post.workspaceId, post.id);
      summary.createdApprovals += 1;
      continue;
    }

    publishScheduledPost(post);
    summary.publishedCount += 1;
  }

  return summary;
});

app.get('/v1/approvals', async (req) => {
  const query = req.query as { workspaceId?: string; status?: 'PENDING' | 'APPROVED' | 'REJECTED' };
  return {
    approvals: store.approvals.filter((a) => {
      if (query.workspaceId && a.workspaceId !== query.workspaceId) return false;
      if (query.status && a.status !== query.status) return false;
      return true;
    }),
  };
});

app.post('/v1/approvals/:id/approve', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = approvalDecisionSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const approval = store.approvals.find((a) => a.id === id);
  if (!approval) return reply.code(404).send({ error: 'Approval not found' });
  if (approval.status !== 'PENDING') return reply.code(409).send({ error: 'Approval already decided' });

  approval.status = 'APPROVED';
  approval.decidedByUserId = parsed.data.decidedByUserId;
  approval.decidedAt = new Date().toISOString();

  const scheduledPost = store.scheduledPosts.find((p) => p.id === approval.actionPayload.scheduledPostId);
  if (!scheduledPost) return reply.code(404).send({ error: 'Scheduled post not found for approval' });

  scheduledPost.state = 'APPROVED';
  const publishedPost = publishScheduledPost(scheduledPost);

  writeAuditLog({
    workspaceId: approval.workspaceId,
    actorType: 'user',
    actorId: approval.decidedByUserId,
    action: 'approval.approved',
    entityType: 'approval',
    entityId: approval.id,
  });

  return { approval, publishedPost };
});

app.post('/v1/approvals/:id/reject', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = approvalDecisionSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const approval = store.approvals.find((a) => a.id === id);
  if (!approval) return reply.code(404).send({ error: 'Approval not found' });
  if (approval.status !== 'PENDING') return reply.code(409).send({ error: 'Approval already decided' });

  approval.status = 'REJECTED';
  approval.decidedByUserId = parsed.data.decidedByUserId;
  approval.decidedAt = new Date().toISOString();

  const scheduledPost = store.scheduledPosts.find((p) => p.id === approval.actionPayload.scheduledPostId);
  if (scheduledPost) scheduledPost.state = 'CANCELED';

  writeAuditLog({
    workspaceId: approval.workspaceId,
    actorType: 'user',
    actorId: approval.decidedByUserId,
    action: 'approval.rejected',
    entityType: 'approval',
    entityId: approval.id,
  });

  return { approval };
});

app.get('/v1/posts/published', async (req) => {
  const { workspaceId } = req.query as { workspaceId?: string };
  return {
    publishedPosts: workspaceId
      ? store.publishedPosts.filter((p) => p.workspaceId === workspaceId)
      : store.publishedPosts,
  };
});

app.get('/v1/audit-logs', async (req) => {
  const { workspaceId } = req.query as { workspaceId?: string };
  return {
    auditLogs: workspaceId ? store.auditLogs.filter((a) => a.workspaceId === workspaceId) : store.auditLogs,
  };
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`API running on :${PORT}`);
});
