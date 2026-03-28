export type AuditAction =
  | 'agent.invoked' | 'agent.created' | 'agent.updated'
  | 'session.started' | 'session.completed' | 'session.failed'
  | 'plugin.loaded' | 'plugin.started' | 'plugin.stopped'
  | 'workspace.created' | 'workspace.deleted'
  | 'user.created' | 'user.role_changed'
  | 'settings.updated' | 'admin.action';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  actorId: string;        // userId or agentId
  actorType: 'user' | 'agent' | 'system';
  workspaceId: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  ip?: string;
}

export interface AuditQuery {
  workspaceId?: string;
  actorId?: string;
  action?: AuditAction;
  since?: string;   // ISO timestamp
  until?: string;
  limit?: number;
  offset?: number;
}
