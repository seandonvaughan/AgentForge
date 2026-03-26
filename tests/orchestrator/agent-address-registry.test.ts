import { describe, it, expect, beforeEach } from "vitest";
import { AgentAddressRegistry } from "../../src/orchestrator/agent-address-registry.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc123",
    agents: {
      strategic: ["cto", "lead-architect"],
      implementation: ["core-platform-lead", "type-implementer"],
      quality: ["qa-lead"],
      utility: [],
    },
    model_routing: {
      opus: ["cto", "lead-architect"],
      sonnet: ["core-platform-lead", "qa-lead"],
      haiku: ["type-implementer"],
    },
    delegation_graph: {
      cto: ["lead-architect", "core-platform-lead"],
      "lead-architect": ["core-platform-lead"],
      "core-platform-lead": ["type-implementer"],
      "qa-lead": [],
      "type-implementer": [],
    },
    ...overrides,
  };
}

describe("AgentAddressRegistry", () => {
  let registry: AgentAddressRegistry;
  let manifest: TeamManifest;

  beforeEach(() => {
    manifest = makeManifest();
    registry = new AgentAddressRegistry(manifest);
  });

  describe("registration", () => {
    it("should register all agents from manifest", () => {
      expect(registry.hasAgent("cto")).toBe(true);
      expect(registry.hasAgent("lead-architect")).toBe(true);
      expect(registry.hasAgent("core-platform-lead")).toBe(true);
      expect(registry.hasAgent("type-implementer")).toBe(true);
      expect(registry.hasAgent("qa-lead")).toBe(true);
    });

    it("should always have user conduit", () => {
      expect(registry.hasAddress("conduit:user")).toBe(true);
    });

    it("should return false for unknown agents", () => {
      expect(registry.hasAgent("unknown-agent")).toBe(false);
    });

    it("should list all registered agent names", () => {
      const names = registry.getAgentNames();
      expect(names).toHaveLength(5);
      expect(names).toContain("cto");
      expect(names).toContain("type-implementer");
    });
  });

  describe("address resolution", () => {
    it("should resolve agent name to address string", () => {
      expect(registry.resolve("cto")).toBe("agent:cto");
    });

    it("should return null for unknown agent", () => {
      expect(registry.resolve("nonexistent")).toBeNull();
    });
  });

  describe("routing validation", () => {
    it("should allow delegation from parent to child", () => {
      expect(registry.canRoute("cto", "lead-architect")).toBe(true);
      expect(registry.canRoute("cto", "core-platform-lead")).toBe(true);
    });

    it("should reject delegation not in graph", () => {
      expect(registry.canRoute("type-implementer", "cto")).toBe(false);
    });

    it("should always allow routing from user conduit to any agent", () => {
      expect(registry.canRouteFromUser("cto")).toBe(true);
      expect(registry.canRouteFromUser("type-implementer")).toBe(true);
    });

    it("should always allow routing from any agent to user conduit", () => {
      expect(registry.canRouteToUser("cto")).toBe(true);
    });

    it("should allow peer collaboration when agents share a parent", () => {
      expect(registry.canRoute("lead-architect", "core-platform-lead")).toBe(true);
    });
  });

  describe("model tier lookup", () => {
    it("should return correct model tier for agent", () => {
      expect(registry.getModelTier("cto")).toBe("opus");
      expect(registry.getModelTier("core-platform-lead")).toBe("sonnet");
      expect(registry.getModelTier("type-implementer")).toBe("haiku");
    });

    it("should return null for unknown agent", () => {
      expect(registry.getModelTier("nonexistent")).toBeNull();
    });
  });
});