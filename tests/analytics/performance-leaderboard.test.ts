/**
 * tests/analytics/performance-leaderboard.test.ts
 *
 * Tests for PerformanceLeaderboard — Sprint v6.2 P2-2.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PerformanceLeaderboard } from "../../src/analytics/performance-leaderboard.js";
import type { AgentCareerRecord, TaskMemory, PerformanceMetrics, SkillProfile } from "../../src/types/lifecycle.js";
import { AutonomyTier } from "../../src/types/v4-api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    tasksCompleted: 10,
    successRate: 0.8,
    avgTaskDuration: 5000,
    peerReviewScore: 0.75,
    mentorshipCount: 0,
    ...overrides,
  };
}

function makeSkillProfile(agentId: string, skillLevels: Record<string, number> = {}): SkillProfile {
  const skills: SkillProfile["skills"] = {};
  for (const [name, level] of Object.entries(skillLevels)) {
    skills[name] = {
      name,
      level,
      exerciseCount: 20,
      successRate: 0.85,
      lastExercised: new Date().toISOString(),
      unlockedCapabilities: [],
    };
  }
  return { agentId, skills };
}

function makeCareerRecord(
  agentId: string,
  metrics: Partial<PerformanceMetrics> = {},
  skillLevels: Record<string, number> = {},
): AgentCareerRecord {
  return {
    agentId,
    hiredAt: "2025-01-01T00:00:00Z",
    currentTeam: "backend-team",
    currentRole: "specialist",
    seniority: "mid",
    autonomyTier: 2 as AutonomyTier,
    skillProfile: makeSkillProfile(agentId, skillLevels),
    taskHistory: [],
    careerEvents: [],
    performanceMetrics: makeMetrics(metrics),
  };
}

function makeTaskMemory(
  outcome: "success" | "partial" | "failure",
  timestamp: string,
  tokensUsed: number = 1000,
  model?: string,
): TaskMemory & { model?: string } {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    timestamp,
    objective: "Test task",
    approach: "direct",
    outcome,
    lessonsLearned: [],
    filesModified: [],
    collaborators: [],
    difficulty: 2,
    tokensUsed,
    model,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PerformanceLeaderboard", () => {
  let lb: PerformanceLeaderboard;

  beforeEach(() => {
    lb = new PerformanceLeaderboard();
  });

  // -------------------------------------------------------------------------
  // rankAgents()
  // -------------------------------------------------------------------------

  describe("rankAgents()", () => {
    it("returns empty array for empty input", () => {
      expect(lb.rankAgents([])).toEqual([]);
    });

    it("returns single entry with rank 1 for single agent", () => {
      const careers = [makeCareerRecord("agent-1", { tasksCompleted: 5, successRate: 0.8 })];
      const result = lb.rankAgents(careers);

      expect(result).toHaveLength(1);
      expect(result[0].rank).toBe(1);
      expect(result[0].agentId).toBe("agent-1");
    });

    it("ranks higher-performing agent above lower-performing agent", () => {
      const careers = [
        makeCareerRecord("agent-low", { tasksCompleted: 5, successRate: 0.5, peerReviewScore: 0.5 }),
        makeCareerRecord("agent-high", { tasksCompleted: 20, successRate: 0.9, peerReviewScore: 0.9 }),
      ];
      const result = lb.rankAgents(careers);

      expect(result[0].agentId).toBe("agent-high");
      expect(result[0].rank).toBe(1);
      expect(result[1].agentId).toBe("agent-low");
      expect(result[1].rank).toBe(2);
    });

    it("assigns same rank to agents with equal composite scores", () => {
      const careers = [
        makeCareerRecord("agent-a", { tasksCompleted: 10, successRate: 0.8, peerReviewScore: 0.8 }),
        makeCareerRecord("agent-b", { tasksCompleted: 10, successRate: 0.8, peerReviewScore: 0.8 }),
      ];
      const result = lb.rankAgents(careers);

      expect(result[0].rank).toBe(result[1].rank);
    });

    it("compositeScore is between 0 and 100", () => {
      const careers = [
        makeCareerRecord("agent-1", { tasksCompleted: 100, successRate: 1.0, peerReviewScore: 1.0 }, { ts: 5, sql: 4 }),
        makeCareerRecord("agent-2", { tasksCompleted: 0, successRate: 0, peerReviewScore: 0 }),
      ];
      const result = lb.rankAgents(careers);

      for (const entry of result) {
        expect(entry.compositeScore).toBeGreaterThanOrEqual(0);
        expect(entry.compositeScore).toBeLessThanOrEqual(100);
      }
    });

    it("breakdown reflects normalized task volume", () => {
      const careers = [
        makeCareerRecord("agent-1", { tasksCompleted: 100 }),
        makeCareerRecord("agent-2", { tasksCompleted: 50 }),
      ];
      const result = lb.rankAgents(careers);

      const e1 = result.find((r) => r.agentId === "agent-1")!;
      const e2 = result.find((r) => r.agentId === "agent-2")!;

      expect(e1.breakdown.taskVolume).toBe(1); // 100/100
      expect(e2.breakdown.taskVolume).toBe(0.5); // 50/100
    });

    it("skillBreadth counts only skills at level >= 3", () => {
      const careers = [
        makeCareerRecord("agent-1", {}, { ts: 3, sql: 2, rust: 4 }), // 2 at level >= 3
        makeCareerRecord("agent-2", {}, { ts: 1, sql: 1, rust: 1 }), // 0 at level >= 3
      ];
      const result = lb.rankAgents(careers);

      const e1 = result.find((r) => r.agentId === "agent-1")!;
      const e2 = result.find((r) => r.agentId === "agent-2")!;

      expect(e1.breakdown.skillBreadth).toBeGreaterThan(e2.breakdown.skillBreadth);
    });

    it("composite score formula weights sum to 1.0", () => {
      // Agent with all factors = 1 should score 100
      const careers = [
        makeCareerRecord("perfect", { tasksCompleted: 10, successRate: 1.0, peerReviewScore: 1.0 }, { ts: 3 }),
      ];
      const result = lb.rankAgents(careers);
      // skillBreadth = 1/1 = 1 (only skill in cohort at level >= 3)
      // taskVolume = 10/10 = 1
      // score = (1*0.4 + 1*0.3 + 1*0.2 + 1*0.1) * 100 = 100
      expect(result[0].compositeScore).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // teamVelocity()
  // -------------------------------------------------------------------------

  describe("teamVelocity()", () => {
    it("returns empty sprints for empty sprintDates", () => {
      const report = lb.teamVelocity(new Map(), []);
      expect(report.sprints).toHaveLength(0);
      expect(report.avgVelocity).toBe(0);
    });

    it("computes velocity as completed / total for a single sprint", () => {
      const histories = new Map([
        [
          "agent-1",
          [
            makeTaskMemory("success", "2025-01-05T00:00:00Z"),
            makeTaskMemory("success", "2025-01-06T00:00:00Z"),
            makeTaskMemory("failure", "2025-01-07T00:00:00Z"),
          ],
        ],
      ]);

      const report = lb.teamVelocity(histories, ["2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z"]);

      // Sprint 1: 2 completed (success/partial), 3 total
      const sprint1 = report.sprints[0];
      expect(sprint1.tasksTotal).toBe(3);
      expect(sprint1.tasksCompleted).toBe(2);
      expect(sprint1.velocity).toBeCloseTo(2 / 3, 2);
    });

    it("counts partial outcomes as completed", () => {
      const histories = new Map([
        [
          "agent-1",
          [makeTaskMemory("partial", "2025-01-05T00:00:00Z")],
        ],
      ]);
      const report = lb.teamVelocity(histories, ["2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z"]);
      expect(report.sprints[0].tasksCompleted).toBe(1);
    });

    it("handles tasks across multiple agents in the same sprint", () => {
      const histories = new Map([
        ["agent-1", [makeTaskMemory("success", "2025-01-05T00:00:00Z")]],
        ["agent-2", [makeTaskMemory("success", "2025-01-10T00:00:00Z")]],
      ]);
      const report = lb.teamVelocity(histories, ["2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z"]);
      expect(report.sprints[0].tasksTotal).toBe(2);
    });

    it("assigns tasks to correct sprint windows", () => {
      const histories = new Map([
        [
          "agent-1",
          [
            makeTaskMemory("success", "2025-01-15T00:00:00Z"),
            makeTaskMemory("success", "2025-02-15T00:00:00Z"),
          ],
        ],
      ]);
      const report = lb.teamVelocity(histories, [
        "2025-01-01T00:00:00Z",
        "2025-02-01T00:00:00Z",
        "2025-03-01T00:00:00Z",
      ]);
      expect(report.sprints[0].tasksTotal).toBe(1); // Jan task
      expect(report.sprints[1].tasksTotal).toBe(1); // Feb task
    });

    it("detects improving trend", () => {
      const histories = new Map<string, TaskMemory[]>();
      // 3 sprint-date boundaries = 2 windows. Window 1: 0.1 velocity, Window 2: 0.9
      // That gives a clear positive slope above the 0.05 threshold.
      const sprints = [
        "2025-01-01T00:00:00Z",
        "2025-02-01T00:00:00Z",
        "2025-03-01T00:00:00Z",
      ];
      const tasks: Array<TaskMemory & { model?: string }> = [
        // Window 1 (Jan): 1/10 = 0.1
        makeTaskMemory("success", "2025-01-10T00:00:00Z"),
        ...Array.from({ length: 9 }, () => makeTaskMemory("failure", "2025-01-15T00:00:00Z")),
        // Window 2 (Feb): 9/10 = 0.9
        ...Array.from({ length: 9 }, () => makeTaskMemory("success", "2025-02-10T00:00:00Z")),
        makeTaskMemory("failure", "2025-02-15T00:00:00Z"),
      ];
      histories.set("agent-1", tasks);
      const report = lb.teamVelocity(histories, sprints);
      expect(report.trend).toBe("improving");
    });

    it("detects declining trend", () => {
      const histories = new Map<string, TaskMemory[]>();
      const sprints = [
        "2025-01-01T00:00:00Z",
        "2025-02-01T00:00:00Z",
        "2025-03-01T00:00:00Z",
        "2025-04-01T00:00:00Z",
      ];
      const tasks: Array<TaskMemory & { model?: string }> = [
        // Sprint 1: 9/10 = 0.9
        ...Array.from({ length: 9 }, () => makeTaskMemory("success", "2025-01-10T00:00:00Z")),
        makeTaskMemory("failure", "2025-01-15T00:00:00Z"),
        // Sprint 2: 5/10 = 0.5
        ...Array.from({ length: 5 }, () => makeTaskMemory("success", "2025-02-10T00:00:00Z")),
        ...Array.from({ length: 5 }, () => makeTaskMemory("failure", "2025-02-15T00:00:00Z")),
        // Sprint 3: 1/10 = 0.1
        makeTaskMemory("success", "2025-03-10T00:00:00Z"),
        ...Array.from({ length: 9 }, () => makeTaskMemory("failure", "2025-03-15T00:00:00Z")),
      ];
      histories.set("agent-1", tasks);
      const report = lb.teamVelocity(histories, sprints);
      expect(report.trend).toBe("declining");
    });

    it("computes avgVelocity correctly", () => {
      // 2 sprint-date boundaries = 1 window. 2 success tasks in Jan → velocity=1.
      const histories = new Map([
        [
          "agent-1",
          [
            makeTaskMemory("success", "2025-01-05T00:00:00Z"),
            makeTaskMemory("success", "2025-01-10T00:00:00Z"),
          ],
        ],
      ]);
      const report = lb.teamVelocity(histories, [
        "2025-01-01T00:00:00Z",
        "2025-02-01T00:00:00Z",
      ]);
      // 1 sprint window with 2 completed / 2 total = velocity 1.0
      expect(report.avgVelocity).toBeCloseTo(1, 2);
    });
  });

  // -------------------------------------------------------------------------
  // modelEfficiency()
  // -------------------------------------------------------------------------

  describe("modelEfficiency()", () => {
    it("returns empty models for empty input", () => {
      const report = lb.modelEfficiency([]);
      expect(report.models).toHaveLength(0);
      expect(report.mostEfficient).toBe("unknown");
    });

    it("groups tasks by model and computes stats", () => {
      const tasks = [
        makeTaskMemory("success", "2025-01-01T00:00:00Z", 1000, "haiku"),
        makeTaskMemory("success", "2025-01-02T00:00:00Z", 2000, "haiku"),
        makeTaskMemory("failure", "2025-01-03T00:00:00Z", 1500, "haiku"),
        makeTaskMemory("success", "2025-01-04T00:00:00Z", 5000, "opus"),
      ];

      const report = lb.modelEfficiency(tasks);

      const haikuEntry = report.models.find((m) => m.model === "haiku")!;
      const opusEntry = report.models.find((m) => m.model === "opus")!;

      expect(haikuEntry.totalTasks).toBe(3);
      expect(haikuEntry.successfulTasks).toBe(2);
      expect(haikuEntry.avgTokens).toBe(Math.round((1000 + 2000 + 1500) / 3));

      expect(opusEntry.totalTasks).toBe(1);
      expect(opusEntry.successfulTasks).toBe(1);
    });

    it("haiku is more efficient than opus (lower costPerSuccess)", () => {
      const tasks = [
        makeTaskMemory("success", "2025-01-01T00:00:00Z", 1000, "haiku"),
        makeTaskMemory("success", "2025-01-02T00:00:00Z", 1000, "opus"),
      ];

      const report = lb.modelEfficiency(tasks);
      const haiku = report.models.find((m) => m.model === "haiku")!;
      const opus = report.models.find((m) => m.model === "opus")!;

      expect(haiku.costPerSuccess).toBeLessThan(opus.costPerSuccess);
    });

    it("mostEfficient is the model with lowest costPerSuccess", () => {
      const tasks = [
        makeTaskMemory("success", "2025-01-01T00:00:00Z", 1000, "haiku"),
        makeTaskMemory("success", "2025-01-02T00:00:00Z", 5000, "opus"),
      ];

      const report = lb.modelEfficiency(tasks);
      expect(report.mostEfficient).toBe("haiku");
    });

    it("handles tasks with no model (defaults to unknown)", () => {
      const tasks = [makeTaskMemory("success", "2025-01-01T00:00:00Z", 1000)];
      const report = lb.modelEfficiency(tasks);
      expect(report.models[0].model).toBe("unknown");
    });

    it("costPerSuccess is Infinity when there are no successful tasks", () => {
      const tasks = [makeTaskMemory("failure", "2025-01-01T00:00:00Z", 1000, "sonnet")];
      const report = lb.modelEfficiency(tasks);
      expect(report.models[0].costPerSuccess).toBe(Infinity);
    });

    it("sorts models by costPerSuccess ascending", () => {
      const tasks = [
        makeTaskMemory("success", "2025-01-01T00:00:00Z", 10000, "opus"),
        makeTaskMemory("success", "2025-01-02T00:00:00Z", 1000, "haiku"),
        makeTaskMemory("success", "2025-01-03T00:00:00Z", 3000, "sonnet"),
      ];

      const report = lb.modelEfficiency(tasks);
      const costs = report.models.map((m) => m.costPerSuccess);
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1]);
      }
    });
  });
});
