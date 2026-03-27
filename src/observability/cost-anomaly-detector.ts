/**
 * CostAnomalyDetector — P1-6: Real-Time Cost Anomaly Detection
 *
 * Subscribes to `cost.incurred` events on the V4MessageBus and maintains a
 * rolling window of costs per agent. When a new cost exceeds
 * mean + sigmaThreshold * stddev (and the window has ≥5 samples), it publishes
 * a `cost.anomaly` event so the EventCollector can forward it to SSE clients.
 */

import type { V4MessageBus } from "../communication/v4-message-bus.js";
import type { SqliteAdapter } from "../db/sqlite-adapter.js";

export interface AnomalyDetectorOptions {
  bus: V4MessageBus;
  adapter: SqliteAdapter;
  /** Trailing sessions to analyze per agent (default 50) */
  windowSize?: number;
  /** Stddev multiplier for anomaly detection (default 2.0) */
  sigmaThreshold?: number;
}

export interface CostAnomaly {
  agentId: string;
  sessionId?: string;
  /** Cost that triggered the anomaly */
  amount: number;
  /** Rolling mean of the window */
  mean: number;
  /** Rolling stddev of the window */
  stddev: number;
  /** mean + sigmaThreshold * stddev */
  threshold: number;
  detectedAt: string;
}

export class CostAnomalyDetector {
  private readonly windowSize: number;
  private readonly sigmaThreshold: number;
  /** Rolling window per agent: Map<agentId, number[]> */
  private readonly costWindows = new Map<string, number[]>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: AnomalyDetectorOptions) {
    this.windowSize = opts.windowSize ?? 50;
    this.sigmaThreshold = opts.sigmaThreshold ?? 2.0;
    this.attachListener();
    this.seedWindows();
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  private attachListener(): void {
    this.unsubscribe = this.opts.bus.subscribe<{
      agentId: string;
      sessionId?: string;
      costUsd: number;
    }>("cost.incurred", (envelope) => {
      const { agentId, sessionId, costUsd } = envelope.payload;
      if (typeof agentId !== "string" || typeof costUsd !== "number") return;

      const anomaly = this.checkAnomaly(agentId, costUsd, sessionId);
      if (anomaly !== null) {
        this.opts.bus.publish({
          from: "cost-anomaly-detector",
          to: "broadcast",
          topic: "cost.anomaly",
          category: "status",
          payload: {
            agentId: anomaly.agentId,
            sessionId: anomaly.sessionId,
            amount: anomaly.amount,
            mean: anomaly.mean,
            stddev: anomaly.stddev,
            threshold: anomaly.threshold,
            detectedAt: anomaly.detectedAt,
          },
          priority: "high",
        });
      }
    });
  }

  private seedWindows(): void {
    try {
      const allCosts = this.opts.adapter.getAllCosts();
      for (const row of allCosts) {
        const window = this.costWindows.get(row.agent_id) ?? [];
        window.push(row.cost_usd);
        this.costWindows.set(row.agent_id, window);
      }

      // Trim each window to windowSize (keeping most recent costs)
      for (const [agentId, window] of this.costWindows) {
        if (window.length > this.windowSize) {
          this.costWindows.set(agentId, window.slice(-this.windowSize));
        }
      }
    } catch {
      // If getAllCosts is unavailable or throws, start with empty windows
    }
  }

  // ---------------------------------------------------------------------------
  // Core algorithm
  // ---------------------------------------------------------------------------

  /**
   * Checks whether `costUsd` is anomalous for `agentId` relative to its
   * rolling window. Updates the window unconditionally.
   *
   * Returns a CostAnomaly when:
   *   - window has ≥ 5 existing samples
   *   - costUsd > mean + sigmaThreshold * stddev
   *
   * Otherwise returns null.
   */
  checkAnomaly(
    agentId: string,
    costUsd: number,
    sessionId?: string
  ): CostAnomaly | null {
    const window = this.costWindows.get(agentId) ?? [];

    let anomaly: CostAnomaly | null = null;

    if (window.length >= 5) {
      const n = window.length;
      const mean = window.reduce((a, b) => a + b, 0) / n;
      const variance =
        window.reduce((sum, c) => sum + (c - mean) ** 2, 0) / n;
      const stddev = Math.sqrt(variance);
      const threshold = mean + this.sigmaThreshold * stddev;

      if (costUsd > threshold) {
        anomaly = {
          agentId,
          sessionId,
          amount: costUsd,
          mean,
          stddev,
          threshold,
          detectedAt: new Date().toISOString(),
        };
      }
    }

    // Update the rolling window
    window.push(costUsd);
    if (window.length > this.windowSize) {
      window.shift();
    }
    this.costWindows.set(agentId, window);

    return anomaly;
  }

  /**
   * Returns the current rolling stats for an agent's window.
   * Returns null if the agent has no data.
   */
  getStats(
    agentId: string
  ): { mean: number; stddev: number; sampleCount: number } | null {
    const window = this.costWindows.get(agentId);
    if (!window || window.length === 0) return null;

    const n = window.length;
    const mean = window.reduce((a, b) => a + b, 0) / n;
    const variance =
      window.reduce((sum, c) => sum + (c - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);

    return { mean, stddev, sampleCount: n };
  }

  /** Unsubscribe from the bus. Call when tearing down. */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
