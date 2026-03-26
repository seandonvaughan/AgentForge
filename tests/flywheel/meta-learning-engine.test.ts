import { describe, it, expect, beforeEach } from "vitest";
import { MetaLearningEngine, type TaskOutcome, type Insight } from "../../src/flywheel/meta-learning-engine.js";

function makeOutcome(overrides?: Partial<TaskOutcome>): TaskOutcome {
  return {
    taskId: "task-1",
    agentId: "cto",
    description: "Implement authentication",
    success: true,
    durationMs: 5000,
    patternsUsed: ["tdd", "iterative"],
    lessonsLearned: ["Start with failing test"],
    sprintId: "sprint-1",
    ...overrides,
  };
}

describe("MetaLearningEngine", () => {
  let engine: MetaLearningEngine;
  beforeEach(() => { engine = new MetaLearningEngine(); });

  describe("recordOutcome", () => {
    it("records a task outcome", () => {
      engine.recordOutcome(makeOutcome());
      expect(engine.outcomeCount()).toBe(1);
    });
  });

  describe("extractPatterns", () => {
    it("extracts recurring patterns from outcomes", () => {
      engine.recordOutcome(makeOutcome({ patternsUsed: ["tdd"], success: true }));
      engine.recordOutcome(makeOutcome({ taskId: "t2", patternsUsed: ["tdd"], success: true }));
      engine.recordOutcome(makeOutcome({ taskId: "t3", patternsUsed: ["tdd"], success: false }));
      const patterns = engine.extractPatterns();
      const tdd = patterns.find((p) => p.pattern === "tdd");
      expect(tdd).toBeDefined();
      expect(tdd!.frequency).toBe(3);
      expect(tdd!.successRate).toBeCloseTo(2 / 3, 1);
    });
  });

  describe("generateInsights", () => {
    it("generates actionable insights from patterns", () => {
      for (let i = 0; i < 5; i++) {
        engine.recordOutcome(makeOutcome({
          taskId: `t${i}`, patternsUsed: ["tdd"],
          success: i < 4, // 80% success
          lessonsLearned: ["TDD catches bugs early"],
        }));
      }
      for (let i = 0; i < 3; i++) {
        engine.recordOutcome(makeOutcome({
          taskId: `f${i}`, patternsUsed: ["yolo"],
          success: i < 1, // 33% success
          lessonsLearned: ["Skipping tests is risky"],
        }));
      }
      const insights = engine.generateInsights();
      expect(insights.length).toBeGreaterThanOrEqual(1);
      expect(insights.some((i) => i.actionable)).toBe(true);
    });
    it("marks insights as actionable when pattern success rate diverges", () => {
      // High-success pattern
      for (let i = 0; i < 5; i++) {
        engine.recordOutcome(makeOutcome({
          taskId: `good${i}`, patternsUsed: ["pair-programming"], success: true,
        }));
      }
      // Low-success pattern
      for (let i = 0; i < 5; i++) {
        engine.recordOutcome(makeOutcome({
          taskId: `bad${i}`, patternsUsed: ["solo-hacking"], success: false,
        }));
      }
      const insights = engine.generateInsights();
      expect(insights.some((i) => i.actionable && i.recommendation.length > 0)).toBe(true);
    });
  });

  describe("knowledge graph", () => {
    it("builds edges between co-occurring patterns", () => {
      engine.recordOutcome(makeOutcome({ patternsUsed: ["tdd", "pair-programming"] }));
      engine.recordOutcome(makeOutcome({ taskId: "t2", patternsUsed: ["tdd", "pair-programming"] }));
      const graph = engine.getKnowledgeGraph();
      expect(graph.edges.length).toBeGreaterThan(0);
      const edge = graph.edges.find(
        (e) => (e.from === "tdd" && e.to === "pair-programming") ||
               (e.from === "pair-programming" && e.to === "tdd")
      );
      expect(edge).toBeDefined();
      expect(edge!.cooccurrences).toBe(2);
    });
    it("graph nodes include all unique patterns", () => {
      engine.recordOutcome(makeOutcome({ patternsUsed: ["a", "b"] }));
      engine.recordOutcome(makeOutcome({ taskId: "t2", patternsUsed: ["b", "c"] }));
      const graph = engine.getKnowledgeGraph();
      expect(graph.nodes).toContain("a");
      expect(graph.nodes).toContain("b");
      expect(graph.nodes).toContain("c");
    });
  });

  describe("getOutcomesByAgent", () => {
    it("filters outcomes by agent", () => {
      engine.recordOutcome(makeOutcome({ agentId: "cto" }));
      engine.recordOutcome(makeOutcome({ taskId: "t2", agentId: "arch" }));
      expect(engine.getOutcomesByAgent("cto")).toHaveLength(1);
    });
  });
});
