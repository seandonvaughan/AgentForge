import { generateId, nowIso } from '@agentforge/shared';
import type { MetricSnapshot, AnomalyEvent } from './types.js';

export interface AnomalyThresholds {
  errorRateThreshold: number;      // default 0.20 — alert if >20% error rate
  costSpikeMultiplier: number;     // default 2.0 — alert if cost > 2x baseline
  latencyRegressionMultiplier: number; // default 2.0
  successRateFloor: number;        // default 0.75 — alert if success < 75%
}

const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  errorRateThreshold: 0.20,
  costSpikeMultiplier: 2.0,
  latencyRegressionMultiplier: 2.0,
  successRateFloor: 0.75,
};

export class AnomalyDetector {
  private baseline: MetricSnapshot | null = null;
  private readonly thresholds: AnomalyThresholds;

  constructor(thresholds: Partial<AnomalyThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  setBaseline(snapshot: MetricSnapshot): void {
    this.baseline = snapshot;
  }

  detect(current: MetricSnapshot): AnomalyEvent[] {
    const anomalies: AnomalyEvent[] = [];
    const base = this.baseline;

    // Error rate spike
    if (current.errorRate > this.thresholds.errorRateThreshold) {
      anomalies.push({
        id: generateId(),
        type: 'error_rate_spike',
        severity: current.errorRate > 0.5 ? 'P0' : 'P1',
        metric: 'errorRate',
        currentValue: current.errorRate,
        baselineValue: base?.errorRate ?? 0,
        deltaPercent: base ? ((current.errorRate - base.errorRate) / Math.max(base.errorRate, 0.01)) * 100 : 100,
        detectedAt: nowIso(),
        workspaceId: current.workspaceId,
      });
    }

    // Cost spike
    if (base && base.avgCostUsd > 0 && current.avgCostUsd > base.avgCostUsd * this.thresholds.costSpikeMultiplier) {
      anomalies.push({
        id: generateId(),
        type: 'cost_spike',
        severity: 'P1',
        metric: 'avgCostUsd',
        currentValue: current.avgCostUsd,
        baselineValue: base.avgCostUsd,
        deltaPercent: ((current.avgCostUsd - base.avgCostUsd) / base.avgCostUsd) * 100,
        detectedAt: nowIso(),
        workspaceId: current.workspaceId,
      });
    }

    // Latency regression
    if (base && base.avgLatencyMs > 0 && current.avgLatencyMs > base.avgLatencyMs * this.thresholds.latencyRegressionMultiplier) {
      anomalies.push({
        id: generateId(),
        type: 'latency_regression',
        severity: 'P2',
        metric: 'avgLatencyMs',
        currentValue: current.avgLatencyMs,
        baselineValue: base.avgLatencyMs,
        deltaPercent: ((current.avgLatencyMs - base.avgLatencyMs) / base.avgLatencyMs) * 100,
        detectedAt: nowIso(),
        workspaceId: current.workspaceId,
      });
    }

    // Success rate drop
    if (current.successRate < this.thresholds.successRateFloor) {
      anomalies.push({
        id: generateId(),
        type: 'success_rate_drop',
        severity: current.successRate < 0.5 ? 'P0' : 'P1',
        metric: 'successRate',
        currentValue: current.successRate,
        baselineValue: base?.successRate ?? 1,
        deltaPercent: base ? ((current.successRate - base.successRate) / Math.max(base.successRate, 0.01)) * 100 : -100,
        detectedAt: nowIso(),
        workspaceId: current.workspaceId,
      });
    }

    return anomalies;
  }
}
