export type DomainEvent<TPayload = Record<string, unknown>> = {
  id: string;
  workspaceId: string;
  type: string;
  occurredAt: string;
  source: string;
  payload: TPayload;
};
