import { nowIso } from '@agentforge/shared';
import type { MetricSnapshot } from './types.js';

export interface SessionMetric {
  agentId: string;
  status: 'completed' | 'failed' | string;
  costUsd: number;
  durationMs?: number;
}

export class MetricCollector {
  private window: SessionMetric[] = [];
  private readonly maxWindowSize: number;

  constructor(maxWindowSize = 1000) {
    this.maxWindowSize = maxWindowSize;
  }

  record(metric: SessionMetric): void {
    this.window.push(metric);
    if (this.window.length > this.maxWindowSize) {
      this.window.shift();
    }
  }

  snapshot(workspaceId: string): MetricSnapshot {
    const sessions = this.window;
    if (sessions.length === 0) {
      return {
        workspaceId,
        timestamp: nowIso(),
        errorRate: 0,
        avgCostUsd: 0,
        avgLatencyMs: 0,
        successRate: 1,
        sessionCount: 0,
      };
    }

    const failed = sessions.filter(s => s.status === 'failed').length;
    const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);
    const totalLatency = sessions.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

    return {
      workspaceId,
      timestamp: nowIso(),
      errorRate: failed / sessions.length,
      avgCostUsd: totalCost / sessions.length,
      avgLatencyMs: totalLatency / sessions.length,
      successRate: (sessions.length - failed) / sessions.length,
      sessionCount: sessions.length,
    };
  }

  clear(): void {
    this.window = [];
  }
}
