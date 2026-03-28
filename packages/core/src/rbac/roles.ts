import type { Role, Permission } from './types.js';

export const BUILT_IN_ROLES: Record<string, Role> = {
  owner: {
    name: 'owner',
    description: 'Full control over workspace',
    permissions: [
      'workspace:read', 'workspace:write', 'workspace:delete',
      'agent:read', 'agent:write', 'agent:invoke',
      'session:read', 'session:write',
      'plugin:read', 'plugin:write', 'plugin:start', 'plugin:stop',
      'admin:users', 'admin:settings', 'admin:audit',
    ],
  },
  admin: {
    name: 'admin',
    description: 'Manage workspace settings and users',
    permissions: [
      'workspace:read', 'workspace:write',
      'agent:read', 'agent:write', 'agent:invoke',
      'session:read', 'session:write',
      'plugin:read', 'plugin:write', 'plugin:start', 'plugin:stop',
      'admin:users', 'admin:settings',
    ],
  },
  developer: {
    name: 'developer',
    description: 'Build and run agents',
    permissions: [
      'workspace:read',
      'agent:read', 'agent:write', 'agent:invoke',
      'session:read', 'session:write',
      'plugin:read', 'plugin:start',
    ],
  },
  viewer: {
    name: 'viewer',
    description: 'Read-only access',
    permissions: [
      'workspace:read', 'agent:read', 'session:read', 'plugin:read',
    ],
  },
  agent: {
    name: 'agent',
    description: 'Machine identity for agent processes',
    permissions: [
      'workspace:read', 'agent:read', 'agent:invoke',
      'session:read', 'session:write',
    ],
  },
};
