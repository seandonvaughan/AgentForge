/**
 * tests/lifecycle/skill-gap-analyzer.test.ts
 *
 * Tests for SkillGapAnalyzer — Sprint v6.2 P2-1.
 * All tests are in-memory, no DB required.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SkillGapAnalyzer } from "../../src/lifecycle/skill-gap-analyzer.js";
import type { SkillGapReport } from "../../src/lifecycle/skill-gap-analyzer.js";
import type { SkillProfile, SkillLevel } from "../../src/types/lifecycle.js";
import { SKILL_LEVEL_THRESHOLDS } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkillLevel(level: number, overrides: Partial<SkillLevel> = {}): SkillLevel {
  return {
    name: "skill",
    level,
    exerciseCount: 20,
    successRate: 0.85,
    lastExercised: new Date().toISOString(),
    unlockedCapabilities: [],
    ...overrides,
  };
}

function makeProfile(
  agentId: string,
  skills: Record<string, number>,
): SkillProfile {
  const skillMap: Record<string, SkillLevel> = {};
  for (const [name, level] of Object.entries(skills)) {
    skillMap[name] = makeSkillLevel(level, { name });
  }
  return { agentId, skills: skillMap };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillGapAnalyzer", () => {
  let analyzer: SkillGapAnalyzer;

  beforeEach(() => {
    analyzer = new SkillGapAnalyzer();
  });

  // -------------------------------------------------------------------------
  // analyzeTeamGaps()
  // -------------------------------------------------------------------------

  describe("analyzeTeamGaps()", () => {
    it("returns 100 readiness when all required skills are covered at or above threshold", () => {
      const profiles = [
        makeProfile("backend-coder-1", { typescript: 4, sql: 3, testing: 3 }),
        makeProfile("backend-coder-2", { typescript: 3, sql: 4, graphql: 3 }),
      ];
      const report = analyzer.analyzeTeamGaps(profiles, ["typescript", "sql", "testing"], 3);

      expect(report.totalSkillsRequired).toBe(3);
      expect(report.skillsCovered).toBe(3);
      expect(report.skillsMissing).toHaveLength(0);
      expect(report.skillsBelowThreshold).toHaveLength(0);
      expect(report.readinessScore).toBe(100);
    });

    it("identifies skills missing entirely from the team", () => {
      const profiles = [
        makeProfile("backend-coder-1", { typescript: 3 }),
      ];
      const report = analyzer.analyzeTeamGaps(profiles, ["typescript", "rust", "go"], 3);

      expect(report.skillsMissing).toContain("rust");
      expect(report.skillsMissing).toContain("go");
      expect(report.skillsMissing).not.toContain("typescript");
      expect(report.skillsCovered).toBe(1);
    });

    it("identifies skills present but below threshold", () => {
      const profiles = [
        makeProfile("backend-coder-1", { typescript: 2, sql: 2 }),
      ];
      const report = analyzer.analyzeTeamGaps(profiles, ["typescript", "sql"], 3);

      expect(report.skillsBelowThreshold).toHaveLength(2);
      expect(report.skillsMissing).toHaveLength(0);
      expect(report.skillsCovered).toBe(0);
      const tsEntry = report.skillsBelowThreshold.find((e) => e.skill === "typescript");
      expect(tsEntry).toBeDefined();
      expect(tsEntry?.currentMaxLevel).toBe(2);
      expect(tsEntry?.required).toBe(3);
      expect(tsEntry?.agents).toContain("backend-coder-1");
    });

    it("uses the highest skill level across agents for coverage check", () => {
      const profiles = [
        makeProfile("backend-coder-1", { typescript: 2 }),
        makeProfile("backend-coder-2", { typescript: 4 }),
      ];
      const report = analyzer.analyzeTeamGaps(profiles, ["typescript"], 3);

      expect(report.skillsCovered).toBe(1);
      expect(report.skillsBelowThreshold).toHaveLength(0);
    });

    it("returns readinessScore 0 when no skills are covered and none present", () => {
      const profiles = [makeProfile("backend-coder-1", {})];
      const report = analyzer.analyzeTeamGaps(profiles, ["typescript", "sql", "rust"], 3);

      expect(report.readinessScore).toBe(0);
      expect(report.skillsMissing).toHaveLength(3);
    });

    it("handles empty profiles array gracefully", () => {
      const report = analyzer.analyzeTeamGaps([], ["typescript"], 3);

      expect(report.teamId).toBe("unknown");
      expect(report.skillsMissing).toContain("typescript");
      expect(report.readinessScore).toBe(0);
    });

    it("handles empty required skills gracefully", () => {
      const profiles = [makeProfile("backend-coder-1", { typescript: 3 })];
      const report = analyzer.analyzeTeamGaps(profiles, [], 3);

      expect(report.totalSkillsRequired).toBe(0);
      expect(report.readinessScore).toBe(100);
    });

    it("respects custom minLevel parameter", () => {
      const profiles = [makeProfile("backend-coder-1", { typescript: 3 })];
      // With minLevel=4, level-3 typescript should be below threshold
      const report = analyzer.analyzeTeamGaps(profiles, ["typescript"], 4);

      expect(report.skillsCovered).toBe(0);
      expect(report.skillsBelowThreshold).toHaveLength(1);
      expect(report.skillsBelowThreshold[0].required).toBe(4);
    });

    it("readinessScore is between 0 and 100 for partial coverage", () => {
      const profiles = [
        makeProfile("backend-coder-1", { typescript: 3, sql: 2 }),
      ];
      const report = analyzer.analyzeTeamGaps(profiles, ["typescript", "sql", "rust"], 3);

      expect(report.readinessScore).toBeGreaterThan(0);
      expect(report.readinessScore).toBeLessThan(100);
    });

    it("includes agents in below-threshold entry", () => {
      const profiles = [
        makeProfile("backend-coder-1", { sql: 2 }),
        makeProfile("backend-coder-2", { sql: 2 }),
      ];
      const report = analyzer.analyzeTeamGaps(profiles, ["sql"], 3);

      const entry = report.skillsBelowThreshold[0];
      expect(entry.agents).toContain("backend-coder-1");
      expect(entry.agents).toContain("backend-coder-2");
    });
  });

  // -------------------------------------------------------------------------
  // generateTrainingPlan()
  // -------------------------------------------------------------------------

  describe("generateTrainingPlan()", () => {
    it("returns high-priority recommendations for missing skills", () => {
      const report: SkillGapReport = {
        teamId: "backend-team",
        totalSkillsRequired: 2,
        skillsCovered: 0,
        skillsMissing: ["rust", "go"],
        skillsBelowThreshold: [],
        readinessScore: 0,
      };

      const plan = analyzer.generateTrainingPlan(report);

      expect(plan.length).toBeGreaterThanOrEqual(2);
      const rustRec = plan.find((r) => r.skill === "rust");
      expect(rustRec).toBeDefined();
      expect(rustRec?.priority).toBe("high");
      expect(rustRec?.currentLevel).toBe(0);
      expect(rustRec?.targetLevel).toBe(3); // default minLevel
    });

    it("returns medium-priority recommendations for skills one level below threshold", () => {
      const report: SkillGapReport = {
        teamId: "backend-team",
        totalSkillsRequired: 1,
        skillsCovered: 0,
        skillsMissing: [],
        skillsBelowThreshold: [
          {
            skill: "typescript",
            currentMaxLevel: 2,
            required: 3,
            agents: ["backend-coder-1"],
          },
        ],
        readinessScore: 33,
      };

      const plan = analyzer.generateTrainingPlan(report);

      expect(plan).toHaveLength(1);
      expect(plan[0].priority).toBe("medium");
      expect(plan[0].agentId).toBe("backend-coder-1");
      expect(plan[0].skill).toBe("typescript");
      expect(plan[0].currentLevel).toBe(2);
      expect(plan[0].targetLevel).toBe(3);
    });

    it("returns high-priority for gap of 2 or more levels", () => {
      const report: SkillGapReport = {
        teamId: "backend-team",
        totalSkillsRequired: 1,
        skillsCovered: 0,
        skillsMissing: [],
        skillsBelowThreshold: [
          {
            skill: "sql",
            currentMaxLevel: 1,
            required: 3,
            agents: ["backend-coder-1"],
          },
        ],
        readinessScore: 17,
      };

      const plan = analyzer.generateTrainingPlan(report);

      expect(plan[0].priority).toBe("high");
    });

    it("exercisesNeeded reflects SKILL_LEVEL_THRESHOLDS for level 2→3", () => {
      const report: SkillGapReport = {
        teamId: "backend-team",
        totalSkillsRequired: 1,
        skillsCovered: 0,
        skillsMissing: [],
        skillsBelowThreshold: [
          {
            skill: "typescript",
            currentMaxLevel: 2,
            required: 3,
            agents: ["backend-coder-1"],
          },
        ],
        readinessScore: 33,
      };

      const plan = analyzer.generateTrainingPlan(report);
      // From level 2 to level 3: SKILL_LEVEL_THRESHOLDS[3].minExercises
      expect(plan[0].exercisesNeeded).toBe(SKILL_LEVEL_THRESHOLDS[3].minExercises);
    });

    it("exercisesNeeded is 0 when already at target level", () => {
      // Empty report — no gaps
      const report: SkillGapReport = {
        teamId: "backend-team",
        totalSkillsRequired: 1,
        skillsCovered: 1,
        skillsMissing: [],
        skillsBelowThreshold: [],
        readinessScore: 100,
      };

      const plan = analyzer.generateTrainingPlan(report);
      expect(plan).toHaveLength(0);
    });

    it("sorts high priority before medium before low", () => {
      const report: SkillGapReport = {
        teamId: "backend-team",
        totalSkillsRequired: 3,
        skillsCovered: 0,
        skillsMissing: ["rust"],
        skillsBelowThreshold: [
          { skill: "sql", currentMaxLevel: 1, required: 3, agents: ["agent-1"] },
          { skill: "typescript", currentMaxLevel: 2, required: 3, agents: ["agent-1"] },
        ],
        readinessScore: 0,
      };

      const plan = analyzer.generateTrainingPlan(report);
      const priorities = plan.map((r) => r.priority);

      const firstLow = priorities.indexOf("low");
      const firstMedium = priorities.indexOf("medium");
      const firstHigh = priorities.indexOf("high");

      // All high entries come before medium or low
      if (firstHigh !== -1 && firstMedium !== -1) {
        expect(firstHigh).toBeLessThan(firstMedium);
      }
      if (firstMedium !== -1 && firstLow !== -1) {
        expect(firstMedium).toBeLessThan(firstLow);
      }
    });
  });

  // -------------------------------------------------------------------------
  // teamReadinessScore()
  // -------------------------------------------------------------------------

  describe("teamReadinessScore()", () => {
    it("returns the readinessScore from the report directly", () => {
      const report: SkillGapReport = {
        teamId: "backend-team",
        totalSkillsRequired: 4,
        skillsCovered: 3,
        skillsMissing: [],
        skillsBelowThreshold: [],
        readinessScore: 75,
      };

      expect(analyzer.teamReadinessScore(report)).toBe(75);
    });

    it("returns 100 for a fully covered team", () => {
      const profiles = [makeProfile("backend-coder-1", { ts: 5, sql: 4, testing: 3 })];
      const report = analyzer.analyzeTeamGaps(profiles, ["ts", "sql", "testing"], 3);
      expect(analyzer.teamReadinessScore(report)).toBe(100);
    });
  });
});
