/**
 * Tests for the forgeTeam() strategy-selection logic.
 *
 * Verifies that the correct pipeline (legacy vs agent-driven) is invoked
 * based on opts.strategy, opts.runtime presence, and the
 * AGENTFORGE_FORGE_STRATEGY environment variable.
 *
 * All heavy side-effects (runFullScan, forgeTeamAgentDriven, buildSourceCorpus,
 * writeTeam, loadAllDomains, …) are mocked at the module level so tests are
 * fast and isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted BEFORE any import of the module under test
// ---------------------------------------------------------------------------

vi.mock("../agent-driven-forge.js", () => ({
  forgeTeamAgentDriven: vi.fn(),
}));

vi.mock("../source-corpus.js", () => ({
  buildSourceCorpus: vi.fn(),
}));

// Mock the legacy pipeline dependencies so they don't hit the filesystem
vi.mock("../../scanner/index.js", () => ({
  runFullScan: vi.fn(),
}));

vi.mock("../../domains/index.js", () => ({
  loadAllDomains: vi.fn(),
  getDefaultDomainsDir: vi.fn().mockReturnValue("/mock/domains"),
}));

vi.mock("../../domains/domain-activator.js", () => ({
  activateDomains: vi.fn().mockReturnValue([]),
}));

vi.mock("../template-loader.js", () => ({
  loadAllTemplates: vi.fn(),
  getDefaultTemplatesDir: vi.fn().mockReturnValue("/mock/templates"),
  loadDomainTemplates: vi.fn(),
}));

vi.mock("../team-composer.js", () => ({
  composeTeam: vi.fn(),
  composeTeamFromDomains: vi.fn(),
}));

vi.mock("../template-customizer.js", () => ({
  customizeTemplate: vi.fn(),
}));

vi.mock("../team-writer.js", () => ({
  writeTeam: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { forgeTeam } from "../index.js";
import type { ForgeTeamOptions } from "../index.js";
import { forgeTeamAgentDriven } from "../agent-driven-forge.js";
import { buildSourceCorpus } from "../source-corpus.js";
import { runFullScan } from "../../scanner/index.js";
import { loadAllDomains } from "../../domains/index.js";
import { loadAllTemplates } from "../template-loader.js";
import { composeTeam } from "../team-composer.js";
import { writeTeam } from "../team-writer.js";
import type { AgentRuntime } from "../../../../agent-runtime/agent-runtime.js";
import type { AgentDrivenForgeResult } from "../agent-driven-forge.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_TEAM_PLAN = {
  team_name: "test-team",
  agents: [
    {
      id: "architect",
      tier: "opus" as const,
      category: "strategic" as const,
      owns_subsystems: ["packages/core/src"],
      capability_tags: ["architecture"],
      system_prompt: "You are the architect.",
      auto_include_files: [],
      learnings_seed: [],
    },
    {
      id: "coder",
      tier: "sonnet" as const,
      category: "implementation" as const,
      owns_subsystems: ["packages/core/src"],
      capability_tags: ["typescript"],
      system_prompt: "You are the coder.",
      auto_include_files: [],
      learnings_seed: [],
    },
  ],
};

const MOCK_AGENT_DRIVEN_RESULT: AgentDrivenForgeResult = {
  teamPlan: MOCK_TEAM_PLAN,
  validation: {
    valid: true,
    agentsChecked: 2,
    findings: [],
    generatedAt: new Date().toISOString(),
  },
  routingIndexPath: "/tmp/routing-index.json",
};

const MOCK_SCAN_RESULT = {
  projectRoot: "/tmp/test-project",
  files: [],
  gitHistory: [],
  dependencies: [],
  ciConfig: null,
};

const MOCK_CORPUS_RESULT = {
  files: [{ path: "packages/core/src/index.ts", content: "// index", truncated: false }],
  totalChars: 9,
  subsystemsSampled: ["packages/core"],
  skipped: 0,
};

/** Build a minimal mock AgentRuntime. */
function makeMockRuntime(): AgentRuntime {
  return {
    run: vi.fn().mockResolvedValue({
      sessionId: "mock-session",
      response: "",
      model: "claude-opus-4-7",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "completed",
    }),
  } as unknown as AgentRuntime;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "forge-strategy-test-"));
  mkdirSync(join(projectRoot, ".agentforge"), { recursive: true });

  // Reset all mocks and set up default return values
  vi.clearAllMocks();

  vi.mocked(forgeTeamAgentDriven).mockResolvedValue(MOCK_AGENT_DRIVEN_RESULT);
  vi.mocked(buildSourceCorpus).mockResolvedValue(MOCK_CORPUS_RESULT);
  vi.mocked(runFullScan).mockResolvedValue(MOCK_SCAN_RESULT as never);
  vi.mocked(loadAllDomains).mockResolvedValue(new Map());
  vi.mocked(loadAllTemplates).mockResolvedValue(new Map());
  vi.mocked(composeTeam).mockReturnValue({
    agents: [],
    custom_agents: [],
    model_assignments: {},
  });
  vi.mocked(writeTeam).mockResolvedValue(undefined);

  // Ensure env var is clean before each test
  delete process.env["AGENTFORGE_FORGE_STRATEGY"];
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  delete process.env["AGENTFORGE_FORGE_STRATEGY"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("forgeTeam strategy selection", () => {
  describe("legacy path (default)", () => {
    it("calls the legacy pipeline when no opts are provided", async () => {
      await forgeTeam(projectRoot);

      expect(runFullScan).toHaveBeenCalledWith(projectRoot);
      expect(forgeTeamAgentDriven).not.toHaveBeenCalled();
    });

    it("calls the legacy pipeline when opts.strategy is explicitly 'legacy'", async () => {
      await forgeTeam(projectRoot, { strategy: "legacy" });

      expect(runFullScan).toHaveBeenCalledWith(projectRoot);
      expect(forgeTeamAgentDriven).not.toHaveBeenCalled();
    });

    it("calls the legacy pipeline when strategy is 'legacy' even if runtime is present", async () => {
      const runtime = makeMockRuntime();
      await forgeTeam(projectRoot, { strategy: "legacy", runtime });

      expect(runFullScan).toHaveBeenCalledWith(projectRoot);
      expect(forgeTeamAgentDriven).not.toHaveBeenCalled();
    });
  });

  describe("agent-driven path via opts.strategy", () => {
    it("calls forgeTeamAgentDriven when opts.strategy is 'agent-driven'", async () => {
      const runtime = makeMockRuntime();
      const result = await forgeTeam(projectRoot, { strategy: "agent-driven", runtime });

      expect(forgeTeamAgentDriven).toHaveBeenCalledOnce();
      expect(forgeTeamAgentDriven).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot, runtime }),
      );
      expect(runFullScan).not.toHaveBeenCalled();
      // Result should be a valid TeamManifest
      expect(result.name).toBe("test-team");
      expect(result.forged_by).toBe("agentforge-synthesis");
    });

    it("builds sourceCorpus automatically when agent-driven and no corpus provided", async () => {
      const runtime = makeMockRuntime();
      await forgeTeam(projectRoot, { strategy: "agent-driven", runtime });

      expect(buildSourceCorpus).toHaveBeenCalledWith({ projectRoot });
      // The auto-built corpus files should have been forwarded to the agent-driven forge
      expect(forgeTeamAgentDriven).toHaveBeenCalledWith(
        expect.objectContaining({ sourceCorpus: MOCK_CORPUS_RESULT.files }),
      );
    });

    it("passes caller-supplied sourceCorpus without rebuilding it", async () => {
      const runtime = makeMockRuntime();
      const corpus = [{ path: "custom/file.ts", content: "// custom", truncated: false }];
      await forgeTeam(projectRoot, { strategy: "agent-driven", runtime, sourceCorpus: corpus });

      expect(buildSourceCorpus).not.toHaveBeenCalled();
      expect(forgeTeamAgentDriven).toHaveBeenCalledWith(
        expect.objectContaining({ sourceCorpus: corpus }),
      );
    });
  });

  describe("agent-driven path via opts.runtime presence", () => {
    it("uses agent-driven pipeline when runtime is provided (no explicit strategy)", async () => {
      const runtime = makeMockRuntime();
      const result = await forgeTeam(projectRoot, { runtime });

      expect(forgeTeamAgentDriven).toHaveBeenCalledOnce();
      expect(runFullScan).not.toHaveBeenCalled();
      expect(result.name).toBe("test-team");
    });
  });

  describe("agent-driven path via environment variable", () => {
    it("uses agent-driven pipeline when AGENTFORGE_FORGE_STRATEGY=agent-driven", async () => {
      process.env["AGENTFORGE_FORGE_STRATEGY"] = "agent-driven";
      const runtime = makeMockRuntime();
      const result = await forgeTeam(projectRoot, { runtime });

      expect(forgeTeamAgentDriven).toHaveBeenCalledOnce();
      expect(runFullScan).not.toHaveBeenCalled();
      expect(result.forged_by).toBe("agentforge-synthesis");
    });

    it("uses legacy pipeline when AGENTFORGE_FORGE_STRATEGY=legacy (no opts)", async () => {
      process.env["AGENTFORGE_FORGE_STRATEGY"] = "legacy";
      await forgeTeam(projectRoot);

      expect(runFullScan).toHaveBeenCalledWith(projectRoot);
      expect(forgeTeamAgentDriven).not.toHaveBeenCalled();
    });

    it("opts.strategy='legacy' overrides AGENTFORGE_FORGE_STRATEGY=agent-driven", async () => {
      process.env["AGENTFORGE_FORGE_STRATEGY"] = "agent-driven";
      await forgeTeam(projectRoot, { strategy: "legacy" });

      expect(runFullScan).toHaveBeenCalledWith(projectRoot);
      expect(forgeTeamAgentDriven).not.toHaveBeenCalled();
    });
  });

  describe("TeamManifest reshaping from agent-driven result", () => {
    it("returns a TeamManifest with correct category buckets from teamPlan", async () => {
      const runtime = makeMockRuntime();
      const result = await forgeTeam(projectRoot, { strategy: "agent-driven", runtime });

      // Agents are categorised by their 'category' field from the plan
      expect(result.agents.strategic).toContain("architect");
      expect(result.agents.implementation).toContain("coder");
      expect(result.agents.quality).toEqual([]);
      expect(result.agents.utility).toEqual([]);
    });

    it("returns a TeamManifest with correct model_routing from teamPlan", async () => {
      const runtime = makeMockRuntime();
      const result = await forgeTeam(projectRoot, { strategy: "agent-driven", runtime });

      expect(result.model_routing.opus).toContain("architect");
      expect(result.model_routing.sonnet).toContain("coder");
      expect(result.model_routing.haiku).toEqual([]);
    });

    it("strategic agents delegate to implementation agents in delegation_graph", async () => {
      const runtime = makeMockRuntime();
      const result = await forgeTeam(projectRoot, { strategy: "agent-driven", runtime });

      expect(result.delegation_graph["architect"]).toContain("coder");
    });
  });
});
