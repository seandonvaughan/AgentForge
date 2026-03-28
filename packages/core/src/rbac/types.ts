export type Permission =
  | 'workspace:read' | 'workspace:write' | 'workspace:delete'
  | 'agent:read' | 'agent:write' | 'agent:invoke'
  | 'session:read' | 'session:write'
  | 'plugin:read' | 'plugin:write' | 'plugin:start' | 'plugin:stop'
  | 'admin:users' | 'admin:settings' | 'admin:audit';

export type RoleName = 'owner' | 'admin' | 'developer' | 'viewer' | 'agent';

export interface Role {
  name: RoleName;
  permissions: Permission[];
  description: string;
}

export interface User {
  id: string;
  name: string;
  email?: string;
  role: RoleName;
  workspaceId: string;
  createdAt: string;
  active: boolean;
}

export interface AccessContext {
  userId: string;
  workspaceId: string;
  role: RoleName;
}
