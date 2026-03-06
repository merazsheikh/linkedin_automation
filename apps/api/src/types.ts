export type CapabilityFlags = {
  canPublishPosts: boolean;
  canReadComments: boolean;
  canWriteCommentReplies: boolean;
  canReadPostAnalytics: boolean;
  hasWebhookSupport: boolean;
  requiresManualPublish: boolean;
  requiresManualReply: boolean;
};

export type LinkedInAccount = {
  id: string;
  workspaceId: string;
  linkedinMemberId: string;
  displayName: string;
  connectionStatus: 'ACTIVE' | 'REAUTH_REQUIRED' | 'REVOKED' | 'ERROR';
  scopes: string[];
  capabilities: CapabilityFlags;
  createdAt: string;
};

export type Draft = {
  id: string;
  workspaceId: string;
  authorUserId: string;
  title?: string;
  content: string;
  media?: string[];
  createdAt: string;
};

export type ScheduledPostState =
  | 'PENDING'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'CANCELED';

export type ScheduledPost = {
  id: string;
  workspaceId: string;
  draftId: string;
  linkedInAccountId: string;
  scheduledFor: string;
  policyMode: 'approval' | 'auto';
  idempotencyKey: string;
  state: ScheduledPostState;
  createdAt: string;
};

export type PublishedPost = {
  id: string;
  workspaceId: string;
  scheduledPostId: string;
  linkedinPostUrn: string;
  publishedAt: string;
};

export type Approval = {
  id: string;
  workspaceId: string;
  actionType: 'linkedin.publish_post';
  actionPayload: { scheduledPostId: string };
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedBySystemAt: string;
  decidedByUserId?: string;
  decidedAt?: string;
};

export type AuditLog = {
  id: string;
  workspaceId: string;
  actorType: 'user' | 'system';
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
};
