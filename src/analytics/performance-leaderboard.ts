/**
 * PerformanceLeaderboard — Sprint v6.2 P2-2
 *
 * Ranks agents by composite performance score, computes team velocity
 * over sprint windows, and reports cost-efficiency by model tier.
 */

import type { AgentCareerRecord, TaskMemory } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  agentId: string;
  rank: number;
  /** 0-100 composite score. */
  compositeScore: number;
  breakdown: {
    successRate: number;
    taskVolume: number;
    skillBreadth: number;
    peerScore: number;
  };
}

export interface TeamVelocityReport {
  sprints: Array<{
    sprintDate: string;
    tasksCompleted: number;
    tasksTotal: number;
    velocity: number;
  }>;
  trend: "improving" | "stable" | "declining";
  avgVelocity: number;
}

export interface ModelEfficiencyReport {
  models: Array<{
    model: string;
    totalTasks: number;
    successfulTasks: number;
    avgTokens: number;
    costPerSuccess: number;
  }>;
  mostEfficient: string;
}

// ---------------------------------------------------------------------------
// Cost constants (USD per 1K tokens, approximate)
// ---------------------------------------------------------------------------

const TOKEN_COST_PER_1K: Record<string, number> = {
  opus: 0.015,
  sonnet: 0.003,
  haiku: 0.00025,
};

const DEFAULT_TOKEN_COST = 0.003;

// ---------------------------------------------------------------------------
// PerformanceLeaderboard
// ---------------------------------------------------------------------------

export class PerformanceLeaderboard {
  /**
   * Rank agents by composite performance score.
   *
   * Score = (successRate * 0.4) + (taskVolume * 0.3) + (skillBreadth * 0.2) + (peerScore * 0.1)
   *
   * - taskVolume is normalized: agent's tasks / max tasks across all agents
   * - skillBreadth is normalized: agent's skills at level >= 3 / total distinct skills seen
   */
  rankAgents(careers: AgentCareerRecord[]): LeaderboardEntry[] {
    if (careers.length === 0) return [];

    // Compute raw values for normalization
    const taskCounts = careers.map((c) => c.performanceMetrics.tasksCompleted);
    const maxTasks = Math.max(...taskCounts, 1);

    // Collect all distinct skill names across the entire cohort
    const allSkills = new Set<string>();
    for (const c of careers) {
      for (const skillName of Object.keys(c.skillProfile.skills)) {
        allSkills.add(skillName);
      }
    }
    const totalPossibleSkills = Math.max(allSkills.size, 1);

    // Build scored entries
    const scored = careers.map((career) => {
      const m = career.performanceMetrics;

      const successRate = Math.min(1, Math.max(0, m.successRate)); // 0-1
      const taskVolume = m.tasksCompleted / maxTasks; // normalized 0-1
      const proficientSkills = Object.values(career.skillProfile.skills).filter(
        (s) => s.level >= 3,
      ).length;
      const skillBreadth = proficientSkills / totalPossibleSkills; // normalized 0-1
      const peerScore = Math.min(1, Math.max(0, m.peerReviewScore)); // 0-1

      const composite =
        (successRate * 0.4 +
          taskVolume * 0.3 +
          skillBreadth * 0.2 +
          peerScore * 0.1) *
        100;

      return {
        agentId: career.agentId,
        rank: 0, // filled below
        compositeScore: Math.round(composite * 10) / 10, // 1 decimal
        breakdown: { successRate, taskVolume, skillBreadth, peerScore },
      };
    });

    // Sort descending by composite score
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    // Assign ranks (ties share same rank)
    let currentRank = 1;
    for (let i = 0; i < scored.length; i++) {
      if (i > 0 && scored[i].compositeScore < scored[i - 1].compositeScore) {
        currentRank = i + 1;
      }
      scored[i].rank = currentRank;
    }

    return scored;
  }

  /**
   * Team velocity: tasks completed per sprint over time.
   *
   * @param taskHistories - map of agentId → their TaskMemory array
   * @param sprintDates   - ISO-8601 date strings marking sprint boundaries.
   *                        N dates define N-1 sprint windows: window i spans
   *                        [sprintDates[i], sprintDates[i+1]).
   */
  teamVelocity(
    taskHistories: Map<string, TaskMemory[]>,
    sprintDates: string[],
  ): TeamVelocityReport {
    if (sprintDates.length < 2) {
      return { sprints: [], trend: "stable", avgVelocity: 0 };
    }

    // Flatten all task memories with timestamps
    const allTasks: Array<{ timestamp: string; outcome: TaskMemory["outcome"] }> = [];
    for (const memories of taskHistories.values()) {
      for (const mem of memories) {
        allTasks.push({ timestamp: mem.timestamp, outcome: mem.outcome });
      }
    }

    // Sort sprint dates ascending
    const sortedDates = [...sprintDates].sort();

    const sprintEntries: TeamVelocityReport["sprints"] = [];

    // N dates → N-1 windows
    for (let i = 0; i < sortedDates.length - 1; i++) {
      const sprintStart = sortedDates[i];
      const sprintEnd = sortedDates[i + 1];

      const sprintTasks = allTasks.filter(
        (t) => t.timestamp >= sprintStart && t.timestamp < sprintEnd,
      );

      const tasksTotal = sprintTasks.length;
      const tasksCompleted = sprintTasks.filter(
        (t) => t.outcome === "success" || t.outcome === "partial",
      ).length;
      const velocity = tasksTotal > 0 ? tasksCompleted / tasksTotal : 0;

      sprintEntries.push({
        sprintDate: sprintStart,
        tasksCompleted,
        tasksTotal,
        velocity: Math.round(velocity * 1000) / 1000,
      });
    }

    const avgVelocity =
      sprintEntries.length > 0
        ? sprintEntries.reduce((sum, s) => sum + s.velocity, 0) / sprintEntries.length
        : 0;

    const trend = this._computeTrend(sprintEntries.map((s) => s.velocity));

    return {
      sprints: sprintEntries,
      trend,
      avgVelocity: Math.round(avgVelocity * 1000) / 1000,
    };
  }

  /**
   * Model tier efficiency: cost per successful task by model.
   *
   * Uses tokensUsed from each TaskMemory and maps agentId → model via the
   * model field. Since TaskMemory doesn't carry model info directly, callers
   * should pass all task memories with a model tag injected via the extended
   * type, or rely on a separate lookup. Here we accept a flat list of
   * TaskMemory augmented with an optional `model` field via intersection
   * for flexibility.
   */
  modelEfficiency(
    taskMemories: Array<TaskMemory & { model?: string }>,
  ): ModelEfficiencyReport {
    // Group by model
    const byModel = new Map<string, Array<TaskMemory & { model?: string }>>();

    for (const mem of taskMemories) {
      const model = mem.model ?? "unknown";
      const group = byModel.get(model) ?? [];
      group.push(mem);
      byModel.set(model, group);
    }

    const models: ModelEfficiencyReport["models"] = [];

    for (const [model, tasks] of byModel) {
      const totalTasks = tasks.length;
      const successfulTasks = tasks.filter((t) => t.outcome === "success").length;
      const totalTokens = tasks.reduce((sum, t) => sum + (t.tokensUsed ?? 0), 0);
      const avgTokens = totalTasks > 0 ? totalTokens / totalTasks : 0;

      const costPerToken =
        (TOKEN_COST_PER_1K[model] ?? DEFAULT_TOKEN_COST) / 1000;
      const totalCost = totalTokens * costPerToken;
      const costPerSuccess = successfulTasks > 0 ? totalCost / successfulTasks : Infinity;

      models.push({
        model,
        totalTasks,
        successfulTasks,
        avgTokens: Math.round(avgTokens),
        costPerSuccess: Math.round(costPerSuccess * 100000) / 100000,
      });
    }

    // Sort by costPerSuccess ascending (most efficient first)
    models.sort((a, b) => a.costPerSuccess - b.costPerSuccess);

    const mostEfficient =
      models.length > 0 && isFinite(models[0].costPerSuccess)
        ? models[0].model
        : "unknown";

    return { models, mostEfficient };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine velocity trend from a time-ordered array of velocity values.
   * Uses simple linear regression slope to decide direction.
   */
  private _computeTrend(
    velocities: number[],
  ): "improving" | "stable" | "declining" {
    if (velocities.length < 2) return "stable";

    const n = velocities.length;
    const indices = Array.from({ length: n }, (_, i) => i);
    const meanX = (n - 1) / 2;
    const meanY = velocities.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (indices[i] - meanX) * (velocities[i] - meanY);
      denominator += (indices[i] - meanX) ** 2;
    }

    if (denominator === 0) return "stable";
    const slope = numerator / denominator;

    const THRESHOLD = 0.05; // 5% per sprint
    if (slope > THRESHOLD) return "improving";
    if (slope < -THRESHOLD) return "declining";
    return "stable";
  }
}
