import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { TeamModeSession } from "../../src/orchestrator/team-mode-session.js";
import type { TeamModeConfig, TeamSessionConfig } from "../../src/types/team-mode.js";
import type { TeamManifest } from "../../src/types/team.js";
import type { AgentTemplate } from "../../src/types/agent.js";

vi.mock("../../src/api/client.js", () => ({
  MODEL_MAP: {
    opus: "claude-opus-4-20250514",
    sonnet: "claude-sonnet-4-20250514",
    haiku: "claude-haiku-4-5-20251001",
  },
  MODEL_DEFAULTS: {
    opus: { maxTokens: 4096, temperature: 0.7 },
    sonnet: { maxTokens: 4096, temperature: 0.5 },
    haiku: { maxTokens: 2048, temperature: 0.3 },
  },
  MODEL_EFFORT_DEFAULTS: { opus: "high", sonnet: "medium", haiku: "low" },
  sendMessage: vi.fn().mockReturnValue({
    content: "Mock response",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    modelUsed: "claude-haiku-4-5-20251001",
  }),
}));

function makeManifest(): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc123",
    agents: {
      strategic: ["cto"],
      implementation: ["core-lead", "coder-a"],
      quality: [],
      utility: [],
    },
    model_routing: {
      opus: ["cto"],
      sonnet: ["core-lead"],
      haiku: ["coder-a"],
    },
    delegation_graph: {
      cto: ["core-lead"],
      "core-lead": ["coder-a"],
      "coder-a": [],
    },
  };
}

function makeAgent(name: string, model: "opus" | "sonnet" | "haiku" = "haiku"): AgentTemplate {
  return {
    name,
    model,
    version: "1.0.0",
    description: `${name} agent`,
    system_prompt: `You are ${name}`,
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: { reports_to: null, reviews_from: [], can_delegate_to: [], parallel: false },
    context: { max_files: 10, auto_include: [], project_specific: [] },
  };
}

describe("TeamModeSession", () => {
  let tmpDir: string;
  let config: TeamModeConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "team-mode-test-"));
    const manifest = makeManifest();
    const templates = new Map<string, AgentTemplate>();
    templates.set("cto", makeAgent("cto", "opus"));
    templates.set("core-lead", makeAgent("core-lead", "sonnet"));
    templates.set("coder-a", makeAgent("coder-a", "haiku"));

    const sessionConfig: TeamSessionConfig = {
      projectRoot: tmpDir,
      sessionBudgetUsd: 10.0,
      enableReforge: false,
      enableCostAwareRouting: true,
      enableReviewEnforcement: false,
    };

    config = {
      sessionConfig,
      teamManifest: manifest,
      agentTemplates: templates,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("activation", () => {
    it("should start inactive", () => {
      const session = new TeamModeSession(config);
      expect(session.getState()).toBe("inactive");
    });

    it("should activate and transition to active", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      expect(session.getState()).toBe("active");
    });

    it("should throw if already active", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      await expect(session.activate()).rejects.toThrow();
    });

    it("should have a session ID after activation", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      expect(session.getSessionId()).toBeDefined();
    });
  });

  describe("deactivation", () => {
    it("should deactivate and transition to inactive", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      await session.deactivate();
      expect(session.getState()).toBe("inactive");
    });

    it("should throw if not active", async () => {
      const session = new TeamModeSession(config);
      await expect(session.deactivate()).rejects.toThrow();
    });
  });

  describe("task submission", () => {
    it("should accept a task when active", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      const msg = session.submitTask("Build the auth module");
      expect(msg.type).toBe("task");
      expect(msg.from).toBe("conduit:user");
    });

    it("should reject task when not active", () => {
      const session = new TeamModeSession(config);
      expect(() => session.submitTask("test")).toThrow();
    });
  });

  describe("direct message", () => {
    it("should send direct message to named agent", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      const msg = session.sendDirect("cto", "What's the plan?");
      expect(msg.type).toBe("direct");
      expect(msg.to).toBe("agent:cto");
    });

    it("should reject direct message to unknown agent", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      expect(() => session.sendDirect("nonexistent", "hello")).toThrow();
    });
  });

  describe("feed", () => {
    it("should accumulate feed entries from messages", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      session.submitTask("Task 1");
      session.submitTask("Task 2");

      const entries = session.getFeedEntries();
      expect(entries).toHaveLength(2);
    });
  });

  describe("agent registry", () => {
    it("should expose registered agent names", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      const names = session.getAgentNames();
      expect(names).toContain("cto");
      expect(names).toContain("core-lead");
      expect(names).toContain("coder-a");
    });
  });
});
