/**
 * AgentScorecard — Sprint v6.2 P2-2
 *
 * Builds per-agent performance scorecards from career records and task
 * memories, ranks them using PerformanceLeaderboard, and exports to JSON.
 */

import type {
  AgentCareerRecord,
  TaskMemory,
  SkillLevel,
} from "../types/lifecycle.js";
import {
  PerformanceLeaderboard,
  type LeaderboardEntry,
} from "./performance-leaderboard.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface AgentScorecard {
  agentId: string;
  name: string;
  model: string;
  seniority: string;
  team: string;
  metrics: {
    totalRuns: number;
    successRate: number;
    avgTokensPerRun: number;
    avgCostPerRun: number;
    avgDurationMs: number;
  };
  skills: Array<{ name: string; level: number; exerciseCount: number }>;
  careerEvents: Array<{ type: string; timestamp: string; details: string }>;
  recentTasks: Array<{ taskId: string; outcome: string; timestamp: string }>;
}

export { LeaderboardEntry };

// ---------------------------------------------------------------------------
// Cost constants (USD per token — same as performance-leaderboard)
// ---------------------------------------------------------------------------

const TOKEN_COST_PER_TOKEN: Record<string, number> = {
  opus: 0.015 / 1000,
  sonnet: 0.003 / 1000,
  haiku: 0.00025 / 1000,
};

const DEFAULT_COST_PER_TOKEN = 0.003 / 1000;

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Build a scorecard for a single agent from their career record and task memories.
 *
 * @param agentId      - Unique agent identifier.
 * @param careerRecord - The agent's full AgentCareerRecord (may be partial / minimal).
 * @param taskMemories - Flat array of task memories to use for metric computation.
 * @param agentMeta    - Optional display metadata (name, model, seniority, team).
 */
export function buildScorecard(
  agentId: string,
  careerRecord: AgentCareerRecord,
  taskMemories: TaskMemory[],
  agentMeta?: {
    name?: string;
    model?: string;
    seniority?: string;
    team?: string;
  },
): AgentScorecard {
  const totalRuns = taskMemories.length;

  const successCount = taskMemories.filter(
    (m) => m.outcome === "success",
  ).length;
  const successRate = totalRuns > 0 ? successCount / totalRuns : 0;

  const totalTokens = taskMemories.reduce(
    (sum, m) => sum + (m.tokensUsed ?? 0),
    0,
  );
  const avgTokensPerRun = totalRuns > 0 ? totalTokens / totalRuns : 0;

  // Estimate cost from tokens + model tier
  const model = agentMeta?.model ?? careerRecord.seniority ?? "sonnet";
  const costPerToken =
    TOKEN_COST_PER_TOKEN[model] ?? DEFAULT_COST_PER_TOKEN;
  const totalCost = totalTokens * costPerToken;
  const avgCostPerRun = totalRuns > 0 ? totalCost / totalRuns : 0;

  // avgDurationMs: use careerRecord.performanceMetrics.avgTaskDuration when
  // available, falling back to 0
  const avgDurationMs =
    careerRecord.performanceMetrics?.avgTaskDuration ?? 0;

  // Skills from skill profile
  const skills: AgentScorecard["skills"] = Object.values(
    careerRecord.skillProfile?.skills ?? {},
  ).map((s: SkillLevel) => ({
    name: s.name,
    level: s.level,
    exerciseCount: s.exerciseCount,
  }));

  // Career events — take last 20 for compactness
  const careerEvents: AgentScorecard["careerEvents"] = (
    careerRecord.careerEvents ?? []
  )
    .slice(-20)
    .map((e) => ({
      type: e.eventType,
      timestamp: e.timestamp,
      details:
        typeof e.details === "object"
          ? JSON.stringify(e.details)
          : String(e.details),
    }));

  // Recent tasks — last 10 from taskMemories (most recent first)
  const recentTasks: AgentScorecard["recentTasks"] = taskMemories
    .slice(-10)
    .reverse()
    .map((m) => ({
      taskId: m.taskId,
      outcome: m.outcome,
      timestamp: m.timestamp,
    }));

  return {
    agentId,
    name: agentMeta?.name ?? agentId,
    model,
    seniority: agentMeta?.seniority ?? careerRecord.seniority ?? "mid",
    team: agentMeta?.team ?? careerRecord.currentTeam ?? "unknown",
    metrics: {
      totalRuns,
      successRate: Math.round(successRate * 10000) / 10000,
      avgTokensPerRun: Math.round(avgTokensPerRun),
      avgCostPerRun: Math.round(avgCostPerRun * 1_000_000) / 1_000_000,
      avgDurationMs: Math.round(avgDurationMs),
    },
    skills,
    careerEvents,
    recentTasks,
  };
}

/**
 * Build a ranked leaderboard from an array of scorecards.
 *
 * Converts scorecards → minimal AgentCareerRecord shapes and delegates
 * ranking to PerformanceLeaderboard.rankAgents().
 */
export function buildLeaderboard(
  scorecards: AgentScorecard[],
): LeaderboardEntry[] {
  const leaderboard = new PerformanceLeaderboard();

  // Convert scorecard metrics to AgentCareerRecord shape
  const careers: AgentCareerRecord[] = scorecards.map((sc) => {
    const skills: Record<string, SkillLevel> = {};
    for (const s of sc.skills) {
      skills[s.name] = {
        name: s.name,
        level: s.level,
        exerciseCount: s.exerciseCount,
        successRate: sc.metrics.successRate,
        lastExercised: new Date().toISOString(),
        unlockedCapabilities: [],
      };
    }

    return {
      agentId: sc.agentId,
      hiredAt: new Date().toISOString(),
      currentTeam: sc.team,
      currentRole: "specialist" as const,
      seniority: (sc.seniority as AgentCareerRecord["seniority"]) ?? "mid",
      autonomyTier: 1 as AgentCareerRecord["autonomyTier"],
      skillProfile: { agentId: sc.agentId, skills },
      taskHistory: sc.recentTasks.map((t) => ({
        taskId: t.taskId,
        timestamp: t.timestamp,
        objective: "",
        approach: "",
        outcome: t.outcome as TaskMemory["outcome"],
        lessonsLearned: [],
        filesModified: [],
        collaborators: [],
        difficulty: 3,
        tokensUsed: sc.metrics.avgTokensPerRun,
      })),
      careerEvents: [],
      performanceMetrics: {
        tasksCompleted: sc.metrics.totalRuns,
        successRate: sc.metrics.successRate,
        avgTaskDuration: sc.metrics.avgDurationMs,
        peerReviewScore: sc.metrics.successRate * 0.9, // proxy
        mentorshipCount: 0,
      },
    };
  });

  return leaderboard.rankAgents(careers);
}

/**
 * Export a scorecard as a pretty-printed JSON string.
 */
export function exportScorecard(scorecard: AgentScorecard): string {
  return JSON.stringify(scorecard, null, 2);
}
