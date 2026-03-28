import { SelfProposalEngine } from '../intelligence/self-proposal.js';
import { MetricCollector } from './metric-collector.js';
import { AnomalyDetector } from './anomaly-detector.js';
import type { SessionMetric } from './metric-collector.js';
import type { AnomalyEvent, EvaluationResult } from './types.js';

export class EvaluationPipeline {
  readonly collector: MetricCollector;
  readonly detector: AnomalyDetector;
  private readonly proposals: SelfProposalEngine;
  private anomalyHistory: AnomalyEvent[] = [];

  constructor(proposals?: SelfProposalEngine) {
    this.collector = new MetricCollector();
    this.detector = new AnomalyDetector();
    this.proposals = proposals ?? new SelfProposalEngine();
  }

  /** Record a session outcome into the metric window. */
  record(metric: SessionMetric): void {
    this.collector.record(metric);
  }

  /**
   * Evaluate the current window. Detects anomalies and auto-generates proposals.
   * Call this periodically (e.g., every N sessions or on a timer).
   */
  evaluate(workspaceId: string): EvaluationResult {
    const snapshot = this.collector.snapshot(workspaceId);
    const anomalies = this.detector.detect(snapshot);

    this.anomalyHistory.push(...anomalies);

    let proposalsGenerated = 0;
    for (const anomaly of anomalies) {
      const title = this._anomalyTitle(anomaly);
      const description = this._anomalyDescription(anomaly);
      this.proposals.propose(
        { agentId: 'evaluation-pipeline', workspaceId },
        title,
        description,
        [anomaly.type, anomaly.severity.toLowerCase()],
      );
      proposalsGenerated++;
    }

    // Update baseline after evaluation
    this.detector.setBaseline(snapshot);

    return { snapshot, anomalies, proposalsGenerated };
  }

  /** Get generated proposals from this pipeline. */
  listProposals() {
    return this.proposals.list();
  }

  /** Full anomaly history. */
  anomalies(): AnomalyEvent[] {
    return [...this.anomalyHistory];
  }

  private _anomalyTitle(a: AnomalyEvent): string {
    const map: Record<string, string> = {
      cost_spike: 'Cost spike detected — investigate model tier usage',
      error_rate_spike: 'Error rate spike — agent reliability degraded',
      latency_regression: 'Latency regression — response times elevated',
      success_rate_drop: 'Success rate drop — agent effectiveness declining',
    };
    return map[a.type] ?? `Anomaly: ${a.type}`;
  }

  private _anomalyDescription(a: AnomalyEvent): string {
    return `${a.metric} is ${a.currentValue.toFixed(3)} (baseline: ${a.baselineValue.toFixed(3)}, delta: ${a.deltaPercent.toFixed(1)}%). Workspace: ${a.workspaceId}.`;
  }
}
