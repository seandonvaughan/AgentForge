/**
 * tests/v5/rbac.test.ts
 * Tests for AccessControl, roles, and permissions
 * Target: 30+ tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AccessControl } from '../../packages/core/src/rbac/access-control.js';
import { BUILT_IN_ROLES } from '../../packages/core/src/rbac/roles.js';
import type { AccessContext, Permission } from '../../packages/core/src/rbac/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ctx(role: AccessContext['role']): AccessContext {
  return { userId: 'u1', workspaceId: 'ws-1', role };
}

// ── BUILT_IN_ROLES ─────────────────────────────────────────────────────────────

describe('BUILT_IN_ROLES', () => {
  it('owner role exists', () => {
    expect(BUILT_IN_ROLES.owner).toBeDefined();
  });

  it('admin role exists', () => {
    expect(BUILT_IN_ROLES.admin).toBeDefined();
  });

  it('developer role exists', () => {
    expect(BUILT_IN_ROLES.developer).toBeDefined();
  });

  it('viewer role exists', () => {
    expect(BUILT_IN_ROLES.viewer).toBeDefined();
  });

  it('agent role exists', () => {
    expect(BUILT_IN_ROLES.agent).toBeDefined();
  });

  it('owner has workspace:delete permission', () => {
    expect(BUILT_IN_ROLES.owner.permissions).toContain('workspace:delete');
  });

  it('owner has admin:audit permission', () => {
    expect(BUILT_IN_ROLES.owner.permissions).toContain('admin:audit');
  });

  it('admin does not have workspace:delete permission', () => {
    expect(BUILT_IN_ROLES.admin.permissions).not.toContain('workspace:delete');
  });

  it('admin does not have admin:audit permission', () => {
    expect(BUILT_IN_ROLES.admin.permissions).not.toContain('admin:audit');
  });

  it('viewer has only read permissions', () => {
    const viewerPerms = BUILT_IN_ROLES.viewer.permissions;
    for (const perm of viewerPerms) {
      expect(perm).toMatch(/:read$/);
    }
  });

  it('viewer does not have agent:write', () => {
    expect(BUILT_IN_ROLES.viewer.permissions).not.toContain('agent:write');
  });

  it('developer can invoke agents', () => {
    expect(BUILT_IN_ROLES.developer.permissions).toContain('agent:invoke');
  });

  it('developer cannot access admin settings', () => {
    expect(BUILT_IN_ROLES.developer.permissions).not.toContain('admin:settings');
  });

  it('agent role can invoke other agents', () => {
    expect(BUILT_IN_ROLES.agent.permissions).toContain('agent:invoke');
  });

  it('agent role can write sessions', () => {
    expect(BUILT_IN_ROLES.agent.permissions).toContain('session:write');
  });

  it('agent role cannot write plugins', () => {
    expect(BUILT_IN_ROLES.agent.permissions).not.toContain('plugin:write');
  });

  it('all roles have a description', () => {
    for (const role of Object.values(BUILT_IN_ROLES)) {
      expect(typeof role.description).toBe('string');
      expect(role.description.length).toBeGreaterThan(0);
    }
  });
});

// ── AccessControl.can() ───────────────────────────────────────────────────────

describe('AccessControl.can()', () => {
  let ac: AccessControl;

  beforeEach(() => { ac = new AccessControl(); });

  it('owner can do everything — workspace:read', () => {
    expect(ac.can(ctx('owner'), 'workspace:read')).toBe(true);
  });

  it('owner can do everything — admin:audit', () => {
    expect(ac.can(ctx('owner'), 'admin:audit')).toBe(true);
  });

  it('owner can do everything — plugin:stop', () => {
    expect(ac.can(ctx('owner'), 'plugin:stop')).toBe(true);
  });

  it('viewer can read workspace', () => {
    expect(ac.can(ctx('viewer'), 'workspace:read')).toBe(true);
  });

  it('viewer cannot write workspace', () => {
    expect(ac.can(ctx('viewer'), 'workspace:write')).toBe(false);
  });

  it('viewer cannot delete workspace', () => {
    expect(ac.can(ctx('viewer'), 'workspace:delete')).toBe(false);
  });

  it('viewer cannot invoke agents', () => {
    expect(ac.can(ctx('viewer'), 'agent:invoke')).toBe(false);
  });

  it('developer can write agents', () => {
    expect(ac.can(ctx('developer'), 'agent:write')).toBe(true);
  });

  it('developer cannot access admin:users', () => {
    expect(ac.can(ctx('developer'), 'admin:users')).toBe(false);
  });

  it('unknown role returns false', () => {
    const unknownCtx = { userId: 'u1', workspaceId: 'ws-1', role: 'superuser' as AccessContext['role'] };
    expect(ac.can(unknownCtx, 'workspace:read')).toBe(false);
  });
});

// ── AccessControl.assert() ────────────────────────────────────────────────────

describe('AccessControl.assert()', () => {
  let ac: AccessControl;

  beforeEach(() => { ac = new AccessControl(); });

  it('does not throw when permission is granted', () => {
    expect(() => ac.assert(ctx('owner'), 'workspace:write')).not.toThrow();
  });

  it('throws when permission is denied', () => {
    expect(() => ac.assert(ctx('viewer'), 'workspace:write')).toThrow();
  });

  it('error message includes the role name', () => {
    let msg = '';
    try {
      ac.assert(ctx('viewer'), 'workspace:delete');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('viewer');
  });

  it('error message includes the permission name', () => {
    let msg = '';
    try {
      ac.assert(ctx('viewer'), 'workspace:delete');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('workspace:delete');
  });
});

// ── AccessControl.getPermissions() ───────────────────────────────────────────

describe('AccessControl.getPermissions()', () => {
  let ac: AccessControl;

  beforeEach(() => { ac = new AccessControl(); });

  it('returns the owner permissions array', () => {
    const perms = ac.getPermissions('owner');
    expect(perms.length).toBeGreaterThan(10);
  });

  it('returns empty array for unknown role', () => {
    expect(ac.getPermissions('ghost')).toEqual([]);
  });

  it('returns viewer permissions as read-only set', () => {
    const perms = ac.getPermissions('viewer');
    expect(perms.every((p: Permission) => p.endsWith(':read'))).toBe(true);
  });
});

// ── AccessControl.listRoles() ─────────────────────────────────────────────────

describe('AccessControl.listRoles()', () => {
  let ac: AccessControl;

  beforeEach(() => { ac = new AccessControl(); });

  it('returns all built-in roles', () => {
    const roles = ac.listRoles();
    expect(roles.length).toBe(Object.keys(BUILT_IN_ROLES).length);
  });

  it('returned roles each have a name and permissions', () => {
    const roles = ac.listRoles();
    for (const role of roles) {
      expect(typeof role.name).toBe('string');
      expect(Array.isArray(role.permissions)).toBe(true);
    }
  });
});
