/**
 * tests/analytics/agent-scorecard.test.ts
 *
 * Tests for buildScorecard, buildLeaderboard, and exportScorecard.
 */

import { describe, it, expect } from "vitest";
import {
  buildScorecard,
  buildLeaderboard,
  exportScorecard,
  type AgentScorecard,
} from "../../src/analytics/agent-scorecard.js";
import type {
  AgentCareerRecord,
  TaskMemory,
  SkillProfile,
  PerformanceMetrics,
  CareerEvent,
} from "../../src/types/lifecycle.js";
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

function makeSkillProfile(
  agentId: string,
  skills: Record<string, { level: number; exerciseCount: number }> = {},
): SkillProfile {
  const result: SkillProfile["skills"] = {};
  for (const [name, { level, exerciseCount }] of Object.entries(skills)) {
    result[name] = {
      name,
      level,
      exerciseCount,
      successRate: 0.8,
      lastExercised: new Date().toISOString(),
      unlockedCapabilities: [],
    };
  }
  return { agentId, skills: result };
}

function makeCareerRecord(
  agentId: string,
  overrides: Partial<AgentCareerRecord> = {},
): AgentCareerRecord {
  return {
    agentId,
    hiredAt: "2025-01-01T00:00:00Z",
    currentTeam: "backend-team",
    currentRole: "specialist",
    seniority: "mid",
    autonomyTier: AutonomyTier.Supervised,
    skillProfile: makeSkillProfile(agentId),
    taskHistory: [],
    careerEvents: [],
    performanceMetrics: makeMetrics(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildScorecard", () => {
  // ── Return shape ────────────────────────────────────────────────────────────

  describe("return shape", () => {
    it("returns an object with all required top-level keys", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), []);
      expect(sc).toHaveProperty("agentId");
      expect(sc).toHaveProperty("name");
      expect(sc).toHaveProperty("model");
      expect(sc).toHaveProperty("seniority");
      expect(sc).toHaveProperty("team");
      expect(sc).toHaveProperty("metrics");
      expect(sc).toHaveProperty("skills");
      expect(sc).toHaveProperty("careerEvents");
      expect(sc).toHaveProperty("recentTasks");
    });

    it("metrics has all required sub-keys", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), []);
      expect(sc.metrics).toHaveProperty("totalRuns");
      expect(sc.metrics).toHaveProperty("successRate");
      expect(sc.metrics).toHaveProperty("avgTokensPerRun");
      expect(sc.metrics).toHaveProperty("avgCostPerRun");
      expect(sc.metrics).toHaveProperty("avgDurationMs");
    });

    it("skills is an array with expected shape", () => {
      const career = makeCareerRecord("agent-1", {
        skillProfile: makeSkillProfile("agent-1", { typescript: { level: 3, exerciseCount: 20 } }),
      });
      const sc = buildScorecard("agent-1", career, []);
      expect(Array.isArray(sc.skills)).toBe(true);
      if (sc.skills.length > 0) {
        expect(sc.skills[0]).toHaveProperty("name");
        expect(sc.skills[0]).toHaveProperty("level");
        expect(sc.skills[0]).toHaveProperty("exerciseCount");
      }
    });
  });

  // ── Identity fields ─────────────────────────────────────────────────────────

  describe("identity fields", () => {
    it("uses agentId from first argument", () => {
      const sc = buildScorecard("my-agent-42", makeCareerRecord("my-agent-42"), []);
      expect(sc.agentId).toBe("my-agent-42");
    });

    it("uses provided name from agentMeta", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), [], {
        name: "Senior Coder",
      });
      expect(sc.name).toBe("Senior Coder");
    });

    it("falls back to agentId when name not in meta", () => {
      const sc = buildScorecard("fallback-agent", makeCareerRecord("fallback-agent"), []);
      expect(sc.name).toBe("fallback-agent");
    });

    it("uses model from agentMeta", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), [], {
        model: "opus",
      });
      expect(sc.model).toBe("opus");
    });

    it("uses seniority from agentMeta", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), [], {
        seniority: "senior",
      });
      expect(sc.seniority).toBe("senior");
    });

    it("uses team from agentMeta", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), [], {
        team: "qa-team",
      });
      expect(sc.team).toBe("qa-team");
    });

    it("falls back to careerRecord.currentTeam when agentMeta.team not provided", () => {
      const career = makeCareerRecord("agent-1", { currentTeam: "data-team" });
      const sc = buildScorecard("agent-1", career, []);
      expect(sc.team).toBe("data-team");
    });
  });

  // ── Metrics computation ─────────────────────────────────────────────────────

  describe("metrics computation", () => {
    it("totalRuns equals the length of taskMemories", () => {
      const memories = [makeMemory(), makeMemory(), makeMemory()];
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), memories);
      expect(sc.metrics.totalRuns).toBe(3);
    });

    it("totalRuns is 0 when no memories", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), []);
      expect(sc.metrics.totalRuns).toBe(0);
    });

    it("successRate is correct ratio of successful tasks", () => {
      const memories = [
        makeMemory({ outcome: "success" }),
        makeMemory({ outcome: "success" }),
        makeMemory({ outcome: "failure" }),
        makeMemory({ outcome: "success" }),
      ];
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), memories);
      expect(sc.metrics.successRate).toBeCloseTo(0.75);
    });

    it("successRate is 0 when all tasks fail", () => {
      const memories = [makeMemory({ outcome: "failure" }), makeMemory({ outcome: "failure" })];
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), memories);
      expect(sc.metrics.successRate).toBe(0);
    });

    it("successRate is 1 when all tasks succeed", () => {
      const memories = [makeMemory({ outcome: "success" }), makeMemory({ outcome: "success" })];
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), memories);
      expect(sc.metrics.successRate).toBe(1);
    });

    it("avgTokensPerRun is average of tokensUsed across memories", () => {
      const memories = [
        makeMemory({ tokensUsed: 100 }),
        makeMemory({ tokensUsed: 300 }),
      ];
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), memories);
      expect(sc.metrics.avgTokensPerRun).toBe(200);
    });

    it("avgTokensPerRun is 0 with no memories", () => {
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), []);
      expect(sc.metrics.avgTokensPerRun).toBe(0);
    });

    it("avgCostPerRun is positive when tokens > 0", () => {
      const memories = [makeMemory({ tokensUsed: 10000 })];
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), memories, {
        model: "sonnet",
      });
      expect(sc.metrics.avgCostPerRun).toBeGreaterThan(0);
    });

    it("avgDurationMs comes from careerRecord performanceMetrics", () => {
      const career = makeCareerRecord("agent-1", {
        performanceMetrics: makeMetrics({ avgTaskDuration: 12500 }),
      });
      const sc = buildScorecard("agent-1", career, []);
      expect(sc.metrics.avgDurationMs).toBe(12500);
    });
  });

  // ── Skills ─────────────────────────────────────────────────────────────────

  describe("skills mapping", () => {
    it("maps skills from skillProfile correctly", () => {
      const career = makeCareerRecord("agent-1", {
        skillProfile: makeSkillProfile("agent-1", {
          typescript: { level: 4, exerciseCount: 35 },
          testing: { level: 2, exerciseCount: 10 },
        }),
      });
      const sc = buildScorecard("agent-1", career, []);
      expect(sc.skills.length).toBe(2);
      const ts = sc.skills.find((s) => s.name === "typescript");
      expect(ts?.level).toBe(4);
      expect(ts?.exerciseCount).toBe(35);
    });

    it("returns empty skills array when no skills in profile", () => {
      const career = makeCareerRecord("agent-1", {
        skillProfile: makeSkillProfile("agent-1"),
      });
      const sc = buildScorecard("agent-1", career, []);
      expect(sc.skills).toHaveLength(0);
    });
  });

  // ── Career events ──────────────────────────────────────────────────────────

  describe("career events", () => {
    it("maps career events to compact shape", () => {
      const events: CareerEvent[] = [
        {
          id: "e1",
          agentId: "agent-1",
          eventType: "promoted",
          details: { newSeniority: "senior" },
          timestamp: "2026-01-01T00:00:00Z",
        },
      ];
      const career = makeCareerRecord("agent-1", { careerEvents: events });
      const sc = buildScorecard("agent-1", career, []);
      expect(sc.careerEvents.length).toBe(1);
      expect(sc.careerEvents[0].type).toBe("promoted");
      expect(sc.careerEvents[0].timestamp).toBe("2026-01-01T00:00:00Z");
    });

    it("limits career events to last 20", () => {
      const events: CareerEvent[] = Array.from({ length: 30 }, (_, i) => ({
        id: `e${i}`,
        agentId: "agent-1",
        eventType: "trained" as const,
        details: {},
        timestamp: new Date(i * 1000).toISOString(),
      }));
      const career = makeCareerRecord("agent-1", { careerEvents: events });
      const sc = buildScorecard("agent-1", career, []);
      expect(sc.careerEvents.length).toBeLessThanOrEqual(20);
    });
  });

  // ── Recent tasks ────────────────────────────────────────────────────────────

  describe("recentTasks", () => {
    it("includes last 10 task memories in reverse-chronological order", () => {
      const memories = Array.from({ length: 15 }, (_, i) =>
        makeMemory({ taskId: `task-${i}` }),
      );
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), memories);
      expect(sc.recentTasks.length).toBe(10);
    });

    it("includes taskId, outcome, and timestamp in each recentTask", () => {
      const memory = makeMemory({ taskId: "specific-task" });
      const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), [memory]);
      expect(sc.recentTasks[0].taskId).toBe("specific-task");
      expect(sc.recentTasks[0].outcome).toBe("success");
      expect(sc.recentTasks[0].timestamp).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// buildLeaderboard
// ---------------------------------------------------------------------------

describe("buildLeaderboard", () => {
  it("returns an empty array when no scorecards provided", () => {
    const result = buildLeaderboard([]);
    expect(result).toHaveLength(0);
  });

  it("returns one entry per scorecard", () => {
    const sc1 = buildScorecard("agent-a", makeCareerRecord("agent-a"), []);
    const sc2 = buildScorecard("agent-b", makeCareerRecord("agent-b"), []);
    const result = buildLeaderboard([sc1, sc2]);
    expect(result).toHaveLength(2);
  });

  it("each entry has rank, agentId, and compositeScore", () => {
    const memories = [makeMemory({ outcome: "success" }), makeMemory({ outcome: "success" })];
    const sc = buildScorecard("agent-a", makeCareerRecord("agent-a"), memories);
    const result = buildLeaderboard([sc]);
    expect(result[0]).toHaveProperty("rank");
    expect(result[0]).toHaveProperty("agentId");
    expect(result[0]).toHaveProperty("compositeScore");
  });

  it("ranks agents by compositeScore descending (highest first)", () => {
    // High performer: many successful tasks
    const highMemories = Array.from({ length: 20 }, () =>
      makeMemory({ outcome: "success", tokensUsed: 100 }),
    );
    const highCareer = makeCareerRecord("high-agent", {
      performanceMetrics: makeMetrics({ tasksCompleted: 20, successRate: 1.0, peerReviewScore: 0.95 }),
      skillProfile: makeSkillProfile("high-agent", {
        typescript: { level: 4, exerciseCount: 30 },
        testing: { level: 3, exerciseCount: 20 },
      }),
    });

    // Low performer: no tasks
    const lowCareer = makeCareerRecord("low-agent", {
      performanceMetrics: makeMetrics({ tasksCompleted: 0, successRate: 0, peerReviewScore: 0 }),
    });

    const highSc = buildScorecard("high-agent", highCareer, highMemories);
    const lowSc = buildScorecard("low-agent", lowCareer, []);
    const result = buildLeaderboard([lowSc, highSc]);

    // High agent should rank #1
    const highEntry = result.find((e) => e.agentId === "high-agent");
    const lowEntry = result.find((e) => e.agentId === "low-agent");
    expect(highEntry?.rank).toBeLessThanOrEqual(lowEntry?.rank ?? 999);
  });

  it("rank 1 is assigned to the top scorer", () => {
    const memories = Array.from({ length: 5 }, () => makeMemory({ outcome: "success" }));
    const sc = buildScorecard("solo-agent", makeCareerRecord("solo-agent"), memories);
    const result = buildLeaderboard([sc]);
    expect(result[0].rank).toBe(1);
  });

  it("compositeScore is between 0 and 100", () => {
    const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), [makeMemory()]);
    const result = buildLeaderboard([sc]);
    expect(result[0].compositeScore).toBeGreaterThanOrEqual(0);
    expect(result[0].compositeScore).toBeLessThanOrEqual(100);
  });

  it("each entry includes a breakdown object", () => {
    const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), []);
    const result = buildLeaderboard([sc]);
    expect(result[0]).toHaveProperty("breakdown");
    expect(result[0].breakdown).toHaveProperty("successRate");
    expect(result[0].breakdown).toHaveProperty("taskVolume");
    expect(result[0].breakdown).toHaveProperty("skillBreadth");
    expect(result[0].breakdown).toHaveProperty("peerScore");
  });
});

// ---------------------------------------------------------------------------
// exportScorecard
// ---------------------------------------------------------------------------

describe("exportScorecard", () => {
  it("returns a valid JSON string", () => {
    const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), []);
    const json = exportScorecard(sc);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("the parsed object matches the original scorecard", () => {
    const sc = buildScorecard("export-test", makeCareerRecord("export-test"), [
      makeMemory({ taskId: "t1", outcome: "success" }),
    ]);
    const parsed: AgentScorecard = JSON.parse(exportScorecard(sc));
    expect(parsed.agentId).toBe("export-test");
    expect(parsed.metrics.totalRuns).toBe(1);
    expect(parsed.recentTasks[0].taskId).toBe("t1");
  });

  it("exported JSON is pretty-printed (contains newlines)", () => {
    const sc = buildScorecard("agent-1", makeCareerRecord("agent-1"), []);
    const json = exportScorecard(sc);
    expect(json).toContain("\n");
  });
});
