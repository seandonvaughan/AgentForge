import { appendRoutingFeedback, readRoutingFeedback } from './adaptive-routing-store.js';
import type { RoutingDecision } from './types.js';

interface RoutingFeedback {
  agentId: string;
  model: 'opus' | 'sonnet' | 'haiku';
  outcome: 'success' | 'failure';
  taskComplexity: string;
  timestamp: string;
}

interface AgentPerformance {
  agentId: string;
  model: 'opus' | 'sonnet' | 'haiku';
  successRate: number;
  sampleCount: number;
  lastUpdated: string;
}

export interface AdaptiveRouterOptions {
  /** Path to the JSONL persistence file. Defaults to `.agentforge/memory/routing-feedback.jsonl`. */
  feedbackFilePath?: string;
}

export class AdaptiveRouter {
  private feedback: RoutingFeedback[] = [];
  private performanceCache: Map<string, AgentPerformance> = new Map();
  private readonly feedbackFilePath: string;

  constructor(opts: AdaptiveRouterOptions = {}) {
    this.feedbackFilePath = opts.feedbackFilePath ?? '.agentforge/memory/routing-feedback.jsonl';
    // Replay persisted records into in-memory state on construction
    for (const record of readRoutingFeedback(this.feedbackFilePath)) {
      this.feedback.push({
        agentId: record.agentId,
        model: record.model as 'opus' | 'sonnet' | 'haiku',
        outcome: record.success ? 'success' : 'failure',
        taskComplexity: '',
        timestamp: record.ts,
      });
    }
  }

  /** Record feedback from a completed session (legacy signature). */
  recordOutcome(
    agentId: string,
    model: 'opus' | 'sonnet' | 'haiku',
    outcome: 'success' | 'failure',
    taskComplexity: string,
  ): void;
  /** Record feedback with latency and cost (new persistent signature). */
  recordOutcome(
    agentId: string,
    model: 'opus' | 'sonnet' | 'haiku',
    success: boolean,
    latencyMs: number,
    costUsd: number,
  ): void;
  recordOutcome(
    agentId: string,
    model: 'opus' | 'sonnet' | 'haiku',
    outcomeOrSuccess: 'success' | 'failure' | boolean,
    taskComplexityOrLatencyMs: string | number,
    costUsd?: number,
  ): void {
    const ts = new Date().toISOString();

    if (typeof outcomeOrSuccess === 'boolean') {
      // New persistent signature: (agentId, model, success, latencyMs, costUsd)
      const success = outcomeOrSuccess;
      const latencyMs = taskComplexityOrLatencyMs as number;
      const cost = costUsd ?? 0;
      this.feedback.push({
        agentId,
        model,
        outcome: success ? 'success' : 'failure',
        taskComplexity: '',
        timestamp: ts,
      });
      appendRoutingFeedback(this.feedbackFilePath, {
        ts,
        agentId,
        model,
        success,
        latencyMs,
        costUsd: cost,
      });
    } else {
      // Legacy signature: (agentId, model, outcome, taskComplexity)
      const outcome = outcomeOrSuccess;
      const taskComplexity = taskComplexityOrLatencyMs as string;
      this.feedback.push({ agentId, model, outcome, taskComplexity, timestamp: ts });
    }

    // Invalidate cache for this agent
    this.performanceCache.delete(agentId);
  }

  /** Get the recommended model for an agent based on historical performance. */
  recommend(agentId: string, defaultModel: 'opus' | 'sonnet' | 'haiku'): 'opus' | 'sonnet' | 'haiku' {
    const agentFeedback = this.feedback.filter(f => f.agentId === agentId);
    if (agentFeedback.length < 5) return defaultModel; // not enough data

    // Group by model and calculate success rates
    const byModel = new Map<string, { success: number; total: number }>();
    for (const f of agentFeedback) {
      const stats = byModel.get(f.model) ?? { success: 0, total: 0 };
      stats.total++;
      if (f.outcome === 'success') stats.success++;
      byModel.set(f.model, stats);
    }

    // Find the most cost-effective model with >70% success rate
    const modelCost = { haiku: 1, sonnet: 5, opus: 15 };
    const candidates = (['haiku', 'sonnet', 'opus'] as const)
      .filter(m => {
        const stats = byModel.get(m);
        return stats && stats.total >= 3 && stats.success / stats.total >= 0.7;
      })
      .sort((a, b) => modelCost[a] - modelCost[b]);

    return candidates[0] ?? defaultModel;
  }

  /** Get performance stats for all agents. */
  getPerformance(): AgentPerformance[] {
    const agentIds = [...new Set(this.feedback.map(f => f.agentId))];
    return agentIds.map(agentId => {
      const agentFeedback = this.feedback.filter(f => f.agentId === agentId);
      const modelGroups = new Map<string, { success: number; total: number }>();
      for (const f of agentFeedback) {
        const g = modelGroups.get(f.model) ?? { success: 0, total: 0 };
        g.total++;
        if (f.outcome === 'success') g.success++;
        modelGroups.set(f.model, g);
      }
      const best = [...modelGroups.entries()].sort((a, b) => (b[1].success / b[1].total) - (a[1].success / a[1].total))[0];
      return {
        agentId,
        model: (best?.[0] ?? 'sonnet') as 'opus' | 'sonnet' | 'haiku',
        successRate: best ? best[1].success / best[1].total : 0,
        sampleCount: agentFeedback.length,
        lastUpdated: agentFeedback[agentFeedback.length - 1]?.timestamp ?? new Date().toISOString(),
      };
    });
  }
}
