import type { Approval, AuditLog, Draft, LinkedInAccount, PublishedPost, ScheduledPost } from './types.js';
import { store } from './store.js';

export type CreateLinkedInAccountInput = Omit<LinkedInAccount, 'id' | 'createdAt' | 'connectionStatus'>;
export type CreateDraftInput = Omit<Draft, 'id' | 'createdAt'>;
export type CreateScheduledPostInput = Omit<ScheduledPost, 'id' | 'createdAt' | 'state' | 'idempotencyKey'>;

export interface Repository {
  driver: 'memory' | 'prisma';
  createLinkedInAccount(input: CreateLinkedInAccountInput): Promise<LinkedInAccount>;
  getLinkedInAccounts(workspaceId?: string): Promise<LinkedInAccount[]>;
  getLinkedInAccountById(id: string): Promise<LinkedInAccount | null>;

  createDraft(input: CreateDraftInput): Promise<Draft>;
  getDrafts(workspaceId?: string): Promise<Draft[]>;
  getDraftById(workspaceId: string, draftId: string): Promise<Draft | null>;

  createScheduledPost(input: CreateScheduledPostInput): Promise<ScheduledPost>;
  getScheduledPosts(workspaceId?: string): Promise<ScheduledPost[]>;
  findDueScheduledPosts(nowIso: string): Promise<ScheduledPost[]>;
  updateScheduledPostState(id: string, state: ScheduledPost['state']): Promise<ScheduledPost | null>;

  createApproval(workspaceId: string, scheduledPostId: string): Promise<Approval>;
  getApprovals(workspaceId?: string, status?: Approval['status']): Promise<Approval[]>;
  getApprovalById(id: string): Promise<Approval | null>;
  updateApprovalDecision(id: string, status: 'APPROVED' | 'REJECTED', decidedByUserId: string): Promise<Approval | null>;

  createPublishedPost(workspaceId: string, scheduledPostId: string): Promise<PublishedPost>;
  getPublishedPosts(workspaceId?: string): Promise<PublishedPost[]>;

  writeAuditLog(input: Omit<AuditLog, 'id' | 'createdAt'>): Promise<AuditLog>;
  getAuditLogs(workspaceId?: string): Promise<AuditLog[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createMemoryRepository(): Repository {
  return {
    driver: 'memory',
    async createLinkedInAccount(input) {
      const row: LinkedInAccount = {
        id: crypto.randomUUID(),
        createdAt: nowIso(),
        connectionStatus: 'ACTIVE',
        ...input,
      };
      store.linkedInAccounts.push(row);
      return row;
    },
    async getLinkedInAccounts(workspaceId) {
      return workspaceId ? store.linkedInAccounts.filter((a) => a.workspaceId === workspaceId) : store.linkedInAccounts;
    },
    async getLinkedInAccountById(id) {
      return store.linkedInAccounts.find((a) => a.id === id) ?? null;
    },

    async createDraft(input) {
      const row: Draft = { id: crypto.randomUUID(), createdAt: nowIso(), ...input };
      store.drafts.push(row);
      return row;
    },
    async getDrafts(workspaceId) {
      return workspaceId ? store.drafts.filter((d) => d.workspaceId === workspaceId) : store.drafts;
    },
    async getDraftById(workspaceId, draftId) {
      return store.drafts.find((d) => d.id === draftId && d.workspaceId === workspaceId) ?? null;
    },

    async createScheduledPost(input) {
      const row: ScheduledPost = {
        id: crypto.randomUUID(),
        createdAt: nowIso(),
        state: 'PENDING',
        idempotencyKey: `publish:${input.draftId}:${input.scheduledFor}`,
        ...input,
      };
      store.scheduledPosts.push(row);
      return row;
    },
    async getScheduledPosts(workspaceId) {
      return workspaceId ? store.scheduledPosts.filter((p) => p.workspaceId === workspaceId) : store.scheduledPosts;
    },
    async findDueScheduledPosts(now) {
      return store.scheduledPosts.filter((p) => (p.state === 'PENDING' || p.state === 'APPROVED') && p.scheduledFor <= now);
    },
    async updateScheduledPostState(id, state) {
      const row = store.scheduledPosts.find((p) => p.id === id);
      if (!row) return null;
      row.state = state;
      return row;
    },

    async createApproval(workspaceId, scheduledPostId) {
      const row: Approval = {
        id: crypto.randomUUID(),
        workspaceId,
        actionType: 'linkedin.publish_post',
        actionPayload: { scheduledPostId },
        status: 'PENDING',
        requestedBySystemAt: nowIso(),
      };
      store.approvals.push(row);
      return row;
    },
    async getApprovals(workspaceId, status) {
      return store.approvals.filter((a) => {
        if (workspaceId && a.workspaceId !== workspaceId) return false;
        if (status && a.status !== status) return false;
        return true;
      });
    },
    async getApprovalById(id) {
      return store.approvals.find((a) => a.id === id) ?? null;
    },
    async updateApprovalDecision(id, status, decidedByUserId) {
      const row = store.approvals.find((a) => a.id === id);
      if (!row) return null;
      row.status = status;
      row.decidedByUserId = decidedByUserId;
      row.decidedAt = nowIso();
      return row;
    },

    async createPublishedPost(workspaceId, scheduledPostId) {
      const row: PublishedPost = {
        id: crypto.randomUUID(),
        workspaceId,
        scheduledPostId,
        linkedinPostUrn: `urn:li:share:${Date.now()}`,
        publishedAt: nowIso(),
      };
      store.publishedPosts.push(row);
      return row;
    },
    async getPublishedPosts(workspaceId) {
      return workspaceId ? store.publishedPosts.filter((p) => p.workspaceId === workspaceId) : store.publishedPosts;
    },

    async writeAuditLog(input) {
      const row: AuditLog = { id: crypto.randomUUID(), createdAt: nowIso(), ...input };
      store.auditLogs.push(row);
      return row;
    },
    async getAuditLogs(workspaceId) {
      return workspaceId ? store.auditLogs.filter((a) => a.workspaceId === workspaceId) : store.auditLogs;
    },
  };
}

export async function createRepository(): Promise<Repository> {
  if (process.env.STORAGE_DRIVER !== 'prisma') return createMemoryRepository();

  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    const repo: Repository = {
      driver: 'prisma',
      async createLinkedInAccount(input) {
        const row = await prisma.linkedInAccount.create({
          data: {
            workspaceId: input.workspaceId,
            linkedinMemberId: input.linkedinMemberId,
            displayName: input.displayName,
            canPublishPosts: input.capabilities.canPublishPosts,
            requiresManualPublish: input.capabilities.requiresManualPublish,
          },
        });
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          linkedinMemberId: row.linkedinMemberId,
          displayName: row.displayName,
          connectionStatus: row.connectionStatus,
          scopes: input.scopes,
          capabilities: input.capabilities,
          createdAt: row.createdAt.toISOString(),
        };
      },
      async getLinkedInAccounts(workspaceId) {
        const rows = await prisma.linkedInAccount.findMany({ where: workspaceId ? { workspaceId } : undefined });
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          linkedinMemberId: r.linkedinMemberId,
          displayName: r.displayName,
          connectionStatus: r.connectionStatus,
          scopes: [],
          capabilities: {
            canPublishPosts: r.canPublishPosts,
            canReadComments: false,
            canWriteCommentReplies: false,
            canReadPostAnalytics: false,
            hasWebhookSupport: false,
            requiresManualPublish: r.requiresManualPublish,
            requiresManualReply: true,
          },
          createdAt: r.createdAt.toISOString(),
        }));
      },
      async getLinkedInAccountById(id) {
        const r = await prisma.linkedInAccount.findUnique({ where: { id } });
        if (!r) return null;
        return {
          id: r.id,
          workspaceId: r.workspaceId,
          linkedinMemberId: r.linkedinMemberId,
          displayName: r.displayName,
          connectionStatus: r.connectionStatus,
          scopes: [],
          capabilities: {
            canPublishPosts: r.canPublishPosts,
            canReadComments: false,
            canWriteCommentReplies: false,
            canReadPostAnalytics: false,
            hasWebhookSupport: false,
            requiresManualPublish: r.requiresManualPublish,
            requiresManualReply: true,
          },
          createdAt: r.createdAt.toISOString(),
        };
      },

      async createDraft(input) {
        const row = await prisma.postDraft.create({
          data: {
            workspaceId: input.workspaceId,
            authorUserId: input.authorUserId,
            title: input.title,
            content: input.content,
          },
        });
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          authorUserId: row.authorUserId,
          title: row.title ?? undefined,
          content: row.content,
          createdAt: row.createdAt.toISOString(),
        };
      },
      async getDrafts(workspaceId) {
        const rows = await prisma.postDraft.findMany({ where: workspaceId ? { workspaceId } : undefined });
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          authorUserId: r.authorUserId,
          title: r.title ?? undefined,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        }));
      },
      async getDraftById(workspaceId, draftId) {
        const r = await prisma.postDraft.findFirst({ where: { id: draftId, workspaceId } });
        if (!r) return null;
        return {
          id: r.id,
          workspaceId: r.workspaceId,
          authorUserId: r.authorUserId,
          title: r.title ?? undefined,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        };
      },

      async createScheduledPost(input) {
        const row = await prisma.scheduledPost.create({
          data: {
            workspaceId: input.workspaceId,
            draftId: input.draftId,
            linkedInAccountId: input.linkedInAccountId,
            scheduledFor: new Date(input.scheduledFor),
            policyMode: input.policyMode,
            idempotencyKey: `publish:${input.draftId}:${input.scheduledFor}`,
          },
        });
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          draftId: row.draftId,
          linkedInAccountId: row.linkedInAccountId,
          scheduledFor: row.scheduledFor.toISOString(),
          policyMode: row.policyMode as 'approval' | 'auto',
          state: row.state,
          idempotencyKey: row.idempotencyKey ?? '',
          createdAt: row.createdAt.toISOString(),
        };
      },
      async getScheduledPosts(workspaceId) {
        const rows = await prisma.scheduledPost.findMany({ where: workspaceId ? { workspaceId } : undefined });
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          draftId: r.draftId,
          linkedInAccountId: r.linkedInAccountId,
          scheduledFor: r.scheduledFor.toISOString(),
          policyMode: r.policyMode as 'approval' | 'auto',
          state: r.state,
          idempotencyKey: r.idempotencyKey ?? '',
          createdAt: r.createdAt.toISOString(),
        }));
      },
      async findDueScheduledPosts(nowIsoValue) {
        const rows = await prisma.scheduledPost.findMany({
          where: {
            OR: [{ state: 'PENDING' }, { state: 'APPROVED' }],
            scheduledFor: { lte: new Date(nowIsoValue) },
          },
        });
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          draftId: r.draftId,
          linkedInAccountId: r.linkedInAccountId,
          scheduledFor: r.scheduledFor.toISOString(),
          policyMode: r.policyMode as 'approval' | 'auto',
          state: r.state,
          idempotencyKey: r.idempotencyKey ?? '',
          createdAt: r.createdAt.toISOString(),
        }));
      },
      async updateScheduledPostState(id, state) {
        const row = await prisma.scheduledPost.update({ where: { id }, data: { state } }).catch(() => null);
        if (!row) return null;
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          draftId: row.draftId,
          linkedInAccountId: row.linkedInAccountId,
          scheduledFor: row.scheduledFor.toISOString(),
          policyMode: row.policyMode as 'approval' | 'auto',
          state: row.state,
          idempotencyKey: row.idempotencyKey ?? '',
          createdAt: row.createdAt.toISOString(),
        };
      },

      async createApproval(workspaceId, scheduledPostId) {
        const row = await prisma.approval.create({
          data: {
            workspaceId,
            actionType: 'linkedin.publish_post',
            actionPayloadJson: { scheduledPostId },
          },
        });
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          actionType: 'linkedin.publish_post',
          actionPayload: row.actionPayloadJson as { scheduledPostId: string },
          status: row.status,
          requestedBySystemAt: row.createdAt.toISOString(),
        };
      },
      async getApprovals(workspaceId, status) {
        const rows = await prisma.approval.findMany({
          where: {
            ...(workspaceId ? { workspaceId } : {}),
            ...(status ? { status } : {}),
          },
        });
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          actionType: 'linkedin.publish_post',
          actionPayload: r.actionPayloadJson as { scheduledPostId: string },
          status: r.status,
          requestedBySystemAt: r.createdAt.toISOString(),
        }));
      },
      async getApprovalById(id) {
        const r = await prisma.approval.findUnique({ where: { id } });
        if (!r) return null;
        return {
          id: r.id,
          workspaceId: r.workspaceId,
          actionType: 'linkedin.publish_post',
          actionPayload: r.actionPayloadJson as { scheduledPostId: string },
          status: r.status,
          requestedBySystemAt: r.createdAt.toISOString(),
        };
      },
      async updateApprovalDecision(id, status, decidedByUserId) {
        const r = await prisma.approval
          .update({ where: { id }, data: { status, decidedByUserId, decidedAt: new Date() } })
          .catch(() => null);
        if (!r) return null;
        return {
          id: r.id,
          workspaceId: r.workspaceId,
          actionType: 'linkedin.publish_post',
          actionPayload: r.actionPayloadJson as { scheduledPostId: string },
          status: r.status,
          requestedBySystemAt: r.createdAt.toISOString(),
          decidedByUserId: r.decidedByUserId ?? undefined,
          decidedAt: r.decidedAt?.toISOString(),
        };
      },

      async createPublishedPost(workspaceId, scheduledPostId) {
        const row = await prisma.publishedPost.create({
          data: {
            workspaceId,
            scheduledPostId,
            linkedinPostUrn: `urn:li:share:${Date.now()}`,
            publishedAt: new Date(),
          },
        });
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          scheduledPostId: row.scheduledPostId,
          linkedinPostUrn: row.linkedinPostUrn,
          publishedAt: row.publishedAt.toISOString(),
        };
      },
      async getPublishedPosts(workspaceId) {
        const rows = await prisma.publishedPost.findMany({ where: workspaceId ? { workspaceId } : undefined });
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          scheduledPostId: r.scheduledPostId,
          linkedinPostUrn: r.linkedinPostUrn,
          publishedAt: r.publishedAt.toISOString(),
        }));
      },

      async writeAuditLog(input) {
        const row = await prisma.auditLog.create({
          data: {
            workspaceId: input.workspaceId,
            actorType: input.actorType,
            actorId: input.actorId,
            action: input.action,
            entityType: input.entityType,
            entityId: input.entityId,
          },
        });
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          actorType: row.actorType as 'user' | 'system',
          actorId: row.actorId ?? undefined,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          createdAt: row.createdAt.toISOString(),
        };
      },
      async getAuditLogs(workspaceId) {
        const rows = await prisma.auditLog.findMany({ where: workspaceId ? { workspaceId } : undefined });
        return rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          actorType: r.actorType as 'user' | 'system',
          actorId: r.actorId ?? undefined,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    };

    return repo;
  } catch {
    return createMemoryRepository();
  }
}
