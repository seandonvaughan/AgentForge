import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FeedbackCollector } from "../../src/feedback/feedback-collector.js";
import type { AgentFeedback } from "../../src/types/feedback.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeFeedback(overrides: Partial<AgentFeedback> = {}): AgentFeedback {
  return {
    id: "test-id-001",
    agent: "optimizer",
    category: "optimization",
    priority: "medium",
    title: "Reduce prompt size",
    description: "The system prompt is longer than necessary.",
    context: {},
    suggestion: "Trim the system prompt to under 500 tokens.",
    timestamp: "2026-03-25T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Suite
// ---------------------------------------------------------------------------

describe("FeedbackCollector", () => {
  let tmpDir: string;
  let collector: FeedbackCollector;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentforge-feedback-test-"));
    collector = new FeedbackCollector(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  //  submitFeedback — directory creation
  // -------------------------------------------------------------------------
  describe("submitFeedback", () => {
    it("creates .agentforge/feedback/ directory if it does not exist", async () => {
      const feedback = makeFeedback();
      await collector.submitFeedback(feedback);

      const feedbackDir = path.join(tmpDir, ".agentforge", "feedback");
      const stat = await fs.stat(feedbackDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("returns the absolute file path of the written file", async () => {
      const feedback = makeFeedback();
      const filePath = await collector.submitFeedback(feedback);

      expect(path.isAbsolute(filePath)).toBe(true);
      expect(filePath).toContain("optimizer");
      expect(filePath).toContain("2026-03-25");
      expect(filePath).toContain("test-id-001");
      expect(filePath).toMatch(/\.md$/);
    });

    it("file has correct YAML frontmatter", async () => {
      const feedback = makeFeedback({
        id: "abc-123",
        agent: "cost-agent",
        category: "cost",
        priority: "high",
        timestamp: "2026-03-25T12:00:00.000Z",
      });
      const filePath = await collector.submitFeedback(feedback);
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toMatch(/^---\n/);
      expect(content).toContain("id: abc-123");
      expect(content).toContain("agent: cost-agent");
      expect(content).toContain("category: cost");
      expect(content).toContain("priority: high");
      expect(content).toContain("timestamp: 2026-03-25T12:00:00.000Z");
      expect(content).toContain("---");
    });

    it("file body contains title, description, and suggestion", async () => {
      const feedback = makeFeedback({
        title: "Optimize token usage",
        description: "Current usage is higher than expected.",
        suggestion: "Switch to haiku for utility tasks.",
      });
      const filePath = await collector.submitFeedback(feedback);
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("# Optimize token usage");
      expect(content).toContain("Current usage is higher than expected.");
      expect(content).toContain("Switch to haiku for utility tasks.");
    });

    it("file body includes context section when context is provided", async () => {
      const feedback = makeFeedback({
        context: {
          task: "analyze dependencies",
          files_involved: ["src/index.ts", "src/types.ts"],
          model_used: "sonnet",
          tokens_consumed: 4200,
          duration_ms: 1500,
        },
      });
      const filePath = await collector.submitFeedback(feedback);
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("## Context");
      expect(content).toContain("analyze dependencies");
      expect(content).toContain("src/index.ts");
      expect(content).toContain("sonnet");
      expect(content).toContain("4200");
      expect(content).toContain("1500ms");
    });

    it("file body omits context section when context is empty", async () => {
      const feedback = makeFeedback({ context: {} });
      const filePath = await collector.submitFeedback(feedback);
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).not.toContain("## Context");
    });

    it("sanitizes agent name with special characters in filename", async () => {
      const feedback = makeFeedback({ agent: "my agent/v2" });
      const filePath = await collector.submitFeedback(feedback);

      expect(filePath).not.toContain("/my agent/v2");
      expect(filePath).toMatch(/\.md$/);
      // Verify the file was actually written
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  //  loadAllFeedback
  // -------------------------------------------------------------------------
  describe("loadAllFeedback", () => {
    it("returns empty array when no feedback has been submitted", async () => {
      const all = await collector.loadAllFeedback();
      expect(all).toEqual([]);
    });

    it("reads all .md files from feedback directory", async () => {
      await collector.submitFeedback(makeFeedback({ id: "id-1", agent: "agent-a" }));
      await collector.submitFeedback(makeFeedback({ id: "id-2", agent: "agent-b" }));
      await collector.submitFeedback(
        makeFeedback({ id: "id-3", agent: "agent-a", category: "bug" }),
      );

      const all = await collector.loadAllFeedback();
      expect(all).toHaveLength(3);
    });

    it("reconstructs AgentFeedback with correct fields", async () => {
      const original = makeFeedback({
        id: "reconstruct-01",
        agent: "optimizer",
        category: "cost",
        priority: "critical",
        title: "Reduce cost",
        description: "Costs are too high.",
        suggestion: "Use haiku for simple tasks.",
        timestamp: "2026-03-25T08:00:00.000Z",
      });

      await collector.submitFeedback(original);
      const all = await collector.loadAllFeedback();
      expect(all).toHaveLength(1);

      const loaded = all[0];
      expect(loaded.id).toBe("reconstruct-01");
      expect(loaded.agent).toBe("optimizer");
      expect(loaded.category).toBe("cost");
      expect(loaded.priority).toBe("critical");
      expect(loaded.title).toBe("Reduce cost");
      expect(loaded.description).toBe("Costs are too high.");
      expect(loaded.suggestion).toBe("Use haiku for simple tasks.");
      expect(loaded.timestamp).toBe("2026-03-25T08:00:00.000Z");
    });

    it("reconstructs context fields when present", async () => {
      const feedback = makeFeedback({
        id: "ctx-01",
        context: {
          task: "run tests",
          files_involved: ["src/a.ts", "src/b.ts"],
          model_used: "haiku",
          tokens_consumed: 800,
          duration_ms: 300,
        },
      });
      await collector.submitFeedback(feedback);

      const [loaded] = await collector.loadAllFeedback();
      expect(loaded.context.task).toBe("run tests");
      expect(loaded.context.files_involved).toEqual(["src/a.ts", "src/b.ts"]);
      expect(loaded.context.model_used).toBe("haiku");
      expect(loaded.context.tokens_consumed).toBe(800);
      expect(loaded.context.duration_ms).toBe(300);
    });

    it("multiple feedbacks from different agents accumulate correctly", async () => {
      const agents = ["alpha", "beta", "gamma"];
      for (const agent of agents) {
        await collector.submitFeedback(
          makeFeedback({ id: `id-${agent}`, agent }),
        );
      }

      const all = await collector.loadAllFeedback();
      expect(all).toHaveLength(3);

      const foundAgents = all.map((f) => f.agent).sort();
      expect(foundAgents).toEqual(["alpha", "beta", "gamma"]);
    });
  });

  // -------------------------------------------------------------------------
  //  getSummary
  // -------------------------------------------------------------------------
  describe("getSummary", () => {
    it("returns zero counts when no feedback exists", async () => {
      const summary = await collector.getSummary();
      expect(summary.total).toBe(0);
      expect(summary.by_category.optimization).toBe(0);
      expect(summary.by_priority.high).toBe(0);
      expect(summary.entries).toEqual([]);
    });

    it("aggregates counts correctly across categories", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", category: "optimization" }));
      await collector.submitFeedback(makeFeedback({ id: "2", category: "bug" }));
      await collector.submitFeedback(makeFeedback({ id: "3", category: "optimization" }));
      await collector.submitFeedback(makeFeedback({ id: "4", category: "cost" }));

      const summary = await collector.getSummary();
      expect(summary.total).toBe(4);
      expect(summary.by_category.optimization).toBe(2);
      expect(summary.by_category.bug).toBe(1);
      expect(summary.by_category.cost).toBe(1);
      expect(summary.by_category.feature).toBe(0);
    });

    it("aggregates counts correctly across priorities", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", priority: "critical" }));
      await collector.submitFeedback(makeFeedback({ id: "2", priority: "high" }));
      await collector.submitFeedback(makeFeedback({ id: "3", priority: "high" }));
      await collector.submitFeedback(makeFeedback({ id: "4", priority: "low" }));

      const summary = await collector.getSummary();
      expect(summary.by_priority.critical).toBe(1);
      expect(summary.by_priority.high).toBe(2);
      expect(summary.by_priority.medium).toBe(0);
      expect(summary.by_priority.low).toBe(1);
    });

    it("aggregates counts correctly by agent", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", agent: "coder" }));
      await collector.submitFeedback(makeFeedback({ id: "2", agent: "coder" }));
      await collector.submitFeedback(makeFeedback({ id: "3", agent: "reviewer" }));

      const summary = await collector.getSummary();
      expect(summary.by_agent["coder"]).toBe(2);
      expect(summary.by_agent["reviewer"]).toBe(1);
    });

    it("includes all entries in the entries array", async () => {
      await collector.submitFeedback(makeFeedback({ id: "e1" }));
      await collector.submitFeedback(makeFeedback({ id: "e2" }));

      const summary = await collector.getSummary();
      expect(summary.entries).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  //  getByCategory
  // -------------------------------------------------------------------------
  describe("getByCategory", () => {
    it("returns only feedback matching the given category", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", category: "bug" }));
      await collector.submitFeedback(makeFeedback({ id: "2", category: "optimization" }));
      await collector.submitFeedback(makeFeedback({ id: "3", category: "bug" }));

      const bugs = await collector.getByCategory("bug");
      expect(bugs).toHaveLength(2);
      expect(bugs.every((f) => f.category === "bug")).toBe(true);
    });

    it("returns empty array when no feedback matches the category", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", category: "bug" }));

      const features = await collector.getByCategory("feature");
      expect(features).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  //  getByPriority
  // -------------------------------------------------------------------------
  describe("getByPriority", () => {
    it("returns only feedback matching the given priority", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", priority: "critical" }));
      await collector.submitFeedback(makeFeedback({ id: "2", priority: "low" }));
      await collector.submitFeedback(makeFeedback({ id: "3", priority: "critical" }));

      const critical = await collector.getByPriority("critical");
      expect(critical).toHaveLength(2);
      expect(critical.every((f) => f.priority === "critical")).toBe(true);
    });

    it("returns empty array when no feedback matches the priority", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", priority: "low" }));

      const high = await collector.getByPriority("high");
      expect(high).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  //  getByAgent
  // -------------------------------------------------------------------------
  describe("getByAgent", () => {
    it("returns only feedback from the given agent", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", agent: "coder" }));
      await collector.submitFeedback(makeFeedback({ id: "2", agent: "reviewer" }));
      await collector.submitFeedback(makeFeedback({ id: "3", agent: "coder" }));

      const coderFeedback = await collector.getByAgent("coder");
      expect(coderFeedback).toHaveLength(2);
      expect(coderFeedback.every((f) => f.agent === "coder")).toBe(true);
    });

    it("returns empty array when agent has not submitted feedback", async () => {
      await collector.submitFeedback(makeFeedback({ id: "1", agent: "coder" }));

      const unknown = await collector.getByAgent("ghost");
      expect(unknown).toEqual([]);
    });
  });
});
