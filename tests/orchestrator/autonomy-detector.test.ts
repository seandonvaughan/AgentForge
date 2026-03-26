import { describe, it, expect } from "vitest";
import { detectAutonomy, getClaudeCodeTier } from "../../src/orchestrator/autonomy-detector.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(routing: { opus: string[]; sonnet: string[]; haiku: string[] }): TeamManifest {
  const allAgents = [...routing.opus, ...routing.sonnet, ...routing.haiku];
  return {
    name: "Test",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc",
    agents: {
      strategic: routing.opus,
      implementation: routing.sonnet,
      quality: [],
      utility: routing.haiku,
    },
    model_routing: routing,
    delegation_graph: Object.fromEntries(allAgents.map((a) => [a, []])),
  };
}

describe("detectAutonomy", () => {
  it("should return full when team has Opus strategic agents", () => {
    const manifest = makeManifest({ opus: ["cto", "lead-architect"], sonnet: ["core-lead"], haiku: ["coder-a"] });
    expect(detectAutonomy(manifest)).toBe("full");
  });

  it("should return supervised when team has Sonnet leads but no Opus", () => {
    const manifest = makeManifest({ opus: [], sonnet: ["core-lead", "qa-lead"], haiku: ["coder-a", "coder-b"] });
    expect(detectAutonomy(manifest)).toBe("supervised");
  });

  it("should return guided when team is all Haiku", () => {
    const manifest = makeManifest({ opus: [], sonnet: [], haiku: ["coder-a", "coder-b"] });
    expect(detectAutonomy(manifest)).toBe("guided");
  });

  it("should return full even with just one Opus agent", () => {
    const manifest = makeManifest({ opus: ["cto"], sonnet: [], haiku: ["coder-a"] });
    expect(detectAutonomy(manifest)).toBe("full");
  });
});

describe("getClaudeCodeTier", () => {
  it("should return haiku for full autonomy", () => {
    expect(getClaudeCodeTier("full")).toBe("haiku");
  });

  it("should return sonnet for supervised autonomy", () => {
    expect(getClaudeCodeTier("supervised")).toBe("sonnet");
  });

  it("should return null for guided (no tier change)", () => {
    expect(getClaudeCodeTier("guided")).toBeNull();
  });
});
