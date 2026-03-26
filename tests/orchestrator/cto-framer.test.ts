import { describe, it, expect } from "vitest";
import { CtoFramer } from "../../src/orchestrator/cto-framer.js";
import { AgentAddressRegistry } from "../../src/orchestrator/agent-address-registry.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(opusAgents: string[]): TeamManifest {
  const sonnet = ["core-lead"];
  const all = [...opusAgents, ...sonnet];
  return {
    name: "Test",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc",
    agents: {
      strategic: opusAgents,
      implementation: sonnet,
      quality: [],
      utility: [],
    },
    model_routing: {
      opus: opusAgents,
      sonnet,
      haiku: [],
    },
    delegation_graph: Object.fromEntries(all.map((a) => [a, []])),
  };
}

describe("CtoFramer", () => {
  describe("getCtoAgent", () => {
    it("should return first Opus agent as CTO", () => {
      const manifest = makeManifest(["cto", "lead-architect"]);
      const registry = new AgentAddressRegistry(manifest);
      const framer = new CtoFramer(registry);
      expect(framer.getCtoAgent()).toBe("cto");
    });

    it("should return null when no Opus agents", () => {
      const manifest = makeManifest([]);
      const registry = new AgentAddressRegistry(manifest);
      const framer = new CtoFramer(registry);
      expect(framer.getCtoAgent()).toBeNull();
    });
  });

  describe("buildFramingPrompt", () => {
    it("should include the user task in the prompt", () => {
      const manifest = makeManifest(["cto"]);
      const registry = new AgentAddressRegistry(manifest);
      const framer = new CtoFramer(registry);
      const prompt = framer.buildFramingPrompt("Build the auth module");
      expect(prompt).toContain("Build the auth module");
    });

    it("should include available agents in the prompt", () => {
      const manifest = makeManifest(["cto"]);
      const registry = new AgentAddressRegistry(manifest);
      const framer = new CtoFramer(registry);
      const prompt = framer.buildFramingPrompt("design the system");
      expect(prompt).toContain("core-lead");
    });

    it("should ask for workstream decomposition", () => {
      const manifest = makeManifest(["cto"]);
      const registry = new AgentAddressRegistry(manifest);
      const framer = new CtoFramer(registry);
      const prompt = framer.buildFramingPrompt("build a platform");
      expect(prompt.toLowerCase()).toMatch(/workstream|decompos|delegate/);
    });
  });
});
