/**
 * MetaLearningEngine — Sprint 5.1a
 *
 * Cross-task pattern extraction, knowledge graph, insight generation.
 * Analyzes task outcomes to identify which patterns lead to success.
 */

export interface TaskOutcome {
  taskId: string;
  agentId: string;
  description: string;
  success: boolean;
  durationMs: number;
  patternsUsed: string[];
  lessonsLearned: string[];
  sprintId: string;
}

export interface PatternStat {
  pattern: string;
  frequency: number;
  successRate: number;
  avgDurationMs: number;
}

export interface Insight {
  pattern: string;
  type: "recommend" | "avoid" | "investigate";
  actionable: boolean;
  recommendation: string;
  confidence: number;
}

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  cooccurrences: number;
}

export interface KnowledgeGraph {
  nodes: string[];
  edges: KnowledgeGraphEdge[];
}

import type { V4MessageBus } from "../communication/v4-message-bus.js";

export class MetaLearningEngine {
  private outcomes: TaskOutcome[] = [];

  constructor(private readonly bus?: V4MessageBus) {}

  recordOutcome(outcome: TaskOutcome): void {
    this.outcomes.push({ ...outcome, patternsUsed: [...outcome.patternsUsed], lessonsLearned: [...outcome.lessonsLearned] });
  }

  outcomeCount(): number {
    return this.outcomes.length;
  }

  getOutcomesByAgent(agentId: string): TaskOutcome[] {
    return this.outcomes.filter((o) => o.agentId === agentId).map((o) => ({ ...o }));
  }

  // ---------------------------------------------------------------------------
  // Pattern extraction
  // ---------------------------------------------------------------------------

  extractPatterns(): PatternStat[] {
    const stats = new Map<string, { count: number; successes: number; totalDuration: number }>();
    for (const outcome of this.outcomes) {
      for (const pattern of outcome.patternsUsed) {
        const s = stats.get(pattern) ?? { count: 0, successes: 0, totalDuration: 0 };
        s.count++;
        if (outcome.success) s.successes++;
        s.totalDuration += outcome.durationMs;
        stats.set(pattern, s);
      }
    }
    return Array.from(stats.entries()).map(([pattern, s]) => ({
      pattern,
      frequency: s.count,
      successRate: s.count > 0 ? s.successes / s.count : 0,
      avgDurationMs: s.count > 0 ? s.totalDuration / s.count : 0,
    }));
  }

  // ---------------------------------------------------------------------------
  // Insight generation
  // ---------------------------------------------------------------------------

  generateInsights(): Insight[] {
    const patterns = this.extractPatterns();
    if (patterns.length === 0) return [];

    const avgSuccess = patterns.reduce((sum, p) => sum + p.successRate, 0) / patterns.length;
    const insights: Insight[] = [];

    for (const p of patterns) {
      if (p.frequency < 2) continue; // need enough data
      if (p.successRate >= 0.75 && p.successRate > avgSuccess + 0.1) {
        insights.push({
          pattern: p.pattern,
          type: "recommend",
          actionable: true,
          recommendation: `Pattern "${p.pattern}" has ${(p.successRate * 100).toFixed(0)}% success rate — recommend wider adoption.`,
          confidence: Math.min(p.frequency / 10, 1),
        });
      } else if (p.successRate <= 0.4) {
        insights.push({
          pattern: p.pattern,
          type: "avoid",
          actionable: true,
          recommendation: `Pattern "${p.pattern}" has only ${(p.successRate * 100).toFixed(0)}% success rate — consider alternatives.`,
          confidence: Math.min(p.frequency / 10, 1),
        });
      }
    }
    if (this.bus && insights.length > 0) {
      this.bus.publish({
        from: "meta-learning-engine",
        to: "broadcast",
        topic: "flywheel.insight.generated",
        category: "status",
        payload: { insights },
        priority: "normal",
      });
    }
    return insights;
  }

  // ---------------------------------------------------------------------------
  // Knowledge graph
  // ---------------------------------------------------------------------------

  getKnowledgeGraph(): KnowledgeGraph {
    const nodeSet = new Set<string>();
    const edgeMap = new Map<string, number>();

    for (const outcome of this.outcomes) {
      for (const p of outcome.patternsUsed) nodeSet.add(p);
      const sorted = [...outcome.patternsUsed].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}::${sorted[j]}`;
          edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
        }
      }
    }

    const edges: KnowledgeGraphEdge[] = Array.from(edgeMap.entries()).map(([key, count]) => {
      const [from, to] = key.split("::");
      return { from, to, cooccurrences: count };
    });

    return { nodes: Array.from(nodeSet), edges };
  }
}
