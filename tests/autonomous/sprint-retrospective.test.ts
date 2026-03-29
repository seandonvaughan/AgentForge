/**
 * tests/autonomous/sprint-retrospective.test.ts
 *
 * Tests for generateRetrospective() — metric compilation and pattern extraction.
 */

import { describe, it, expect } from "vitest";
import {
  generateRetrospective,
  type SprintData,
  type SprintDataItem,
} from "../../src/autonomous/sprint-retrospective.js";
import type { TaskMemory } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  overrides: Partial<SprintDataItem> & { id: string },
): SprintDataItem {
  return {
    title: "Test item",
    assignee: "coder",
    status: "completed",
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMemory(overrides: Partial<TaskMemory> = {}): TaskMemory {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    objective: "Complete a task",
    approach: "Standard approach",
    outcome: "success",
    lessonsLearned: [],
    filesModified: [],
    collaborators: [],
    difficulty: 2,
    tokensUsed: 500,
    ...overrides,
  };
}

function makeSprint(overrides: Partial<SprintData> = {}): SprintData {
  return {
    sprintId: "sprint-test-1",
    version: "6.2",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    phase: "learn",
    items: [],
    budget: 100,
    budgetUsed: 45,
    agentsInvolved: ["cto", "coder"],
    successCriteria: ["All items completed"],
    auditFindings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateRetrospective", () => {
  // ── Basic structure ────────────────────────────────────────────────────────

  describe("return shape", () => {
    it("returns an object with the expected top-level keys", () => {
      const retro = generateRetrospective(makeSprint(), []);
      expect(retro).toHaveProperty("sprintId");
      expect(retro).toHaveProperty("version");
      expect(retro).toHaveProperty("metrics");
      expect(retro).toHaveProperty("patterns");
      expect(retro).toHaveProperty("learnings");
      expect(retro).toHaveProperty("recommendations");
    });

    it("copies sprintId and version from sprint data", () => {
      const sprint = makeSprint({ sprintId: "abc-123", version: "7.0" });
      const retro = generateRetrospective(sprint, []);
      expect(retro.sprintId).toBe("abc-123");
      expect(retro.version).toBe("7.0");
    });

    it("metrics has all required fields", () => {
      const retro = generateRetrospective(makeSprint(), []);
      expect(retro.metrics).toHaveProperty("itemsCompleted");
      expect(retro.metrics).toHaveProperty("itemsTotal");
      expect(retro.metrics).toHaveProperty("totalCostUsd");
      expect(retro.metrics).toHaveProperty("avgCostPerItem");
      expect(retro.metrics).toHaveProperty("totalTokens");
      expect(retro.metrics).toHaveProperty("durationMs");
      expect(retro.metrics).toHaveProperty("agentsUsed");
    });

    it("patterns has whatWentWell, whatDidnt, recurringBlockers arrays", () => {
      const retro = generateRetrospective(makeSprint(), []);
      expect(Array.isArray(retro.patterns.whatWentWell)).toBe(true);
      expect(Array.isArray(retro.patterns.whatDidnt)).toBe(true);
      expect(Array.isArray(retro.patterns.recurringBlockers)).toBe(true);
    });
  });

  // ── Metric compilation ─────────────────────────────────────────────────────

  describe("metric compilation", () => {
    it("counts completed items correctly", () => {
      const items = [
        makeItem({ id: "i1", status: "completed" }),
        makeItem({ id: "i2", status: "completed" }),
        makeItem({ id: "i3", status: "blocked" }),
      ];
      const sprint = makeSprint({ items });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.itemsCompleted).toBe(2);
      expect(retro.metrics.itemsTotal).toBe(3);
    });

    it("sets totalCostUsd from sprint budgetUsed", () => {
      const sprint = makeSprint({ budgetUsed: 37.5 });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.totalCostUsd).toBeCloseTo(37.5);
    });

    it("computes avgCostPerItem correctly", () => {
      const items = [
        makeItem({ id: "i1", status: "completed" }),
        makeItem({ id: "i2", status: "completed" }),
      ];
      const sprint = makeSprint({ items, budgetUsed: 10 });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.avgCostPerItem).toBeCloseTo(5);
    });

    it("avgCostPerItem is 0 when no items completed", () => {
      const items = [makeItem({ id: "i1", status: "blocked" })];
      const sprint = makeSprint({ items, budgetUsed: 20 });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.avgCostPerItem).toBe(0);
    });

    it("sums totalTokens from task memories", () => {
      const memories = [
        makeMemory({ tokensUsed: 100 }),
        makeMemory({ tokensUsed: 200 }),
        makeMemory({ tokensUsed: 300 }),
      ];
      const retro = generateRetrospective(makeSprint(), memories);
      expect(retro.metrics.totalTokens).toBe(600);
    });

    it("totalTokens is 0 when memories array is empty", () => {
      const retro = generateRetrospective(makeSprint(), []);
      expect(retro.metrics.totalTokens).toBe(0);
    });

    it("computes durationMs as time between createdAt and last completedAt", () => {
      const createdAt = new Date("2026-01-01T10:00:00Z").toISOString();
      const completedAt = new Date("2026-01-01T12:00:00Z").toISOString();
      const items = [makeItem({ id: "i1", status: "completed", completedAt })];
      const sprint = makeSprint({ createdAt, items });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.durationMs).toBe(2 * 3600_000);
    });

    it("durationMs is 0 when no items have completedAt", () => {
      const items = [makeItem({ id: "i1", status: "blocked", completedAt: undefined })];
      const sprint = makeSprint({ items });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.durationMs).toBe(0);
    });

    it("agentsUsed includes agents from agentsInvolved and item assignees (deduplicated)", () => {
      const items = [
        makeItem({ id: "i1", assignee: "coder" }),
        makeItem({ id: "i2", assignee: "coder" }),
        makeItem({ id: "i3", assignee: "tester" }),
      ];
      const sprint = makeSprint({ items, agentsInvolved: ["cto", "coder"] });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.agentsUsed).toContain("cto");
      expect(retro.metrics.agentsUsed).toContain("coder");
      expect(retro.metrics.agentsUsed).toContain("tester");
      // No duplicates
      const coderCount = retro.metrics.agentsUsed.filter((a) => a === "coder").length;
      expect(coderCount).toBe(1);
    });
  });

  // ── Pattern extraction ─────────────────────────────────────────────────────

  describe("pattern extraction — whatWentWell", () => {
    it("detects high completion rate (≥90%)", () => {
      const items = [
        makeItem({ id: "i1", status: "completed" }),
        makeItem({ id: "i2", status: "completed" }),
        makeItem({ id: "i3", status: "completed" }),
        makeItem({ id: "i4", status: "completed" }),
        makeItem({ id: "i5", status: "completed" }),
        makeItem({ id: "i6", status: "completed" }),
        makeItem({ id: "i7", status: "completed" }),
        makeItem({ id: "i8", status: "completed" }),
        makeItem({ id: "i9", status: "completed" }),
        makeItem({ id: "i10", status: "blocked" }),
      ];
      const sprint = makeSprint({ items });
      const retro = generateRetrospective(sprint, []);
      const hasRatePositive = retro.patterns.whatWentWell.some((w) =>
        w.toLowerCase().includes("completion rate"),
      );
      expect(hasRatePositive).toBe(true);
    });

    it("detects under-budget sprint", () => {
      const sprint = makeSprint({ budget: 100, budgetUsed: 70 });
      const retro = generateRetrospective(sprint, []);
      const underBudget = retro.patterns.whatWentWell.some((w) =>
        w.toLowerCase().includes("budget"),
      );
      expect(underBudget).toBe(true);
    });

    it("detects strong memory success rate", () => {
      const memories = Array.from({ length: 10 }, () =>
        makeMemory({ outcome: "success" }),
      );
      const retro = generateRetrospective(makeSprint(), memories);
      const hasSuccessRate = retro.patterns.whatWentWell.some((w) =>
        w.toLowerCase().includes("success rate"),
      );
      expect(hasSuccessRate).toBe(true);
    });
  });

  describe("pattern extraction — whatDidnt", () => {
    it("flags incomplete items", () => {
      const items = [
        makeItem({ id: "i1", status: "in_progress" }),
        makeItem({ id: "i2", status: "completed" }),
      ];
      const sprint = makeSprint({ items });
      const retro = generateRetrospective(sprint, []);
      const hasIncomplete = retro.patterns.whatDidnt.some((w) =>
        w.toLowerCase().includes("not completed"),
      );
      expect(hasIncomplete).toBe(true);
    });

    it("flags budget overrun", () => {
      const sprint = makeSprint({ budget: 50, budgetUsed: 80 });
      const retro = generateRetrospective(sprint, []);
      const overrun = retro.patterns.whatDidnt.some((w) =>
        w.toLowerCase().includes("budget exceeded"),
      );
      expect(overrun).toBe(true);
    });

    it("flags elevated failure rate when >30% of memories failed", () => {
      const memories = [
        ...Array.from({ length: 4 }, () => makeMemory({ outcome: "failure" })),
        ...Array.from({ length: 6 }, () => makeMemory({ outcome: "success" })),
      ];
      const retro = generateRetrospective(makeSprint(), memories);
      const hasFail = retro.patterns.whatDidnt.some((w) =>
        w.toLowerCase().includes("failure rate"),
      );
      expect(hasFail).toBe(true);
    });
  });

  describe("pattern extraction — recurringBlockers", () => {
    it("flags blocked/deferred items", () => {
      const items = [
        makeItem({ id: "i1", status: "blocked" }),
        makeItem({ id: "i2", status: "deferred" }),
      ];
      const sprint = makeSprint({ items });
      const retro = generateRetrospective(sprint, []);
      const hasBlocker = retro.patterns.recurringBlockers.some((b) =>
        b.toLowerCase().includes("blocked"),
      );
      expect(hasBlocker).toBe(true);
    });

    it("identifies recurring lessons appearing 2+ times", () => {
      const sharedLesson = "Skipping tests causes failures";
      const memories = [
        makeMemory({ lessonsLearned: [sharedLesson] }),
        makeMemory({ lessonsLearned: [sharedLesson] }),
        makeMemory({ lessonsLearned: ["unrelated lesson"] }),
      ];
      const retro = generateRetrospective(makeSprint(), memories);
      const recurringFound = retro.patterns.recurringBlockers.some((b) =>
        b.includes(sharedLesson),
      );
      expect(recurringFound).toBe(true);
    });

    it("does not flag lessons appearing only once", () => {
      const memories = [
        makeMemory({ lessonsLearned: ["unique lesson only once"] }),
      ];
      const retro = generateRetrospective(makeSprint(), memories);
      const singleLesson = retro.patterns.recurringBlockers.some((b) =>
        b.includes("unique lesson only once"),
      );
      expect(singleLesson).toBe(false);
    });
  });

  // ── Learnings ─────────────────────────────────────────────────────────────

  describe("learnings", () => {
    it("returns a non-empty learnings array", () => {
      const items = [makeItem({ id: "i1", status: "completed" })];
      const memories = [makeMemory({ tokensUsed: 1000 })];
      const sprint = makeSprint({ items });
      const retro = generateRetrospective(sprint, memories);
      expect(retro.learnings.length).toBeGreaterThan(0);
    });

    it("includes token cost learning when memories have tokens", () => {
      const memories = [makeMemory({ tokensUsed: 600 })];
      const retro = generateRetrospective(makeSprint(), memories);
      const tokenLearning = retro.learnings.some((l) =>
        l.toLowerCase().includes("token") || l.toLowerCase().includes("cost"),
      );
      expect(tokenLearning).toBe(true);
    });
  });

  // ── Recommendations ────────────────────────────────────────────────────────

  describe("recommendations", () => {
    it("always returns at least one recommendation", () => {
      const retro = generateRetrospective(makeSprint(), []);
      expect(retro.recommendations.length).toBeGreaterThan(0);
    });

    it("recommends scope reduction when completion rate < 70%", () => {
      const items = [
        makeItem({ id: "i1", status: "blocked" }),
        makeItem({ id: "i2", status: "blocked" }),
        makeItem({ id: "i3", status: "completed" }),
        makeItem({ id: "i4", status: "blocked" }),
        makeItem({ id: "i5", status: "blocked" }),
      ];
      const sprint = makeSprint({ items });
      const retro = generateRetrospective(sprint, []);
      const scopeRec = retro.recommendations.some((r) =>
        r.toLowerCase().includes("scope"),
      );
      expect(scopeRec).toBe(true);
    });

    it("recommends model routing fix when budget exceeded", () => {
      const sprint = makeSprint({ budget: 10, budgetUsed: 20 });
      const retro = generateRetrospective(sprint, []);
      const budgetRec = retro.recommendations.some((r) =>
        r.toLowerCase().includes("model routing") || r.toLowerCase().includes("budget"),
      );
      expect(budgetRec).toBe(true);
    });

    it("recommends positive continuation when sprint was excellent", () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        makeItem({ id: `i${i}`, status: "completed" }),
      );
      const sprint = makeSprint({ items, budget: 100, budgetUsed: 40 });
      const memories = Array.from({ length: 5 }, () =>
        makeMemory({ outcome: "success" }),
      );
      const retro = generateRetrospective(sprint, memories);
      const positiveRec = retro.recommendations.some(
        (r) =>
          r.toLowerCase().includes("well") ||
          r.toLowerCase().includes("maintain") ||
          r.toLowerCase().includes("growth") ||
          r.toLowerCase().includes("scope") ||
          r.toLowerCase().includes("no critical"),
      );
      expect(positiveRec).toBe(true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles an empty sprint (no items, no memories)", () => {
      const sprint = makeSprint({ items: [] });
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.itemsCompleted).toBe(0);
      expect(retro.metrics.itemsTotal).toBe(0);
      expect(retro.metrics.totalTokens).toBe(0);
      expect(retro.metrics.totalCostUsd).toBeGreaterThanOrEqual(0);
    });

    it("handles missing budgetUsed (defaults to 0)", () => {
      const sprint: SprintData = {
        ...makeSprint(),
        budgetUsed: undefined,
      };
      const retro = generateRetrospective(sprint, []);
      expect(retro.metrics.totalCostUsd).toBe(0);
    });

    it("is a pure function — does not mutate the input sprint", () => {
      const sprint = makeSprint({
        items: [makeItem({ id: "i1", status: "planned" })],
      });
      const originalStatus = sprint.items[0].status;
      generateRetrospective(sprint, []);
      expect(sprint.items[0].status).toBe(originalStatus);
    });
  });
});
