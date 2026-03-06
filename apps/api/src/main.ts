import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { createRepository } from './repository.js';
import type { CapabilityFlags, ScheduledPost } from './types.js';

const app = Fastify({ logger: true });
const PORT = Number(process.env.APP_PORT ?? 4000);
const repo = await createRepository();

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

async function publishScheduledPost(scheduledPost: ScheduledPost) {
  await repo.updateScheduledPostState(scheduledPost.id, 'PUBLISHING');

  const publishedPost = await repo.createPublishedPost(scheduledPost.workspaceId, scheduledPost.id);
  await repo.updateScheduledPostState(scheduledPost.id, 'PUBLISHED');

  await repo.writeAuditLog({
    workspaceId: scheduledPost.workspaceId,
    actorType: 'system',
    action: 'post.published',
    entityType: 'scheduled_post',
    entityId: scheduledPost.id,
  });

  return publishedPost;
}

async function createApproval(workspaceId: string, scheduledPostId: string) {
  const approval = await repo.createApproval(workspaceId, scheduledPostId);
  await repo.writeAuditLog({
    workspaceId,
    actorType: 'system',
    action: 'approval.requested',
    entityType: 'approval',
    entityId: approval.id,
  });
  return approval;
}

app.get('/v1/internal/health', async () => ({ status: 'ok', service: 'api' }));
app.get('/v1/internal/storage', async () => ({ driver: repo.driver }));

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
  const existing = (await repo.getLinkedInAccounts(body.workspaceId)).find(
    (a) => a.linkedinMemberId === body.linkedinMemberId,
  );
  if (existing) return reply.code(409).send({ error: 'LinkedIn account already connected' });

  const account = await repo.createLinkedInAccount({
    workspaceId: body.workspaceId,
    linkedinMemberId: body.linkedinMemberId,
    displayName: body.displayName,
    scopes: body.scopes,
    capabilities: body.capabilities ?? defaultCapabilities(),
  });

  await repo.writeAuditLog({
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
  return { accounts: await repo.getLinkedInAccounts(workspaceId) };
});

app.get('/v1/linkedin/accounts/:id/capabilities', async (req, reply) => {
  const { id } = req.params as { id: string };
  const account = await repo.getLinkedInAccountById(id);
  if (!account) return reply.code(404).send({ error: 'LinkedIn account not found' });
  return { accountId: account.id, capabilities: account.capabilities };
});

app.post('/v1/posts/drafts', async (req, reply) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const draft = await repo.createDraft(parsed.data);

  await repo.writeAuditLog({
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
  return { drafts: await repo.getDrafts(workspaceId) };
});

app.post('/v1/posts/scheduled', async (req, reply) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const body = parsed.data;
  const draft = await repo.getDraftById(body.workspaceId, body.draftId);
  if (!draft) return reply.code(404).send({ error: 'Draft not found' });

  const account = await repo.getLinkedInAccountById(body.linkedInAccountId);
  if (!account || account.workspaceId !== body.workspaceId) {
    return reply.code(404).send({ error: 'LinkedIn account not found' });
  }

  const scheduledPost = await repo.createScheduledPost(body);

  await repo.writeAuditLog({
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
  return { scheduledPosts: await repo.getScheduledPosts(workspaceId) };
});

app.post('/v1/internal/scheduler/dispatch-due', async () => {
  const duePosts = await repo.findDueScheduledPosts(new Date().toISOString());

  const summary = {
    dueCount: duePosts.length,
    createdApprovals: 0,
    publishedCount: 0,
  };

  for (const post of duePosts) {
    const account = await repo.getLinkedInAccountById(post.linkedInAccountId);
    if (!account) {
      await repo.updateScheduledPostState(post.id, 'FAILED');
      continue;
    }

    const forceApproval =
      post.policyMode === 'approval' ||
      account.capabilities.requiresManualPublish ||
      !account.capabilities.canPublishPosts;

    if (forceApproval && post.state !== 'APPROVED') {
      await repo.updateScheduledPostState(post.id, 'AWAITING_APPROVAL');
      await createApproval(post.workspaceId, post.id);
      summary.createdApprovals += 1;
      continue;
    }

    await publishScheduledPost(post);
    summary.publishedCount += 1;
  }

  return summary;
});

app.get('/v1/approvals', async (req) => {
  const query = req.query as { workspaceId?: string; status?: 'PENDING' | 'APPROVED' | 'REJECTED' };
  return { approvals: await repo.getApprovals(query.workspaceId, query.status) };
});

app.post('/v1/approvals/:id/approve', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = approvalDecisionSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const approval = await repo.getApprovalById(id);
  if (!approval) return reply.code(404).send({ error: 'Approval not found' });
  if (approval.status !== 'PENDING') return reply.code(409).send({ error: 'Approval already decided' });

  const decided = await repo.updateApprovalDecision(id, 'APPROVED', parsed.data.decidedByUserId);
  if (!decided) return reply.code(500).send({ error: 'Failed to update approval' });

  const scheduledPost = (await repo.getScheduledPosts()).find((p) => p.id === approval.actionPayload.scheduledPostId);
  if (!scheduledPost) return reply.code(404).send({ error: 'Scheduled post not found for approval' });

  await repo.updateScheduledPostState(scheduledPost.id, 'APPROVED');
  const publishedPost = await publishScheduledPost({ ...scheduledPost, state: 'APPROVED' });

  await repo.writeAuditLog({
    workspaceId: approval.workspaceId,
    actorType: 'user',
    actorId: parsed.data.decidedByUserId,
    action: 'approval.approved',
    entityType: 'approval',
    entityId: approval.id,
  });

  return { approval: decided, publishedPost };
});

app.post('/v1/approvals/:id/reject', async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = approvalDecisionSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const approval = await repo.getApprovalById(id);
  if (!approval) return reply.code(404).send({ error: 'Approval not found' });
  if (approval.status !== 'PENDING') return reply.code(409).send({ error: 'Approval already decided' });

  const decided = await repo.updateApprovalDecision(id, 'REJECTED', parsed.data.decidedByUserId);
  if (!decided) return reply.code(500).send({ error: 'Failed to update approval' });

  await repo.updateScheduledPostState(approval.actionPayload.scheduledPostId, 'CANCELED');

  await repo.writeAuditLog({
    workspaceId: approval.workspaceId,
    actorType: 'user',
    actorId: parsed.data.decidedByUserId,
    action: 'approval.rejected',
    entityType: 'approval',
    entityId: approval.id,
  });

  return { approval: decided };
});

app.get('/v1/posts/published', async (req) => {
  const { workspaceId } = req.query as { workspaceId?: string };
  return { publishedPosts: await repo.getPublishedPosts(workspaceId) };
});

app.get('/v1/audit-logs', async (req) => {
  const { workspaceId } = req.query as { workspaceId?: string };
  return { auditLogs: await repo.getAuditLogs(workspaceId) };
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`API running on :${PORT} (storage=${repo.driver})`);
});
