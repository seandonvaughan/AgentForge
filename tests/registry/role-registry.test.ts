import { describe, it, expect, beforeEach } from "vitest";
import { RoleRegistry } from "../../src/registry/role-registry.js";

describe("RoleRegistry", () => {
  let registry: RoleRegistry;

  beforeEach(() => {
    registry = new RoleRegistry();
  });

  // --- assignRole ---

  describe("assignRole", () => {
    it("assigns a new role and returns the entry", () => {
      const entry = registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial setup");
      expect(entry.roleId).toBe("cto");
      expect(entry.roleName).toBe("CTO");
      expect(entry.agentId).toBe("agent-cto");
      expect(entry.active).toBe(true);
      expect(entry.type).toBe("role");
    });

    it("sets supervisorAgentId when provided", () => {
      const entry = registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial", "agent-ceo");
      expect(entry.supervisorAgentId).toBe("agent-ceo");
    });

    it("records creation timestamps", () => {
      const before = Date.now();
      const entry = registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      const after = Date.now();
      const ts = new Date(entry.createdAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("throws if role already exists", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      expect(() =>
        registry.assignRole("cto", "CTO", "agent-cto-2", "ceo", "duplicate")
      ).toThrow(/already exists/);
    });

    it("appends to audit log", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      const log = registry.getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].roleId).toBe("cto");
      expect(log[0].previousAgentId).toBeNull();
      expect(log[0].newAgentId).toBe("agent-cto");
    });
  });

  // --- reassignRole ---

  describe("reassignRole", () => {
    beforeEach(() => {
      registry.assignRole("cto", "CTO", "agent-cto-v1", "ceo", "initial setup");
    });

    it("updates the role holder", () => {
      const entry = registry.reassignRole("cto", "agent-cto-v2", "ceo", "promotion");
      expect(entry.agentId).toBe("agent-cto-v2");
    });

    it("records previousAgentId", () => {
      const entry = registry.reassignRole("cto", "agent-cto-v2", "ceo", "promotion");
      expect(entry.previousAgentId).toBe("agent-cto-v1");
    });

    it("updates the updatedAt timestamp", async () => {
      const before = registry.getRole("cto")!.createdAt;
      await new Promise((r) => setTimeout(r, 5));
      registry.reassignRole("cto", "agent-cto-v2", "ceo", "promotion");
      const after = registry.getRole("cto")!.updatedAt;
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime()
      );
    });

    it("throws if role does not exist", () => {
      expect(() =>
        registry.reassignRole("ghost", "agent-x", "ceo", "unknown")
      ).toThrow(/not found/);
    });

    it("appends reassignment to audit log", () => {
      registry.reassignRole("cto", "agent-cto-v2", "ceo", "promotion");
      const log = registry.getAuditLog();
      expect(log).toHaveLength(2); // initial + reassignment
      expect(log[0].previousAgentId).toBe("agent-cto-v1");
      expect(log[0].newAgentId).toBe("agent-cto-v2");
    });
  });

  // --- deactivateRole ---

  describe("deactivateRole", () => {
    it("marks role as inactive", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      registry.deactivateRole("cto", "ceo", "role eliminated");
      expect(registry.getRole("cto")!.active).toBe(false);
    });

    it("excluded from listActiveRoles after deactivation", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      registry.assignRole("coo", "COO", "agent-coo", "ceo", "initial");
      registry.deactivateRole("cto", "ceo", "role eliminated");
      const active = registry.listActiveRoles();
      expect(active.map((r) => r.roleId)).not.toContain("cto");
      expect(active.map((r) => r.roleId)).toContain("coo");
    });

    it("throws if role does not exist", () => {
      expect(() =>
        registry.deactivateRole("ghost", "ceo", "unknown")
      ).toThrow(/not found/);
    });
  });

  // --- getRole ---

  describe("getRole", () => {
    it("returns the entry for an existing role", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      expect(registry.getRole("cto")).not.toBeNull();
    });

    it("returns null for unknown role", () => {
      expect(registry.getRole("ghost")).toBeNull();
    });
  });

  // --- getRolesByAgent ---

  describe("getRolesByAgent", () => {
    it("returns all active roles held by an agent", () => {
      registry.assignRole("cto", "CTO", "agent-alice", "ceo", "initial");
      registry.assignRole("architect", "Architect", "agent-alice", "cto-agent", "dual role");
      const roles = registry.getRolesByAgent("agent-alice");
      expect(roles.map((r) => r.roleId)).toContain("cto");
      expect(roles.map((r) => r.roleId)).toContain("architect");
    });

    it("excludes inactive roles", () => {
      registry.assignRole("cto", "CTO", "agent-alice", "ceo", "initial");
      registry.deactivateRole("cto", "ceo", "removed");
      expect(registry.getRolesByAgent("agent-alice")).toHaveLength(0);
    });

    it("returns empty for agent with no roles", () => {
      expect(registry.getRolesByAgent("nobody")).toHaveLength(0);
    });
  });

  // --- listRoles / listActiveRoles ---

  describe("listRoles / listActiveRoles", () => {
    it("listRoles returns all roles including inactive", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      registry.assignRole("coo", "COO", "agent-coo", "ceo", "initial");
      registry.deactivateRole("cto", "ceo", "removed");
      expect(registry.listRoles()).toHaveLength(2);
    });

    it("listActiveRoles returns only active roles", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      registry.assignRole("coo", "COO", "agent-coo", "ceo", "initial");
      registry.deactivateRole("cto", "ceo", "removed");
      expect(registry.listActiveRoles()).toHaveLength(1);
    });
  });

  // --- audit log ---

  describe("audit log", () => {
    it("newest-first ordering", () => {
      registry.assignRole("cto", "CTO", "v1", "ceo", "initial");
      registry.reassignRole("cto", "v2", "ceo", "upgrade");
      const log = registry.getAuditLog();
      expect(log[0].newAgentId).toBe("v2");
      expect(log[1].newAgentId).toBe("v1");
    });

    it("getAuditLogForRole filters to specific role", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      registry.assignRole("coo", "COO", "agent-coo", "ceo", "initial");
      registry.reassignRole("cto", "agent-cto-v2", "ceo", "upgrade");
      const ctoLog = registry.getAuditLogForRole("cto");
      expect(ctoLog).toHaveLength(2);
      expect(ctoLog.every((e) => e.roleId === "cto")).toBe(true);
    });

    it("audit entries are immutable (copy returned)", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      const log = registry.getAuditLog();
      log[0].reason = "tampered";
      const fresh = registry.getAuditLog();
      expect(fresh[0].reason).toBe("initial");
    });
  });

  // --- immutability ---

  describe("immutability (snapshot returns)", () => {
    it("mutations to returned entry do not affect registry", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      const entry = registry.getRole("cto")!;
      entry.agentId = "hacked";
      expect(registry.getRole("cto")!.agentId).toBe("agent-cto");
    });
  });

  // --- size ---

  describe("size", () => {
    it("reflects total roles including inactive", () => {
      registry.assignRole("cto", "CTO", "agent-cto", "ceo", "initial");
      registry.assignRole("coo", "COO", "agent-coo", "ceo", "initial");
      registry.deactivateRole("cto", "ceo", "removed");
      expect(registry.size()).toBe(2);
    });
  });
});
