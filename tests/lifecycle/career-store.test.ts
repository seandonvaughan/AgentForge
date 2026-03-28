import { describe, it, expect, beforeEach } from "vitest";
import { CareerStore } from "../../src/lifecycle/career-store.js";
import type { TaskMemory, KnowledgeEntry } from "../../src/types/lifecycle.js";
import { SKILL_LEVEL_THRESHOLDS } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTaskMemory(overrides: Partial<TaskMemory> = {}): TaskMemory {
  return {
    taskId: "task-001",
    timestamp: new Date().toISOString(),
    objective: "Implement user authentication",
    approach: "JWT-based stateless auth",
    outcome: "success",
    lessonsLearned: ["Always validate tokens server-side"],
    filesModified: ["src/auth.ts"],
    collaborators: [],
    difficulty: 3,
    tokensUsed: 1500,
    ...overrides,
  };
}

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: "k-001",
    teamId: "backend-team",
    category: "pattern",
    content: "Use repository pattern for data access",
    source: "agent-architect",
    confidence: 0.9,
    references: [],
    createdAt: new Date().toISOString(),
    lastValidated: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CareerStore", () => {
  let store: CareerStore;

  beforeEach(() => {
    store = new CareerStore();
  });

  // -------------------------------------------------------------------------
  // § 1 — recordTaskOutcome() / getTaskHistory()
  // -------------------------------------------------------------------------

  describe("recordTaskOutcome()", () => {
    it("stores a memory and it is retrievable via getTaskHistory()", () => {
      const mem = makeTaskMemory({ taskId: "task-store-1" });
      store.recordTaskOutcome("agent-001", mem);

      const history = store.getTaskHistory("agent-001");
      expect(history).toHaveLength(1);
      expect(history[0].taskId).toBe("task-store-1");
    });

    it("appends multiple memories in order", () => {
      store.recordTaskOutcome("agent-001", makeTaskMemory({ taskId: "t1" }));
      store.recordTaskOutcome("agent-001", makeTaskMemory({ taskId: "t2" }));
      store.recordTaskOutcome("agent-001", makeTaskMemory({ taskId: "t3" }));

      const history = store.getTaskHistory("agent-001");
      expect(history).toHaveLength(3);
      expect(history[0].taskId).toBe("t1");
      expect(history[1].taskId).toBe("t2");
      expect(history[2].taskId).toBe("t3");
    });

    it("does not mix histories between agents", () => {
      store.recordTaskOutcome("agent-a", makeTaskMemory({ taskId: "task-a" }));
      store.recordTaskOutcome("agent-b", makeTaskMemory({ taskId: "task-b" }));

      expect(store.getTaskHistory("agent-a")).toHaveLength(1);
      expect(store.getTaskHistory("agent-b")).toHaveLength(1);
      expect(store.getTaskHistory("agent-a")[0].taskId).toBe("task-a");
    });

    it("caps at 50 memories, keeping the most recent", () => {
      for (let i = 0; i < 55; i++) {
        store.recordTaskOutcome("agent-cap", makeTaskMemory({ taskId: `task-${i}` }));
      }

      const history = store.getTaskHistory("agent-cap");
      expect(history).toHaveLength(50);
      // Oldest entries are evicted; last recorded should be present
      expect(history[history.length - 1].taskId).toBe("task-54");
    });
  });

  describe("getTaskHistory()", () => {
    it("returns an empty array for an agent with no history", () => {
      expect(store.getTaskHistory("no-history")).toEqual([]);
    });

    it("returns all memories when no limit is specified", () => {
      store.recordTaskOutcome("agent-001", makeTaskMemory({ taskId: "t1" }));
      store.recordTaskOutcome("agent-001", makeTaskMemory({ taskId: "t2" }));
      store.recordTaskOutcome("agent-001", makeTaskMemory({ taskId: "t3" }));

      expect(store.getTaskHistory("agent-001")).toHaveLength(3);
    });

    it("respects the limit parameter — returns the most recent N", () => {
      for (let i = 0; i < 10; i++) {
        store.recordTaskOutcome("agent-lim", makeTaskMemory({ taskId: `t-${i}` }));
      }

      const recent = store.getTaskHistory("agent-lim", 3);
      expect(recent).toHaveLength(3);
      expect(recent[recent.length - 1].taskId).toBe("t-9");
    });

    it("returns all memories when limit exceeds history length", () => {
      store.recordTaskOutcome("agent-few", makeTaskMemory({ taskId: "only-one" }));

      const result = store.getTaskHistory("agent-few", 100);
      expect(result).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // § 2 — recordSkillExercise()
  // -------------------------------------------------------------------------

  describe("recordSkillExercise()", () => {
    it("creates a skill entry on first exercise", () => {
      const skill = store.recordSkillExercise("agent-001", "typescript", true);

      expect(skill.name).toBe("typescript");
      expect(skill.exerciseCount).toBe(1);
    });

    it("increments exerciseCount on each call", () => {
      store.recordSkillExercise("agent-001", "typescript", true);
      store.recordSkillExercise("agent-001", "typescript", true);
      const skill = store.recordSkillExercise("agent-001", "typescript", false);

      expect(skill.exerciseCount).toBe(3);
    });

    it("updates success rate as a running average", () => {
      // 2 successes out of 2 = 1.0
      store.recordSkillExercise("agent-sr", "ts", true);
      const result = store.recordSkillExercise("agent-sr", "ts", true);

      expect(result.successRate).toBeCloseTo(1.0);
    });

    it("reflects failures in the success rate", () => {
      // 1 success, 1 failure = 0.5
      store.recordSkillExercise("agent-sr2", "ts", true);
      const result = store.recordSkillExercise("agent-sr2", "ts", false);

      expect(result.successRate).toBeCloseTo(0.5);
    });

    it("tracks different skills independently", () => {
      store.recordSkillExercise("agent-multi", "ts", true);
      store.recordSkillExercise("agent-multi", "sql", false);

      const ts = store.getSkillLevel("agent-multi", "ts")!;
      const sql = store.getSkillLevel("agent-multi", "sql")!;

      expect(ts.exerciseCount).toBe(1);
      expect(sql.exerciseCount).toBe(1);
      expect(ts.successRate).toBe(1.0);
      expect(sql.successRate).toBe(0.0);
    });

    it("starts skills at level 1", () => {
      const skill = store.recordSkillExercise("agent-lvl", "go", true);
      expect(skill.level).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // § 3 — evaluateSkillLevelUp()
  // -------------------------------------------------------------------------

  describe("evaluateSkillLevelUp()", () => {
    it("promotes skill to level 2 when threshold is met (5+ exercises, >70% success)", () => {
      const threshold = SKILL_LEVEL_THRESHOLDS[2];
      // Exercise exactly at threshold: minExercises successes
      for (let i = 0; i < threshold.minExercises; i++) {
        store.recordSkillExercise("agent-lup", "rust", true);
      }

      // After the last successful exercise, level-up should have triggered
      const skill = store.getSkillLevel("agent-lup", "rust")!;
      expect(skill.level).toBe(2);
    });

    it("does not promote when exercise count is below threshold", () => {
      // Only 3 exercises — below the level-2 threshold of 5
      store.recordSkillExercise("agent-no-lup", "python", true);
      store.recordSkillExercise("agent-no-lup", "python", true);
      store.recordSkillExercise("agent-no-lup", "python", true);

      const { leveledUp } = store.evaluateSkillLevelUp("agent-no-lup", "python");
      expect(leveledUp).toBe(false);
    });

    it("does not promote when success rate is below threshold (even with enough exercises)", () => {
      const threshold = SKILL_LEVEL_THRESHOLDS[2];
      // Exercise enough times but with low success rate (50%)
      for (let i = 0; i < threshold.minExercises * 2; i++) {
        store.recordSkillExercise("agent-low-sr", "c", i % 2 === 0);
      }

      // Success rate ~= 0.5, below 0.70 threshold
      const skill = store.getSkillLevel("agent-low-sr", "c")!;
      expect(skill.level).toBe(1);
    });

    it("returns leveledUp: false for an agent with no skill profile", () => {
      const result = store.evaluateSkillLevelUp("ghost-agent", "skill");
      expect(result.leveledUp).toBe(false);
      expect(result.newLevel).toBe(1);
    });

    it("returns leveledUp: false for an unknown skill on an existing agent", () => {
      store.recordSkillExercise("agent-known", "ts", true);

      const result = store.evaluateSkillLevelUp("agent-known", "unknown-skill");
      expect(result.leveledUp).toBe(false);
    });

    it("does not promote beyond level 5", () => {
      // Manually set a skill to level 5 by forcing many successful exercises
      // We exercise the skill far beyond all thresholds
      for (let i = 0; i < 60; i++) {
        store.recordSkillExercise("agent-max", "godmode", true);
      }

      // Even if already at a high level, must not exceed 5
      const skill = store.getSkillLevel("agent-max", "godmode")!;
      expect(skill.level).toBeLessThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  // § 4 — addKnowledge() / getTeamKnowledge()
  // -------------------------------------------------------------------------

  describe("addKnowledge()", () => {
    it("stores the knowledge entry", () => {
      const entry = makeKnowledgeEntry({ id: "k-add-1", teamId: "alpha-team" });
      store.addKnowledge(entry);

      const knowledge = store.getTeamKnowledge("alpha-team");
      expect(knowledge.some((k) => k.id === "k-add-1")).toBe(true);
    });

    it("allows adding multiple entries for the same team", () => {
      store.addKnowledge(makeKnowledgeEntry({ id: "k1", teamId: "beta-team", confidence: 0.9 }));
      store.addKnowledge(makeKnowledgeEntry({ id: "k2", teamId: "beta-team", confidence: 0.8 }));
      store.addKnowledge(makeKnowledgeEntry({ id: "k3", teamId: "beta-team", confidence: 0.7 }));

      const knowledge = store.getTeamKnowledge("beta-team");
      expect(knowledge).toHaveLength(3);
    });
  });

  describe("getTeamKnowledge()", () => {
    it("returns entries with confidence > 0.3", () => {
      store.addKnowledge(makeKnowledgeEntry({ id: "high", teamId: "team-k", confidence: 0.8 }));
      store.addKnowledge(makeKnowledgeEntry({ id: "low", teamId: "team-k", confidence: 0.1 }));
      store.addKnowledge(makeKnowledgeEntry({ id: "border", teamId: "team-k", confidence: 0.3 }));

      const knowledge = store.getTeamKnowledge("team-k");
      const ids = knowledge.map((k) => k.id);
      expect(ids).toContain("high");
      expect(ids).not.toContain("low");
      expect(ids).not.toContain("border"); // exactly 0.3 is NOT > 0.3
    });

    it("returns empty array for a team with no knowledge", () => {
      expect(store.getTeamKnowledge("unknown-team")).toEqual([]);
    });

    it("does not mix entries between teams", () => {
      store.addKnowledge(makeKnowledgeEntry({ id: "t1-entry", teamId: "team-1", confidence: 0.9 }));
      store.addKnowledge(makeKnowledgeEntry({ id: "t2-entry", teamId: "team-2", confidence: 0.9 }));

      const t1Knowledge = store.getTeamKnowledge("team-1");
      expect(t1Knowledge).toHaveLength(1);
      expect(t1Knowledge[0].id).toBe("t1-entry");
    });
  });

  // -------------------------------------------------------------------------
  // § 5 — decayStaleKnowledge()
  // -------------------------------------------------------------------------

  describe("decayStaleKnowledge()", () => {
    it("reduces confidence of entries last validated more than 30 days ago", () => {
      const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      store.addKnowledge(
        makeKnowledgeEntry({
          id: "stale-1",
          teamId: "decay-team",
          confidence: 1.0,
          lastValidated: staleDate,
        }),
      );

      store.decayStaleKnowledge("decay-team");

      const knowledge = store.getTeamKnowledge("decay-team");
      const entry = knowledge.find((k) => k.id === "stale-1");
      expect(entry!.confidence).toBeLessThan(1.0);
    });

    it("does not decay entries validated within the last 30 days", () => {
      const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      store.addKnowledge(
        makeKnowledgeEntry({
          id: "fresh-1",
          teamId: "fresh-team",
          confidence: 0.9,
          lastValidated: freshDate,
        }),
      );

      store.decayStaleKnowledge("fresh-team");

      const knowledge = store.getTeamKnowledge("fresh-team");
      const entry = knowledge.find((k) => k.id === "fresh-1");
      expect(entry!.confidence).toBe(0.9);
    });

    it("returns the count of decayed entries", () => {
      const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      store.addKnowledge(makeKnowledgeEntry({ id: "s1", teamId: "count-team", confidence: 0.9, lastValidated: staleDate }));
      store.addKnowledge(makeKnowledgeEntry({ id: "s2", teamId: "count-team", confidence: 0.8, lastValidated: staleDate }));
      // Add a fresh entry
      store.addKnowledge(makeKnowledgeEntry({ id: "s3", teamId: "count-team", confidence: 0.7, lastValidated: new Date().toISOString() }));

      const decayed = store.decayStaleKnowledge("count-team");
      expect(decayed).toBe(2);
    });

    it("uses the provided decay rate", () => {
      const staleDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
      store.addKnowledge(
        makeKnowledgeEntry({
          id: "decay-rate-entry",
          teamId: "rate-team",
          confidence: 1.0,
          lastValidated: staleDate,
        }),
      );

      store.decayStaleKnowledge("rate-team", 0.2);

      const knowledge = store.getTeamKnowledge("rate-team");
      const entry = knowledge.find((k) => k.id === "decay-rate-entry");
      expect(entry!.confidence).toBeCloseTo(0.8); // 1.0 * (1 - 0.2)
    });
  });

  // -------------------------------------------------------------------------
  // § 6 — postTaskHook()
  // -------------------------------------------------------------------------

  describe("postTaskHook()", () => {
    it("creates a task memory with the correct outcome (success)", () => {
      const result = store.postTaskHook("agent-ph", {
        taskId: "ph-task-1",
        success: true,
        summary: "Implemented new feature",
      });

      expect(result.taskMemory).toBeDefined();
      expect(result.taskMemory.taskId).toBe("ph-task-1");
      expect(result.taskMemory.outcome).toBe("success");
    });

    it("creates a task memory with outcome 'failure' when success is false", () => {
      const result = store.postTaskHook("agent-ph-fail", {
        taskId: "ph-fail-1",
        success: false,
        summary: "Attempted and failed",
      });

      expect(result.taskMemory.outcome).toBe("failure");
    });

    it("records the task memory in the agent's history", () => {
      store.postTaskHook("agent-ph2", {
        taskId: "ph-2",
        success: true,
        summary: "Done",
      });

      const history = store.getTaskHistory("agent-ph2");
      expect(history).toHaveLength(1);
      expect(history[0].taskId).toBe("ph-2");
    });

    it("exercises the provided skills", () => {
      store.postTaskHook("agent-skills", {
        taskId: "skill-task",
        success: true,
        summary: "Built API",
        skills: ["typescript", "rest-api"],
      });

      expect(store.getSkillLevel("agent-skills", "typescript")).not.toBeNull();
      expect(store.getSkillLevel("agent-skills", "rest-api")).not.toBeNull();
    });

    it("reports level-ups for skills that reach the threshold", () => {
      const threshold = SKILL_LEVEL_THRESHOLDS[2];

      // Exercise the skill enough times to meet the level-2 threshold
      for (let i = 0; i < threshold.minExercises - 1; i++) {
        store.postTaskHook(`agent-lu`, {
          taskId: `pre-task-${i}`,
          success: true,
          summary: `pre-task`,
          skills: ["test-skill"],
        });
      }

      // The final exercise that triggers the level-up
      const result = store.postTaskHook("agent-lu", {
        taskId: "final-task",
        success: true,
        summary: "Level up task",
        skills: ["test-skill"],
      });

      expect(result.skillLevelUps.some((lu) => lu.skill === "test-skill")).toBe(true);
    });

    it("returns an empty skillLevelUps array when no skills are provided", () => {
      const result = store.postTaskHook("agent-no-skills", {
        taskId: "no-skills-task",
        success: true,
        summary: "No skills",
      });

      expect(result.skillLevelUps).toEqual([]);
    });

    it("stores filesModified in the task memory", () => {
      const result = store.postTaskHook("agent-files", {
        taskId: "file-task",
        success: true,
        summary: "Modified files",
        filesModified: ["src/main.ts", "src/utils.ts"],
      });

      expect(result.taskMemory.filesModified).toEqual(["src/main.ts", "src/utils.ts"]);
    });

    it("stores tokensUsed in the task memory", () => {
      const result = store.postTaskHook("agent-tokens", {
        taskId: "token-task",
        success: true,
        summary: "Used tokens",
        tokensUsed: 2500,
      });

      expect(result.taskMemory.tokensUsed).toBe(2500);
    });
  });
});
