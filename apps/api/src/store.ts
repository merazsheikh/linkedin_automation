import type {
  Approval,
  AuditLog,
  Draft,
  LinkedInAccount,
  PublishedPost,
  ScheduledPost,
} from './types.js';

export const store = {
  linkedInAccounts: [] as LinkedInAccount[],
  drafts: [] as Draft[],
  scheduledPosts: [] as ScheduledPost[],
  publishedPosts: [] as PublishedPost[],
  approvals: [] as Approval[],
  auditLogs: [] as AuditLog[],
};

export function writeAuditLog(input: Omit<AuditLog, 'id' | 'createdAt'>): AuditLog {
  const row: AuditLog = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  };
  store.auditLogs.push(row);
  return row;
}
