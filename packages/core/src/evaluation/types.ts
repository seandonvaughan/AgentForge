export interface MetricSnapshot {
  workspaceId: string;
  timestamp: string;
  errorRate: number;         // 0–1, ratio of failed sessions
  avgCostUsd: number;        // average cost per session in window
  avgLatencyMs: number;      // average session duration
  successRate: number;       // 0–1
  sessionCount: number;
}

export interface AnomalyEvent {
  id: string;
  type: 'cost_spike' | 'error_rate_spike' | 'latency_regression' | 'success_rate_drop';
  severity: 'P0' | 'P1' | 'P2';
  metric: string;
  currentValue: number;
  baselineValue: number;
  deltaPercent: number;
  detectedAt: string;
  workspaceId: string;
}

export interface EvaluationResult {
  snapshot: MetricSnapshot;
  anomalies: AnomalyEvent[];
  proposalsGenerated: number;
}
