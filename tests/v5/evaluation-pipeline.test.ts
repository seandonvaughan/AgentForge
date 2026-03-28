import { describe, it, expect } from 'vitest';
import { EvaluationPipeline, MetricCollector, AnomalyDetector } from '@agentforge/core';

describe('evaluation pipeline', () => {
  it('MetricCollector produces correct snapshot', () => {
    const col = new MetricCollector();
    col.record({ agentId: 'coder', status: 'completed', costUsd: 0.01 });
    col.record({ agentId: 'coder', status: 'completed', costUsd: 0.02 });
    col.record({ agentId: 'coder', status: 'failed', costUsd: 0.01 });
    const snap = col.snapshot('ws-1');
    expect(snap.sessionCount).toBe(3);
    expect(snap.errorRate).toBeCloseTo(1/3);
    expect(snap.successRate).toBeCloseTo(2/3);
    expect(snap.avgCostUsd).toBeCloseTo(0.04/3);
  });

  it('AnomalyDetector fires on high error rate', () => {
    const det = new AnomalyDetector({ errorRateThreshold: 0.20 });
    const snap = { workspaceId: 'ws-1', timestamp: new Date().toISOString(), errorRate: 0.5, avgCostUsd: 0.01, avgLatencyMs: 100, successRate: 0.5, sessionCount: 10 };
    const anomalies = det.detect(snap);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies.some(a => a.type === 'error_rate_spike')).toBe(true);
  });

  it('AnomalyDetector fires on success rate drop', () => {
    const det = new AnomalyDetector({ successRateFloor: 0.75 });
    const snap = { workspaceId: 'ws-1', timestamp: new Date().toISOString(), errorRate: 0.3, avgCostUsd: 0.01, avgLatencyMs: 100, successRate: 0.5, sessionCount: 10 };
    const anomalies = det.detect(snap);
    expect(anomalies.some(a => a.type === 'success_rate_drop')).toBe(true);
  });

  it('EvaluationPipeline auto-generates proposals on anomaly', () => {
    const pipeline = new EvaluationPipeline();
    // Load up with failures
    for (let i = 0; i < 10; i++) {
      pipeline.record({ agentId: 'coder', status: 'failed', costUsd: 0.05 });
    }
    const result = pipeline.evaluate('ws-1');
    expect(result.anomalies.length).toBeGreaterThan(0);
    expect(result.proposalsGenerated).toBeGreaterThan(0);
    expect(pipeline.listProposals().length).toBeGreaterThan(0);
  });

  it('EvaluationPipeline produces no anomalies for healthy sessions', () => {
    const pipeline = new EvaluationPipeline();
    for (let i = 0; i < 10; i++) {
      pipeline.record({ agentId: 'coder', status: 'completed', costUsd: 0.005 });
    }
    const result = pipeline.evaluate('ws-healthy');
    expect(result.anomalies.length).toBe(0);
    expect(result.proposalsGenerated).toBe(0);
  });
});
