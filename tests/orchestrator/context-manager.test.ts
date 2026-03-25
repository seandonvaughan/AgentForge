import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextManager } from "../../src/orchestrator/context-manager.js";
import type { AgentTemplate } from "../../src/types/agent.js";

/**
 * Helper to build a minimal AgentTemplate for testing.
 * Only context-relevant fields are set; the rest use safe defaults.
 */
function makeAgent(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    name: "test-agent",
    model: "sonnet",
    version: "1.0.0",
    description: "A test agent",
    system_prompt: "You are a test agent.",
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: null,
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: {
      max_files: 10,
      auto_include: [],
      project_specific: [],
    },
    ...overrides,
  };
}

describe("context-manager", () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = new ContextManager();
  });

  // ---------------------------------------------------------------
  // assembleTaskContext
  // ---------------------------------------------------------------
  describe("assembleTaskContext", () => {
    it("builds scoped context string containing the task description", () => {
      const agent = makeAgent();
      const ctx = cm.assembleTaskContext(agent, "Implement the login page");

      expect(ctx).toContain("Implement the login page");
    });

    it("includes auto_include file contents (mocked via fileReader)", () => {
      const agent = makeAgent({
        context: {
          max_files: 10,
          auto_include: ["src/config.ts", "src/types.ts"],
          project_specific: [],
        },
      });

      // Supply a mock file reader so we don't touch the real filesystem
      const mockReader = vi.fn((path: string) => `// contents of ${path}`);
      cm.setFileReader(mockReader);

      const ctx = cm.assembleTaskContext(agent, "Do something");

      expect(mockReader).toHaveBeenCalledWith("src/config.ts");
      expect(mockReader).toHaveBeenCalledWith("src/types.ts");
      expect(ctx).toContain("// contents of src/config.ts");
      expect(ctx).toContain("// contents of src/types.ts");
    });

    it("respects max_files limit on auto_include", () => {
      const agent = makeAgent({
        context: {
          max_files: 2,
          auto_include: ["a.ts", "b.ts", "c.ts", "d.ts"],
          project_specific: [],
        },
      });

      const mockReader = vi.fn((path: string) => `// ${path}`);
      cm.setFileReader(mockReader);

      const ctx = cm.assembleTaskContext(agent, "task");

      // Only the first 2 files should be loaded
      expect(mockReader).toHaveBeenCalledTimes(2);
      expect(ctx).toContain("// a.ts");
      expect(ctx).toContain("// b.ts");
      expect(ctx).not.toContain("// c.ts");
      expect(ctx).not.toContain("// d.ts");
    });

    it("includes relevant team decisions in the context", () => {
      cm.saveDecision("architect", "Use PostgreSQL", "Best fit for relational data");
      cm.saveDecision("cmo", "Brand color is blue", "Corporate identity");

      const agent = makeAgent();
      const ctx = cm.assembleTaskContext(agent, "Build the database layer");

      expect(ctx).toContain("Use PostgreSQL");
      expect(ctx).toContain("Best fit for relational data");
      expect(ctx).toContain("Brand color is blue");
    });

    it("includes additional files passed via options", () => {
      const agent = makeAgent({
        context: { max_files: 5, auto_include: [], project_specific: [] },
      });

      const mockReader = vi.fn((path: string) => `content:${path}`);
      cm.setFileReader(mockReader);

      const ctx = cm.assembleTaskContext(agent, "task", {
        files: ["extra.ts"],
      });

      expect(mockReader).toHaveBeenCalledWith("extra.ts");
      expect(ctx).toContain("content:extra.ts");
    });

    it("respects max_files across auto_include and additional files combined", () => {
      const agent = makeAgent({
        context: {
          max_files: 3,
          auto_include: ["a.ts", "b.ts"],
          project_specific: [],
        },
      });

      const mockReader = vi.fn((path: string) => `file:${path}`);
      cm.setFileReader(mockReader);

      const ctx = cm.assembleTaskContext(agent, "task", {
        files: ["c.ts", "d.ts"],
      });

      // 2 auto_include + 1 additional = 3 (max_files)
      expect(mockReader).toHaveBeenCalledTimes(3);
      expect(ctx).toContain("file:a.ts");
      expect(ctx).toContain("file:b.ts");
      expect(ctx).toContain("file:c.ts");
      expect(ctx).not.toContain("file:d.ts");
    });

    it("gracefully handles file read errors", () => {
      const agent = makeAgent({
        context: {
          max_files: 5,
          auto_include: ["exists.ts", "missing.ts"],
          project_specific: [],
        },
      });

      const mockReader = vi.fn((path: string) => {
        if (path === "missing.ts") throw new Error("ENOENT");
        return `ok:${path}`;
      });
      cm.setFileReader(mockReader);

      // Should not throw — just skip the unreadable file
      const ctx = cm.assembleTaskContext(agent, "task");
      expect(ctx).toContain("ok:exists.ts");
      expect(ctx).not.toContain("ENOENT");
    });
  });

  // ---------------------------------------------------------------
  // Context isolation
  // ---------------------------------------------------------------
  describe("context isolation", () => {
    it("task context does NOT include other agents' session history", () => {
      const agentA = makeAgent({ name: "agent-a" });
      const agentB = makeAgent({ name: "agent-b" });

      // Simulate session history for agent-a by storing it via team context
      cm.updateTeamContext("session:agent-a", "agent-a private history");

      const ctxB = cm.assembleTaskContext(agentB, "do work");

      // Session-scoped data for agent-a must NOT appear in agent-b's context
      expect(ctxB).not.toContain("agent-a private history");
    });
  });

  // ---------------------------------------------------------------
  // updateTeamContext / getTeamContext
  // ---------------------------------------------------------------
  describe("updateTeamContext / getTeamContext", () => {
    it("stores and retrieves shared state", () => {
      cm.updateTeamContext("db_choice", "PostgreSQL");
      cm.updateTeamContext("api_style", "REST");

      const state = cm.getTeamContext();

      expect(state["db_choice"]).toBe("PostgreSQL");
      expect(state["api_style"]).toBe("REST");
    });

    it("overwrites existing keys", () => {
      cm.updateTeamContext("db_choice", "MySQL");
      cm.updateTeamContext("db_choice", "PostgreSQL");

      const state = cm.getTeamContext();
      expect(state["db_choice"]).toBe("PostgreSQL");
    });

    it("returns an empty object when nothing has been stored", () => {
      const state = cm.getTeamContext();
      expect(state).toEqual({});
    });

    it("returns a copy — mutations do not affect internal state", () => {
      cm.updateTeamContext("key", "value");
      const state = cm.getTeamContext();
      (state as Record<string, unknown>)["key"] = "mutated";

      expect(cm.getTeamContext()["key"]).toBe("value");
    });
  });

  // ---------------------------------------------------------------
  // saveDecision / getDecisions
  // ---------------------------------------------------------------
  describe("saveDecision / getDecisions", () => {
    it("adds a decision with agent, decision, rationale, and timestamp", () => {
      cm.saveDecision("architect", "Use microservices", "Better scalability");

      const decisions = cm.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].agent).toBe("architect");
      expect(decisions[0].decision).toBe("Use microservices");
      expect(decisions[0].rationale).toBe("Better scalability");
      expect(typeof decisions[0].timestamp).toBe("string");
      // Timestamp should be a valid ISO date
      expect(Number.isNaN(Date.parse(decisions[0].timestamp))).toBe(false);
    });

    it("accumulates multiple decisions", () => {
      cm.saveDecision("architect", "Decision 1", "Rationale 1");
      cm.saveDecision("cto", "Decision 2", "Rationale 2");
      cm.saveDecision("architect", "Decision 3", "Rationale 3");

      const decisions = cm.getDecisions();
      expect(decisions).toHaveLength(3);
      expect(decisions[0].decision).toBe("Decision 1");
      expect(decisions[1].decision).toBe("Decision 2");
      expect(decisions[2].decision).toBe("Decision 3");
    });

    it("returns empty array when no decisions exist", () => {
      expect(cm.getDecisions()).toEqual([]);
    });

    it("returns a copy — mutations do not affect internal state", () => {
      cm.saveDecision("architect", "Original", "Original rationale");
      const decisions = cm.getDecisions();
      decisions.push({
        agent: "fake",
        decision: "fake",
        rationale: "fake",
        timestamp: "fake",
      });

      expect(cm.getDecisions()).toHaveLength(1);
    });
  });
});
