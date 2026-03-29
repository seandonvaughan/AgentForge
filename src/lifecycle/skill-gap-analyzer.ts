/**
 * SkillGapAnalyzer — Sprint v6.2 P2-1
 *
 * Analyzes skill gaps for a team, generates training plans,
 * and computes an overall team readiness score.
 */

import type { SkillProfile } from "../types/lifecycle.js";
import { SKILL_LEVEL_THRESHOLDS } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SkillGapReport {
  /** Team identifier (derived from first profile's agentId prefix, or "unknown"). */
  teamId: string;
  /** Total number of required skills checked. */
  totalSkillsRequired: number;
  /** Number of required skills where at least one agent meets the threshold. */
  skillsCovered: number;
  /** Skills for which NO agent meets the minimum level. */
  skillsMissing: string[];
  /**
   * Skills that are present but where the maximum level across agents is
   * below the required threshold.
   */
  skillsBelowThreshold: Array<{
    skill: string;
    currentMaxLevel: number;
    required: number;
    agents: string[];
  }>;
  /** 0-100 readiness score. */
  readinessScore: number;
}

export interface TrainingRecommendation {
  agentId: string;
  skill: string;
  currentLevel: number;
  targetLevel: number;
  /** Estimated exercises needed to reach targetLevel, derived from SKILL_LEVEL_THRESHOLDS. */
  exercisesNeeded: number;
  priority: "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------
// Default minimum level
// ---------------------------------------------------------------------------

const DEFAULT_MIN_LEVEL = 3; // Proficient

// ---------------------------------------------------------------------------
// SkillGapAnalyzer
// ---------------------------------------------------------------------------

export class SkillGapAnalyzer {
  /**
   * Analyze skill gaps for a team.
   *
   * @param teamSkillProfiles - skill profiles of all team members
   * @param requiredSkills    - skills the team needs (from sprint items, domain config)
   * @param minLevel          - minimum acceptable level (default 3 = Proficient)
   */
  analyzeTeamGaps(
    teamSkillProfiles: SkillProfile[],
    requiredSkills: string[],
    minLevel: number = DEFAULT_MIN_LEVEL,
  ): SkillGapReport {
    const teamId = this._inferTeamId(teamSkillProfiles);

    const skillsMissing: string[] = [];
    const skillsBelowThreshold: SkillGapReport["skillsBelowThreshold"] = [];
    let skillsCovered = 0;

    for (const skill of requiredSkills) {
      const agentsWithSkill: Array<{ agentId: string; level: number }> = [];

      for (const profile of teamSkillProfiles) {
        const skillLevel = profile.skills[skill];
        if (skillLevel) {
          agentsWithSkill.push({ agentId: profile.agentId, level: skillLevel.level });
        }
      }

      if (agentsWithSkill.length === 0) {
        skillsMissing.push(skill);
        continue;
      }

      const maxLevel = Math.max(...agentsWithSkill.map((a) => a.level));

      if (maxLevel >= minLevel) {
        skillsCovered++;
      } else {
        skillsBelowThreshold.push({
          skill,
          currentMaxLevel: maxLevel,
          required: minLevel,
          agents: agentsWithSkill.map((a) => a.agentId),
        });
      }
    }

    const readinessScore = this._computeReadiness(
      requiredSkills.length,
      skillsCovered,
      skillsBelowThreshold,
      minLevel,
    );

    return {
      teamId,
      totalSkillsRequired: requiredSkills.length,
      skillsCovered,
      skillsMissing,
      skillsBelowThreshold,
      readinessScore,
    };
  }

  /**
   * Generate training recommendations from a gap report.
   */
  generateTrainingPlan(report: SkillGapReport): TrainingRecommendation[] {
    const recommendations: TrainingRecommendation[] = [];

    for (const skill of report.skillsMissing) {
      const target = DEFAULT_MIN_LEVEL;
      recommendations.push({
        agentId: "team",
        skill,
        currentLevel: 0,
        targetLevel: target,
        exercisesNeeded: this._exercisesNeeded(0, target),
        priority: "high",
      });
    }

    for (const entry of report.skillsBelowThreshold) {
      for (const agentId of entry.agents) {
        const currentLevel = entry.currentMaxLevel;
        const targetLevel = entry.required;
        const exercisesNeeded = this._exercisesNeeded(currentLevel, targetLevel);
        const gap = targetLevel - currentLevel;
        const priority: TrainingRecommendation["priority"] =
          gap >= 2 ? "high" : gap === 1 ? "medium" : "low";

        recommendations.push({
          agentId,
          skill: entry.skill,
          currentLevel,
          targetLevel,
          exercisesNeeded,
          priority,
        });
      }
    }

    const priorityOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => {
      const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pd !== 0) return pd;
      return b.exercisesNeeded - a.exercisesNeeded;
    });

    return recommendations;
  }

  /**
   * Score overall team readiness (0-100).
   */
  teamReadinessScore(report: SkillGapReport): number {
    return report.readinessScore;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _computeReadiness(
    totalRequired: number,
    covered: number,
    belowThreshold: SkillGapReport["skillsBelowThreshold"],
    minLevel: number,
  ): number {
    if (totalRequired === 0) return 100;

    const coveredFraction = covered / totalRequired;

    let partialBonus = 0;
    for (const entry of belowThreshold) {
      const partialCredit =
        (entry.currentMaxLevel / Math.max(minLevel, 1)) * (0.5 / totalRequired);
      partialBonus += partialCredit;
    }

    const raw = (coveredFraction + partialBonus) * 100;
    return Math.round(Math.min(100, Math.max(0, raw)));
  }

  private _exercisesNeeded(currentLevel: number, targetLevel: number): number {
    if (targetLevel <= currentLevel) return 0;

    let exercises = 0;
    for (let lvl = currentLevel + 1; lvl <= targetLevel; lvl++) {
      const threshold = SKILL_LEVEL_THRESHOLDS[lvl];
      if (threshold) {
        exercises += threshold.minExercises;
      } else {
        exercises += 5;
      }
    }
    return exercises;
  }

  private _inferTeamId(profiles: SkillProfile[]): string {
    if (profiles.length === 0) return "unknown";
    const firstId = profiles[0].agentId;
    const match = /^([a-z]+-[a-z]+)-/.exec(firstId);
    return match ? match[1] + "-team" : "unknown";
  }
}
