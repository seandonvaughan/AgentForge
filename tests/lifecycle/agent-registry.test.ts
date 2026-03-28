import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry } from "../../src/lifecycle/agent-registry.js";
import type { AgentIdentity } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: "agent-001",
    name: "Senior Coder",
    role: "specialist",
    seniority: "senior",
    layer: "backend",
    teamId: "backend-team",
    model: "sonnet",
    status: "idle",
    hiredAt: new Date().toISOString(),
    currentTasks: [],
    maxConcurrentTasks: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = AgentRegistry.createInMemory();
  });

  // -------------------------------------------------------------------------
  // register()
  // -------------------------------------------------------------------------

  describe("register()", () => {
    it("registers an agent that can be retrieved with get()", () => {
      const agent = makeAgent({ id: "agent-001" });
      registry.register(agent);

      const result = registry.get("agent-001");
      expect(result).toBeDefined();
      expect(result!.id).toBe("agent-001");
      expect(result!.name).toBe("Senior Coder");
    });

    it("stores a copy of the identity (not the same reference)", () => {
      const agent = makeAgent({ id: "agent-001" });
      registry.register(agent);

      const result = registry.get("agent-001");
      expect(result).not.toBe(agent);
      expect(result).toEqual(agent);
    });

    it("throws if agent already exists", () => {
      const agent = makeAgent({ id: "agent-dup" });
      registry.register(agent);

      expect(() => registry.register(agent)).toThrow('Agent "agent-dup" is already registered');
    });

    it("throws with correct message for duplicate registration", () => {
      registry.register(makeAgent({ id: "my-agent" }));

      expect(() => registry.register(makeAgent({ id: "my-agent" }))).toThrow(
        /already registered/,
      );
    });

    it("allows registering multiple distinct agents", () => {
      registry.register(makeAgent({ id: "agent-a" }));
      registry.register(makeAgent({ id: "agent-b" }));
      registry.register(makeAgent({ id: "agent-c" }));

      expect(registry.list()).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // get()
  // -------------------------------------------------------------------------

  describe("get()", () => {
    it("returns the agent for a known ID", () => {
      const agent = makeAgent({ id: "known-agent" });
      registry.register(agent);

      const result = registry.get("known-agent");
      expect(result).toBeDefined();
      expect(result!.id).toBe("known-agent");
    });

    it("returns undefined for a non-existent agent", () => {
      const result = registry.get("does-not-exist");
      expect(result).toBeUndefined();
    });

    it("returns undefined on an empty registry", () => {
      expect(registry.get("anything")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // update()
  // -------------------------------------------------------------------------

  describe("update()", () => {
    it("updates partial fields on an existing agent", () => {
      registry.register(makeAgent({ id: "agent-upd", status: "idle" }));

      const updated = registry.update("agent-upd", { status: "active" });

      expect(updated.status).toBe("active");
      expect(registry.get("agent-upd")!.status).toBe("active");
    });

    it("preserves unmodified fields when doing a partial update", () => {
      registry.register(
        makeAgent({ id: "agent-partial", name: "Original Name", teamId: "team-x" }),
      );

      registry.update("agent-partial", { status: "multitasking" });

      const result = registry.get("agent-partial")!;
      expect(result.name).toBe("Original Name");
      expect(result.teamId).toBe("team-x");
      expect(result.status).toBe("multitasking");
    });

    it("returns the updated identity object", () => {
      registry.register(makeAgent({ id: "agent-ret" }));

      const returned = registry.update("agent-ret", { seniority: "lead" });

      expect(returned.seniority).toBe("lead");
    });

    it("can update multiple fields in one call", () => {
      registry.register(makeAgent({ id: "agent-multi" }));

      registry.update("agent-multi", {
        teamId: "new-team",
        role: "manager",
        seniority: "lead",
      });

      const result = registry.get("agent-multi")!;
      expect(result.teamId).toBe("new-team");
      expect(result.role).toBe("manager");
      expect(result.seniority).toBe("lead");
    });

    it("throws for a non-existent agent", () => {
      expect(() => registry.update("ghost", { status: "active" })).toThrow(
        'Agent "ghost" not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // terminate()
  // -------------------------------------------------------------------------

  describe("terminate()", () => {
    it("sets status to 'terminated'", () => {
      registry.register(makeAgent({ id: "agent-term", status: "active" }));
      registry.terminate("agent-term");

      expect(registry.get("agent-term")!.status).toBe("terminated");
    });

    it("accepts an optional reason without throwing", () => {
      registry.register(makeAgent({ id: "agent-reason" }));

      expect(() => registry.terminate("agent-reason", "performance issues")).not.toThrow();
      expect(registry.get("agent-reason")!.status).toBe("terminated");
    });

    it("throws for a non-existent agent", () => {
      expect(() => registry.terminate("no-such-agent")).toThrow(
        'Agent "no-such-agent" not found',
      );
    });

    it("preserves all other fields after termination", () => {
      const agent = makeAgent({ id: "agent-preserve", name: "Preserve Me", teamId: "team-y" });
      registry.register(agent);
      registry.terminate("agent-preserve");

      const result = registry.get("agent-preserve")!;
      expect(result.name).toBe("Preserve Me");
      expect(result.teamId).toBe("team-y");
      expect(result.status).toBe("terminated");
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe("list()", () => {
    it("returns an empty array when no agents are registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns all registered agents", () => {
      registry.register(makeAgent({ id: "a1" }));
      registry.register(makeAgent({ id: "a2" }));
      registry.register(makeAgent({ id: "a3" }));

      const all = registry.list();
      expect(all).toHaveLength(3);
      const ids = all.map((a) => a.id);
      expect(ids).toContain("a1");
      expect(ids).toContain("a2");
      expect(ids).toContain("a3");
    });

    it("reflects terminated agents in the list", () => {
      registry.register(makeAgent({ id: "term-agent" }));
      registry.terminate("term-agent");

      const all = registry.list();
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("terminated");
    });
  });

  // -------------------------------------------------------------------------
  // listByTeam()
  // -------------------------------------------------------------------------

  describe("listByTeam()", () => {
    beforeEach(() => {
      registry.register(makeAgent({ id: "b1", teamId: "backend-team" }));
      registry.register(makeAgent({ id: "b2", teamId: "backend-team" }));
      registry.register(makeAgent({ id: "f1", teamId: "frontend-team" }));
    });

    it("returns only agents belonging to the specified team", () => {
      const result = registry.listByTeam("backend-team");
      expect(result).toHaveLength(2);
      expect(result.every((a) => a.teamId === "backend-team")).toBe(true);
    });

    it("returns empty array when no agents belong to the team", () => {
      const result = registry.listByTeam("nonexistent-team");
      expect(result).toEqual([]);
    });

    it("returns the correct members when multiple teams exist", () => {
      const frontendAgents = registry.listByTeam("frontend-team");
      expect(frontendAgents).toHaveLength(1);
      expect(frontendAgents[0].id).toBe("f1");
    });
  });

  // -------------------------------------------------------------------------
  // listByLayer()
  // -------------------------------------------------------------------------

  describe("listByLayer()", () => {
    beforeEach(() => {
      registry.register(makeAgent({ id: "be1", layer: "backend" }));
      registry.register(makeAgent({ id: "be2", layer: "backend" }));
      registry.register(makeAgent({ id: "fe1", layer: "frontend" }));
    });

    it("returns only agents in the specified layer", () => {
      const result = registry.listByLayer("backend");
      expect(result).toHaveLength(2);
      expect(result.every((a) => a.layer === "backend")).toBe(true);
    });

    it("returns empty array when no agents exist in the layer", () => {
      const result = registry.listByLayer("data");
      expect(result).toEqual([]);
    });

    it("filters correctly between layers", () => {
      const frontendAgents = registry.listByLayer("frontend");
      expect(frontendAgents).toHaveLength(1);
      expect(frontendAgents[0].id).toBe("fe1");
    });
  });

  // -------------------------------------------------------------------------
  // listByStatus()
  // -------------------------------------------------------------------------

  describe("listByStatus()", () => {
    beforeEach(() => {
      registry.register(makeAgent({ id: "active1", status: "active" }));
      registry.register(makeAgent({ id: "active2", status: "active" }));
      registry.register(makeAgent({ id: "idle1", status: "idle" }));
      registry.register(makeAgent({ id: "term1" }));
      registry.terminate("term1");
    });

    it("returns only agents with the specified status", () => {
      const active = registry.listByStatus("active");
      expect(active).toHaveLength(2);
      expect(active.every((a) => a.status === "active")).toBe(true);
    });

    it("returns terminated agents when filtering by 'terminated'", () => {
      const terminated = registry.listByStatus("terminated");
      expect(terminated).toHaveLength(1);
      expect(terminated[0].id).toBe("term1");
    });

    it("returns empty array when no agents have the given status", () => {
      const suspended = registry.listByStatus("suspended");
      expect(suspended).toEqual([]);
    });

    it("returns idle agents correctly", () => {
      const idle = registry.listByStatus("idle");
      expect(idle).toHaveLength(1);
      expect(idle[0].id).toBe("idle1");
    });
  });
});
