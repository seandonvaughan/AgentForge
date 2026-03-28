import { BUILT_IN_ROLES } from './roles.js';
import type { Permission, AccessContext } from './types.js';

export class AccessControl {
  /** Check if a context has a specific permission. */
  can(ctx: AccessContext, permission: Permission): boolean {
    const role = BUILT_IN_ROLES[ctx.role];
    if (!role) return false;
    return role.permissions.includes(permission);
  }

  /** Throw if the context lacks permission. */
  assert(ctx: AccessContext, permission: Permission): void {
    if (!this.can(ctx, permission)) {
      throw new Error(`Access denied: ${ctx.role} lacks '${permission}' permission`);
    }
  }

  /** Get all permissions for a role. */
  getPermissions(roleName: string): Permission[] {
    return BUILT_IN_ROLES[roleName]?.permissions ?? [];
  }

  /** List all built-in roles. */
  listRoles() {
    return Object.values(BUILT_IN_ROLES);
  }
}
