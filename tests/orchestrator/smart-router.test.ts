import { describe, it, expect, beforeEach } from "vitest";
import { SmartRouter } from "../../src/orchestrator/smart-router.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(): TeamManifest {
  return {
    name: "Test",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc",
    agents: {
      strategic: ["cto"],
      implementation: ["core-lead", "frontend-lead"],
      quality: [],
      utility: [],
    },
    model_routing: {
      opus: ["cto"],
      sonnet: ["core-lead", "frontend-lead"],
      haiku: [],
    },
    delegation_graph: {
      cto: ["core-lead", "frontend-lead"],
      "core-lead": [],
      "frontend-lead": [],
    },
  };
}

describe("SmartRouter", () => {
  let router: SmartRouter;

  beforeEach(() => {
    router = new SmartRouter(makeManifest());
  });

  describe("parseDirectMessage", () => {
    it("should parse @agent-name prefix", () => {
      const result = router.parseDirectMessage("@core-lead review this PR");
      expect(result).not.toBeNull();
      expect(result!.agentName).toBe("core-lead");
      expect(result!.content).toBe("review this PR");
    });

    it("should return null for non-direct messages", () => {
      expect(router.parseDirectMessage("build the auth module")).toBeNull();
    });

    it("should return null for unknown agents", () => {
      expect(router.parseDirectMessage("@unknown do something")).toBeNull();
    });

    it("should trim content after agent name", () => {
      const result = router.parseDirectMessage("@cto  what is the plan?");
      expect(result!.content).toBe("what is the plan?");
    });
  });

  describe("routeTask", () => {
    it("should route architecture tasks to first Opus agent", () => {
      const target = router.routeTask("design the system architecture");
      expect(target).toBe("cto");
    });

    it("should route strategy tasks to first Opus agent", () => {
      const target = router.routeTask("define the product strategy");
      expect(target).toBe("cto");
    });

    it("should route implementation tasks to first Sonnet agent", () => {
      const target = router.routeTask("implement the login feature");
      expect(target).toBe("core-lead");
    });

    it("should route build tasks to first Sonnet agent", () => {
      const target = router.routeTask("build the API endpoint");
      expect(target).toBe("core-lead");
    });

    it("should default to CTO (first Opus) when no keyword matches", () => {
      const target = router.routeTask("do something cool");
      expect(target).toBe("cto");
    });

    it("should default to first Sonnet if no Opus available", () => {
      const manifest = makeManifest();
      manifest.model_routing.opus = [];
      manifest.agents.strategic = [];
      const r = new SmartRouter(manifest);
      const target = r.routeTask("define strategy");
      expect(target).toBe("core-lead");
    });

    it("should return null when no agents available", () => {
      const manifest = makeManifest();
      manifest.model_routing.opus = [];
      manifest.model_routing.sonnet = [];
      manifest.agents.strategic = [];
      manifest.agents.implementation = [];
      const r = new SmartRouter(manifest);
      expect(r.routeTask("do something")).toBeNull();
    });
  });

  describe("isFirstTask", () => {
    it("should return true before any routing", () => {
      expect(router.isFirstTask()).toBe(true);
    });

    it("should return false after routeTask is called", () => {
      router.routeTask("do something");
      expect(router.isFirstTask()).toBe(false);
    });

    it("should return false after parseDirectMessage returns a result", () => {
      router.parseDirectMessage("@cto hello");
      expect(router.isFirstTask()).toBe(false);
    });
  });
});
