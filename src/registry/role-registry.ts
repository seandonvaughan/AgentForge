/**
 * Role Registry — Sprint 1.1b
 *
 * Maps organizational roles to agents. Roles are reassignable at runtime,
 * but every assignment is logged to an immutable audit trail.
 *
 * Storage:
 *   Runtime: in-memory Map (fast lookups)
 *   Persistence: /.forge/registry/roles/{roleId}.json (written on mutation)
 *
 * Concurrency: single-writer assumption (Node.js single-threaded). File writes
 * use flock(2) via the persistence layer (future Sprint 1.3 integration).
 */

import type { RoleRegistryEntry } from "../types/v4-api.js";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

export interface RoleAssignmentEvent {
  eventId: string;
  timestamp: string;
  roleId: string;
  previousAgentId: string | null;
  newAgentId: string;
  assignedBy: string;
  reason: string;
}

export class RoleRegistry {
  private roles = new Map<string, RoleRegistryEntry>();
  private auditLog: RoleAssignmentEvent[] = [];
  private eventCounter = 0;

  constructor(private readonly bus?: V4MessageBus) {}

  /**
   * Assign a role to an agent for the first time.
   * Throws if the role already exists — use `reassignRole` to change the holder.
   */
  assignRole(
    roleId: string,
    roleName: string,
    agentId: string,
    assignedBy: string,
    reason: string,
    supervisorAgentId?: string
  ): RoleRegistryEntry {
    if (this.roles.has(roleId)) {
      throw new Error(
        `Role "${roleId}" already exists — use reassignRole() to change the holder`
      );
    }
    const now = new Date().toISOString();
    const entry: RoleRegistryEntry = {
      id: roleId,
      type: "role",
      version: "4.0",
      roleId,
      roleName,
      agentId,
      supervisorAgentId,
      assignedAt: now,
      previousAgentId: undefined,
      assignmentReason: reason,
      createdAt: now,
      updatedAt: now,
      ownerAgentId: assignedBy,
      active: true,
    };
    this.roles.set(roleId, entry);
    this.appendAudit(roleId, null, agentId, assignedBy, reason);
    if (this.bus) {
      this.bus.publish({
        from: "role-registry",
        to: "broadcast",
        topic: "role.assigned",
        category: "status",
        payload: { ...entry },
        priority: "normal",
      });
    }
    return { ...entry };
  }

  /**
   * Reassign an existing role to a different agent.
   * Throws if the role does not exist.
   */
  reassignRole(
    roleId: string,
    newAgentId: string,
    assignedBy: string,
    reason: string
  ): RoleRegistryEntry {
    const existing = this.roles.get(roleId);
    if (!existing) {
      throw new Error(`Role "${roleId}" not found — use assignRole() to create it`);
    }
    const now = new Date().toISOString();
    const updated: RoleRegistryEntry = {
      ...existing,
      agentId: newAgentId,
      previousAgentId: existing.agentId,
      assignedAt: now,
      assignmentReason: reason,
      updatedAt: now,
      ownerAgentId: assignedBy,
    };
    this.roles.set(roleId, updated);
    this.appendAudit(roleId, existing.agentId, newAgentId, assignedBy, reason);
    if (this.bus) {
      this.bus.publish({
        from: "role-registry",
        to: "broadcast",
        topic: "role.reassigned",
        category: "status",
        payload: { ...updated },
        priority: "normal",
      });
    }
    return { ...updated };
  }

  /** Deactivate a role (does not delete — preserves audit history). */
  deactivateRole(roleId: string, deactivatedBy: string, reason: string): void {
    const existing = this.roles.get(roleId);
    if (!existing) {
      throw new Error(`Role "${roleId}" not found`);
    }
    const now = new Date().toISOString();
    this.roles.set(roleId, { ...existing, active: false, updatedAt: now });
    this.appendAudit(roleId, existing.agentId, "(deactivated)", deactivatedBy, reason);
    if (this.bus) {
      this.bus.publish({
        from: "role-registry",
        to: "broadcast",
        topic: "role.deactivated",
        category: "status",
        payload: { roleId, deactivatedBy, reason },
        priority: "normal",
      });
    }
  }

  /** Look up a role by ID. Returns null if not found. */
  getRole(roleId: string): RoleRegistryEntry | null {
    const entry = this.roles.get(roleId);
    return entry ? { ...entry } : null;
  }

  /** Find all active roles held by a given agent. */
  getRolesByAgent(agentId: string): RoleRegistryEntry[] {
    return Array.from(this.roles.values())
      .filter((r) => r.agentId === agentId && r.active)
      .map((r) => ({ ...r }));
  }

  /** All roles (active and inactive). */
  listRoles(): RoleRegistryEntry[] {
    return Array.from(this.roles.values()).map((r) => ({ ...r }));
  }

  /** Only active roles. */
  listActiveRoles(): RoleRegistryEntry[] {
    return Array.from(this.roles.values())
      .filter((r) => r.active)
      .map((r) => ({ ...r }));
  }

  /** Complete immutable audit log, newest first. */
  getAuditLog(): RoleAssignmentEvent[] {
    return this.auditLog.map((e) => ({ ...e })).reverse();
  }

  /** Audit entries for a specific role. */
  getAuditLogForRole(roleId: string): RoleAssignmentEvent[] {
    return this.auditLog
      .filter((e) => e.roleId === roleId)
      .map((e) => ({ ...e }))
      .reverse();
  }

  /** Total number of roles (active + inactive). */
  size(): number {
    return this.roles.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private appendAudit(
    roleId: string,
    previousAgentId: string | null,
    newAgentId: string,
    assignedBy: string,
    reason: string
  ): void {
    this.eventCounter++;
    this.auditLog.push({
      eventId: `role-event-${this.eventCounter}`,
      timestamp: new Date().toISOString(),
      roleId,
      previousAgentId,
      newAgentId,
      assignedBy,
      reason,
    });
  }
}
