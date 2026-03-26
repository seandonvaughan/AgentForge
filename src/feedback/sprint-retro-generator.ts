/**
 * SprintRetroGenerator — v4.6 P1-5
 *
 * Automatically generates sprint retrospective reports from FeedbackProtocol
 * entries. Computes wins, blockers, recommendations, agent scores, cost
 * anomalies, and velocity metrics.
 */

import type { FeedbackEntry } from "./feedback-protocol.js";
import { FeedbackProtocol } from "./feedback-protocol.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RetroReport {
  sprintId: string;
  version: string;
  generatedAt: string;
  entryCount: number;
  agentCount: number;
  // Top items from feedback
  topWins: Array<{ item: string; mentions: number }>;
  topBlockers: Array<{ item: string; mentions: number }>;
  topRecommendations: Array<{ item: string; mentions: number }>;
  // Metrics
  avgSelfAssessment: number; // 0.0–3.0
  modelMismatchCount: number;
  costAnomalies: string[]; // agents where cost was >2x the sprint average
  // Velocity
  tasksCompleted: number;
  tasksPlanned: number;
  completionRate: number; // tasksCompleted / tasksPlanned
  // Agent performance
  agentScores: Array<{ agentId: string; score: number; entries: number }>;
}

export interface SprintMeta {
  version?: string;
  tasksCompleted?: number;
  tasksPlanned?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSESSMENT_SCORE: Record<FeedbackEntry["selfAssessment"], number> = {
  exceeded: 3,
  met: 2,
  partial: 1,
  failed: 0,
};

/**
 * Collect all strings, count frequency, return top-N as {item, mentions} pairs.
 * Ties resolved by first-seen order.
 */
function topByFrequencyWithCounts(
  items: string[],
  n: number,
): Array<{ item: string; mentions: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([item, mentions]) => ({ item, mentions }));
}

// ---------------------------------------------------------------------------
// SprintRetroGenerator
// ---------------------------------------------------------------------------

export class SprintRetroGenerator {
  private readonly feedbackProtocol: FeedbackProtocol;

  constructor(feedbackProtocol: FeedbackProtocol) {
    this.feedbackProtocol = feedbackProtocol;
  }

  /**
   * Generate a full RetroReport for the given sprintId.
   */
  generateRetro(sprintId: string, sprintMeta?: SprintMeta): RetroReport {
    const entries = this.feedbackProtocol.getEntries({ sprintId });

    const agentIds = new Set(entries.map((e) => e.agentId));

    // Top items
    const allWins = entries.flatMap((e) => e.whatWorked);
    const allBlockers = entries.flatMap((e) => e.blockers);
    const allRecommendations = entries.flatMap((e) => e.recommendations);

    const topWins = topByFrequencyWithCounts(allWins, 5);
    const topBlockers = topByFrequencyWithCounts(allBlockers, 5);
    const topRecommendations = topByFrequencyWithCounts(allRecommendations, 5);

    // Metrics
    const avgSelfAssessment =
      entries.length === 0
        ? 0
        : entries.reduce((sum, e) => sum + ASSESSMENT_SCORE[e.selfAssessment], 0) /
          entries.length;

    const modelMismatchCount = entries.filter((e) => !e.modelTierAppropriate).length;

    // Cost anomalies: agents where average cost (timeSpentMs as proxy) > 2x sprint average
    const costAnomalies = this._computeCostAnomalies(entries);

    // Velocity
    const tasksCompleted = sprintMeta?.tasksCompleted ?? 0;
    const tasksPlanned = sprintMeta?.tasksPlanned ?? 0;
    const completionRate = tasksPlanned === 0 ? 0 : tasksCompleted / tasksPlanned;

    // Agent scores: per-agent quality score (exceeded=3, met=2, partial=1, failed=0, / count)
    const agentScores = this._computeAgentScores(entries);

    return {
      sprintId,
      version: sprintMeta?.version ?? "0.0.0",
      generatedAt: new Date().toISOString(),
      entryCount: entries.length,
      agentCount: agentIds.size,
      topWins,
      topBlockers,
      topRecommendations,
      avgSelfAssessment,
      modelMismatchCount,
      costAnomalies,
      tasksCompleted,
      tasksPlanned,
      completionRate,
      agentScores,
    };
  }

  /**
   * Format a RetroReport as a markdown retrospective document.
   */
  generateMarkdown(report: RetroReport): string {
    const completionPct = (report.completionRate * 100).toFixed(0);
    const avgAssessment = report.avgSelfAssessment.toFixed(2);

    const lines: string[] = [
      `# Sprint Retrospective — ${report.sprintId} (v${report.version})`,
      "",
      `Generated: ${report.generatedAt}  `,
      `Entries: ${report.entryCount} feedback entries from ${report.agentCount} agents  `,
      `Sprint Completion: ${report.tasksCompleted}/${report.tasksPlanned} (${completionPct}%)  `,
      `Avg Self-Assessment: ${avgAssessment}/3.0  `,
      `Model Mismatches: ${report.modelMismatchCount}`,
      "",
      "## Top Wins",
    ];

    if (report.topWins.length === 0) {
      lines.push("_none_");
    } else {
      report.topWins.forEach((w, i) => {
        lines.push(`${i + 1}. ${w.item} (${w.mentions} mention${w.mentions !== 1 ? "s" : ""})`);
      });
    }

    lines.push("", "## Top Blockers");

    if (report.topBlockers.length === 0) {
      lines.push("_none_");
    } else {
      report.topBlockers.forEach((b, i) => {
        lines.push(`${i + 1}. ${b.item} (${b.mentions} mention${b.mentions !== 1 ? "s" : ""})`);
      });
    }

    lines.push("", "## Top Recommendations");

    if (report.topRecommendations.length === 0) {
      lines.push("_none_");
    } else {
      report.topRecommendations.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.item} (${r.mentions} mention${r.mentions !== 1 ? "s" : ""})`);
      });
    }

    lines.push("", "## Agent Performance");
    lines.push("| Agent | Score | Entries |");
    lines.push("|-------|-------|---------|");

    if (report.agentScores.length === 0) {
      lines.push("| — | — | — |");
    } else {
      for (const agent of report.agentScores) {
        lines.push(`| ${agent.agentId} | ${agent.score.toFixed(2)}/3.0 | ${agent.entries} |`);
      }
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _computeAgentScores(
    entries: FeedbackEntry[],
  ): Array<{ agentId: string; score: number; entries: number }> {
    const byAgent = new Map<string, FeedbackEntry[]>();
    for (const entry of entries) {
      const existing = byAgent.get(entry.agentId) ?? [];
      existing.push(entry);
      byAgent.set(entry.agentId, existing);
    }

    const scores: Array<{ agentId: string; score: number; entries: number }> = [];
    for (const [agentId, agentEntries] of byAgent.entries()) {
      const total = agentEntries.reduce(
        (sum, e) => sum + ASSESSMENT_SCORE[e.selfAssessment],
        0,
      );
      scores.push({
        agentId,
        score: total / agentEntries.length,
        entries: agentEntries.length,
      });
    }

    // Sort by score descending, then by agentId for determinism
    scores.sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
    return scores;
  }

  private _computeCostAnomalies(entries: FeedbackEntry[]): string[] {
    if (entries.length === 0) return [];

    // Use timeSpentMs as cost proxy. If all entries have 0 time, no cost data.
    const totalTime = entries.reduce((sum, e) => sum + e.timeSpentMs, 0);
    if (totalTime === 0) return [];

    // Compute per-agent average time
    const byAgent = new Map<string, number[]>();
    for (const entry of entries) {
      const existing = byAgent.get(entry.agentId) ?? [];
      existing.push(entry.timeSpentMs);
      byAgent.set(entry.agentId, existing);
    }

    const sprintAvg = totalTime / entries.length;
    const anomalies: string[] = [];

    for (const [agentId, times] of byAgent.entries()) {
      const agentAvg = times.reduce((s, t) => s + t, 0) / times.length;
      if (agentAvg > 2 * sprintAvg) {
        anomalies.push(agentId);
      }
    }

    return anomalies.sort();
  }
}
