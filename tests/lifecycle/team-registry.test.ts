import { describe, it, expect, beforeEach } from "vitest";
import { TeamRegistry } from "../../src/lifecycle/team-registry.js";
import type { TeamUnit } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<TeamUnit> = {}): TeamUnit {
  return {
    id: "backend-team",
    layer: "backend",
    manager: "manager-001",
    techLead: "lead-001",
    specialists: [],
    maxCapacity: 5,
    currentLoad: 0,
    domain: ["api", "services"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamRegistry", () => {
  let registry: TeamRegistry;

  beforeEach(() => {
    registry = TeamRegistry.createInMemory();
  });

  // -------------------------------------------------------------------------
  // createTeam()
  // -------------------------------------------------------------------------

  describe("createTeam()", () => {
    it("creates a team that can be retrieved with getTeam()", () => {
      const team = makeTeam({ id: "alpha-team" });
      registry.createTeam(team);

      const result = registry.getTeam("alpha-team");
      expect(result).toBeDefined();
      expect(result!.id).toBe("alpha-team");
    });

    it("stores a copy of the team (not the same reference)", () => {
      const team = makeTeam({ id: "copy-team" });
      registry.createTeam(team);

      const result = registry.getTeam("copy-team");
      expect(result).not.toBe(team);
      expect(result!.id).toBe(team.id);
      expect(result!.layer).toBe(team.layer);
    });

    it("throws if team already exists", () => {
      registry.createTeam(makeTeam({ id: "dup-team" }));

      expect(() => registry.createTeam(makeTeam({ id: "dup-team" }))).toThrow(
        'Team "dup-team" already exists',
      );
    });

    it("allows creating multiple distinct teams", () => {
      registry.createTeam(makeTeam({ id: "team-a" }));
      registry.createTeam(makeTeam({ id: "team-b" }));
      registry.createTeam(makeTeam({ id: "team-c" }));

      expect(registry.listTeams()).toHaveLength(3);
    });

    it("stores an independent copy of the specialists array", () => {
      const team = makeTeam({ id: "spec-copy-team", specialists: ["agent-1"] });
      registry.createTeam(team);

      // Mutate original — should not affect stored copy
      team.specialists.push("agent-2");

      const result = registry.getTeam("spec-copy-team")!;
      expect(result.specialists).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // getTeam()
  // -------------------------------------------------------------------------

  describe("getTeam()", () => {
    it("returns the team for a known ID", () => {
      registry.createTeam(makeTeam({ id: "known-team" }));

      const result = registry.getTeam("known-team");
      expect(result).toBeDefined();
    });

    it("returns undefined for a non-existent team", () => {
      expect(registry.getTeam("ghost-team")).toBeUndefined();
    });

    it("returns undefined on empty registry", () => {
      expect(registry.getTeam("any")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // addMember()
  // -------------------------------------------------------------------------

  describe("addMember()", () => {
    it("adds a specialist to the team", () => {
      registry.createTeam(makeTeam({ id: "team-add", maxCapacity: 5 }));
      registry.addMember("team-add", "specialist-001");

      const team = registry.getTeam("team-add")!;
      expect(team.specialists).toContain("specialist-001");
    });

    it("is idempotent — adding the same agent twice does not duplicate", () => {
      registry.createTeam(makeTeam({ id: "team-idem", maxCapacity: 5 }));
      registry.addMember("team-idem", "agent-x");
      registry.addMember("team-idem", "agent-x");

      const team = registry.getTeam("team-idem")!;
      expect(team.specialists.filter((s) => s === "agent-x")).toHaveLength(1);
    });

    it("throws when adding to a non-existent team", () => {
      expect(() => registry.addMember("no-team", "agent-001")).toThrow(
        'Team "no-team" not found',
      );
    });

    it("throws when team is at max capacity", () => {
      registry.createTeam(makeTeam({ id: "full-team", maxCapacity: 2 }));
      registry.addMember("full-team", "a1");
      registry.addMember("full-team", "a2");

      expect(() => registry.addMember("full-team", "a3")).toThrow(
        /max capacity/,
      );
    });

    it("allows filling up to exactly maxCapacity", () => {
      registry.createTeam(makeTeam({ id: "capacity-team", maxCapacity: 3 }));
      registry.addMember("capacity-team", "a1");
      registry.addMember("capacity-team", "a2");
      registry.addMember("capacity-team", "a3");

      const team = registry.getTeam("capacity-team")!;
      expect(team.specialists).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // removeMember()
  // -------------------------------------------------------------------------

  describe("removeMember()", () => {
    it("removes an existing specialist from the team", () => {
      registry.createTeam(makeTeam({ id: "team-rm", maxCapacity: 5 }));
      registry.addMember("team-rm", "agent-remove");
      registry.removeMember("team-rm", "agent-remove");

      const team = registry.getTeam("team-rm")!;
      expect(team.specialists).not.toContain("agent-remove");
    });

    it("is a no-op when the agent is not in the team", () => {
      registry.createTeam(makeTeam({ id: "team-noop", maxCapacity: 5 }));
      registry.addMember("team-noop", "agent-a");

      // Should not throw
      expect(() => registry.removeMember("team-noop", "agent-not-there")).not.toThrow();

      const team = registry.getTeam("team-noop")!;
      expect(team.specialists).toHaveLength(1);
    });

    it("throws when removing from a non-existent team", () => {
      expect(() => registry.removeMember("ghost-team", "agent-001")).toThrow(
        'Team "ghost-team" not found',
      );
    });

    it("removes only the specified agent, leaving others intact", () => {
      registry.createTeam(makeTeam({ id: "team-partial-rm", maxCapacity: 5 }));
      registry.addMember("team-partial-rm", "stay");
      registry.addMember("team-partial-rm", "leave");
      registry.removeMember("team-partial-rm", "leave");

      const team = registry.getTeam("team-partial-rm")!;
      expect(team.specialists).toContain("stay");
      expect(team.specialists).not.toContain("leave");
    });
  });

  // -------------------------------------------------------------------------
  // reassignMember()
  // -------------------------------------------------------------------------

  describe("reassignMember()", () => {
    it("moves a member from one team to another", () => {
      registry.createTeam(makeTeam({ id: "from-team", maxCapacity: 5 }));
      registry.createTeam(makeTeam({ id: "to-team", maxCapacity: 5 }));
      registry.addMember("from-team", "mobile-agent");

      registry.reassignMember("mobile-agent", "from-team", "to-team");

      expect(registry.getTeam("from-team")!.specialists).not.toContain("mobile-agent");
      expect(registry.getTeam("to-team")!.specialists).toContain("mobile-agent");
    });

    it("throws when the destination team does not exist", () => {
      registry.createTeam(makeTeam({ id: "source-team", maxCapacity: 5 }));
      registry.addMember("source-team", "agent-x");

      expect(() =>
        registry.reassignMember("agent-x", "source-team", "nowhere"),
      ).toThrow('Team "nowhere" not found');
    });

    it("throws when the destination team is at capacity", () => {
      registry.createTeam(makeTeam({ id: "origin", maxCapacity: 5 }));
      registry.createTeam(makeTeam({ id: "packed", maxCapacity: 1 }));
      registry.addMember("origin", "traveller");
      registry.addMember("packed", "occupant");

      expect(() => registry.reassignMember("traveller", "origin", "packed")).toThrow(
        /max capacity/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getUtilization()
  // -------------------------------------------------------------------------

  describe("getUtilization()", () => {
    it("returns 0 when currentLoad is 0", () => {
      registry.createTeam(makeTeam({ id: "util-empty", maxCapacity: 10, currentLoad: 0 }));

      expect(registry.getUtilization("util-empty")).toBe(0);
    });

    it("returns 1.0 when fully loaded", () => {
      registry.createTeam(makeTeam({ id: "util-full", maxCapacity: 4, currentLoad: 4 }));

      expect(registry.getUtilization("util-full")).toBe(1.0);
    });

    it("returns the correct ratio for partial load", () => {
      registry.createTeam(makeTeam({ id: "util-half", maxCapacity: 10, currentLoad: 5 }));

      expect(registry.getUtilization("util-half")).toBe(0.5);
    });

    it("returns 0 when maxCapacity is 0", () => {
      registry.createTeam(makeTeam({ id: "util-zero-cap", maxCapacity: 0, currentLoad: 0 }));

      expect(registry.getUtilization("util-zero-cap")).toBe(0);
    });

    it("throws for a non-existent team", () => {
      expect(() => registry.getUtilization("no-team")).toThrow(
        'Team "no-team" not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // listTeams()
  // -------------------------------------------------------------------------

  describe("listTeams()", () => {
    it("returns an empty array when no teams are registered", () => {
      expect(registry.listTeams()).toEqual([]);
    });

    it("returns all registered teams", () => {
      registry.createTeam(makeTeam({ id: "t1" }));
      registry.createTeam(makeTeam({ id: "t2" }));
      registry.createTeam(makeTeam({ id: "t3" }));

      const all = registry.listTeams();
      expect(all).toHaveLength(3);
      const ids = all.map((t) => t.id);
      expect(ids).toContain("t1");
      expect(ids).toContain("t2");
      expect(ids).toContain("t3");
    });
  });

  // -------------------------------------------------------------------------
  // getTeamsByLayer()
  // -------------------------------------------------------------------------

  describe("getTeamsByLayer()", () => {
    beforeEach(() => {
      registry.createTeam(makeTeam({ id: "be-1", layer: "backend" }));
      registry.createTeam(makeTeam({ id: "be-2", layer: "backend" }));
      registry.createTeam(makeTeam({ id: "fe-1", layer: "frontend" }));
      registry.createTeam(makeTeam({ id: "qa-1", layer: "qa" }));
    });

    it("returns only teams in the specified layer", () => {
      const result = registry.getTeamsByLayer("backend");
      expect(result).toHaveLength(2);
      expect(result.every((t) => t.layer === "backend")).toBe(true);
    });

    it("returns empty array when no teams exist in the layer", () => {
      const result = registry.getTeamsByLayer("data");
      expect(result).toEqual([]);
    });

    it("returns a single team correctly", () => {
      const result = registry.getTeamsByLayer("qa");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("qa-1");
    });

    it("returns frontend layer teams correctly", () => {
      const result = registry.getTeamsByLayer("frontend");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("fe-1");
    });
  });
});
