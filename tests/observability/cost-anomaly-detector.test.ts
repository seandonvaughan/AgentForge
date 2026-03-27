/**
 * Tests for CostAnomalyDetector — v4.7 P1-6
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CostAnomalyDetector } from "../../src/observability/cost-anomaly-detector.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";
import type { CostRow } from "../../src/db/sqlite-adapter.js";

// ---------------------------------------------------------------------------
// Minimal SqliteAdapter stub
// ---------------------------------------------------------------------------

function makeAdapter(seedCosts: CostRow[] = []) {
  return {
    getAllCosts: vi.fn(() => seedCosts),
    getAgentCosts: vi.fn(() => seedCosts),
  } as unknown as import("../../src/db/sqlite-adapter.js").SqliteAdapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCostRow(agentId: string, costUsd: number): CostRow {
  return {
    id: Math.random().toString(36).slice(2),
    session_id: null,
    agent_id: agentId,
    model: "sonnet",
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: costUsd,
    created_at: new Date().toISOString(),
  };
}

/** Populates `detector.checkAnomaly` with `count` samples for `agentId`. */
function seed(
  detector: CostAnomalyDetector,
  agentId: string,
  costs: number[]
): void {
  for (const c of costs) {
    detector.checkAnomaly(agentId, c);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CostAnomalyDetector", () => {
  let bus: V4MessageBus;
  let adapter: ReturnType<typeof makeAdapter>;
  let detector: CostAnomalyDetector;

  beforeEach(() => {
    bus = new V4MessageBus();
    adapter = makeAdapter();
    detector = new CostAnomalyDetector({ bus, adapter });
  });

  // ─── Minimum sample guard ─────────────────────────────────────────────────

  it("returns null when fewer than 5 samples are in the window", () => {
    seed(detector, "agent-a", [1, 2, 3, 4]); // 4 samples
    const result = detector.checkAnomaly("agent-a", 999);
    expect(result).toBeNull();
  });

  it("returns null with exactly 0 samples (fresh agent)", () => {
    const result = detector.checkAnomaly("new-agent", 100);
    expect(result).toBeNull();
  });

  it("starts evaluating once 5 samples exist (the 6th call may detect)", () => {
    seed(detector, "agent-b", [1, 1, 1, 1, 1]); // 5 samples → window ready for 6th
    // 1.1 > threshold (1 + 2*0 = 1) when all samples are 1 — this IS an anomaly
    // Verify it returns a CostAnomaly (not null) since the window has 5 samples
    const result = detector.checkAnomaly("agent-b", 1.1);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-b");
    expect(result!.amount).toBe(1.1);
    expect(result!.threshold).toBeCloseTo(1);
  });

  // ─── Normal cost within threshold ─────────────────────────────────────────

  it("returns null for cost within threshold (no anomaly)", () => {
    // All 1.0 → mean=1, stddev=0, threshold=1; new cost 1.0 is NOT > threshold
    seed(detector, "agent-c", [1, 1, 1, 1, 1]);
    const result = detector.checkAnomaly("agent-c", 1.0);
    expect(result).toBeNull();
  });

  it("returns null when cost is exactly at threshold", () => {
    // mean=1, stddev=0, threshold=1; cost=1 — not strictly greater
    seed(detector, "agent-d", [1, 1, 1, 1, 1]);
    const result = detector.checkAnomaly("agent-d", 1.0);
    expect(result).toBeNull();
  });

  // ─── Anomaly detection ────────────────────────────────────────────────────

  it("returns CostAnomaly when cost exceeds mean + 2*stddev", () => {
    // mean=10, variance=0, stddev=0 → threshold=10; cost=15 > 10 → anomaly
    seed(detector, "agent-e", [10, 10, 10, 10, 10]);
    const result = detector.checkAnomaly("agent-e", 15);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-e");
    expect(result!.amount).toBe(15);
    expect(result!.mean).toBeCloseTo(10);
    expect(result!.stddev).toBeCloseTo(0);
    expect(result!.threshold).toBeCloseTo(10);
    expect(result!.detectedAt).toBeDefined();
  });

  it("anomaly includes sessionId when provided", () => {
    seed(detector, "agent-f", [10, 10, 10, 10, 10]);
    const result = detector.checkAnomaly("agent-f", 99, "sess-xyz");
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-xyz");
  });

  it("correctly calculates threshold with non-zero stddev", () => {
    // Samples: [0, 0, 0, 0, 10] → mean=2, variance=16, stddev=4, threshold=10
    seed(detector, "agent-g", [0, 0, 0, 0, 10]);
    // threshold = 2 + 2*4 = 10; cost=10.01 > 10 → anomaly
    const result = detector.checkAnomaly("agent-g", 10.01);
    expect(result).not.toBeNull();
    expect(result!.mean).toBeCloseTo(2);
    expect(result!.stddev).toBeCloseTo(4);
    expect(result!.threshold).toBeCloseTo(10);
  });

  // ─── Window trimming ──────────────────────────────────────────────────────

  it("trims window to windowSize", () => {
    const det = new CostAnomalyDetector({ bus, adapter, windowSize: 5 });
    for (let i = 0; i < 10; i++) {
      det.checkAnomaly("trim-agent", 1);
    }
    const stats = det.getStats("trim-agent");
    expect(stats).not.toBeNull();
    expect(stats!.sampleCount).toBe(5);
  });

  it("window trimming affects which samples are used for stats", () => {
    const det = new CostAnomalyDetector({ bus, adapter, windowSize: 3 });
    // Push 3 samples of 100, then overflow with 1s
    det.checkAnomaly("trim2", 100);
    det.checkAnomaly("trim2", 100);
    det.checkAnomaly("trim2", 100);
    // Now push 3 more 1s — window becomes [1, 1, 1] after trimming to 3
    det.checkAnomaly("trim2", 1);
    det.checkAnomaly("trim2", 1);
    det.checkAnomaly("trim2", 1);
    const stats = det.getStats("trim2");
    expect(stats!.mean).toBeCloseTo(1);
    expect(stats!.sampleCount).toBe(3);
  });

  // ─── Bus publish on anomaly ────────────────────────────────────────────────

  it("publishes cost.anomaly on the bus when anomaly detected via cost.incurred event", () => {
    const capturedAnomalies: unknown[] = [];
    bus.subscribe("cost.anomaly", (env) => capturedAnomalies.push(env.payload));

    // Seed the window for "pub-agent" via checkAnomaly
    seed(detector, "pub-agent", [10, 10, 10, 10, 10]);

    // Trigger a cost that exceeds threshold via bus event
    bus.publish({
      from: "test",
      to: "broadcast",
      topic: "cost.incurred",
      category: "status",
      payload: { agentId: "pub-agent", costUsd: 999 },
    });
    bus.drain(); // deliver cost.incurred → handler fires → cost.anomaly queued
    bus.drain(); // deliver cost.anomaly to subscriber

    // Verify bus history contains cost.anomaly with correct metadata
    const history = bus.getHistory();
    const anomalyEvents = history.filter((e) => e.topic === "cost.anomaly");
    expect(anomalyEvents.length).toBeGreaterThan(0);
    expect(anomalyEvents[0].from).toBe("cost-anomaly-detector");
    expect(anomalyEvents[0].to).toBe("broadcast");
    expect(anomalyEvents[0].priority).toBe("high");
  });

  it("does NOT publish on the bus when no anomaly", () => {
    seed(detector, "no-pub-agent", [10, 10, 10, 10, 10]);
    // Publish a normal cost (not exceeding threshold) via bus
    bus.publish({
      from: "test",
      to: "broadcast",
      topic: "cost.incurred",
      category: "status",
      payload: { agentId: "no-pub-agent", costUsd: 10 },
    });
    bus.drain();
    bus.drain();
    const history = bus.getHistory();
    const anomalyEvents = history.filter((e) => e.topic === "cost.anomaly");
    expect(anomalyEvents).toHaveLength(0);
  });

  it("publishes anomaly via cost.incurred bus event (payload verified)", () => {
    const anomalies: unknown[] = [];
    bus.subscribe("cost.anomaly", (env) => anomalies.push(env.payload));

    // Seed via checkAnomaly directly
    seed(detector, "bus-agent", [5, 5, 5, 5, 5]);

    // Trigger via bus event — cost.incurred is queued (non-urgent)
    bus.publish({
      from: "test",
      to: "broadcast",
      topic: "cost.incurred",
      category: "status",
      payload: { agentId: "bus-agent", costUsd: 999 },
    });
    bus.drain(); // process cost.incurred → handler fires → anomaly queued
    bus.drain(); // deliver cost.anomaly to subscriber

    expect(anomalies.length).toBeGreaterThan(0);
    const anomaly = anomalies[0] as { agentId: string; amount: number };
    expect(anomaly.agentId).toBe("bus-agent");
    expect(anomaly.amount).toBe(999);
  });

  // ─── getStats ─────────────────────────────────────────────────────────────

  it("getStats returns null for unknown agent", () => {
    expect(detector.getStats("unknown")).toBeNull();
  });

  it("getStats returns correct mean and stddev", () => {
    seed(detector, "stats-agent", [2, 4, 4, 4, 5, 5, 7, 9]);
    const stats = detector.getStats("stats-agent");
    expect(stats).not.toBeNull();
    expect(stats!.sampleCount).toBe(8);
    expect(stats!.mean).toBeCloseTo(5);
    expect(stats!.stddev).toBeCloseTo(2);
  });

  // ─── destroy / unsubscribe ────────────────────────────────────────────────

  it("destroy() stops processing cost.incurred events", () => {
    seed(detector, "destroy-agent", [10, 10, 10, 10, 10]);
    detector.destroy();

    // Clear history so we can detect new events cleanly
    bus.clearHistory();

    // Publish a cost.incurred that would have triggered anomaly before destroy
    bus.publish({
      from: "test",
      to: "broadcast",
      topic: "cost.incurred",
      category: "status",
      payload: { agentId: "destroy-agent", costUsd: 9999 },
    });
    bus.drain();
    bus.drain();

    // No cost.anomaly event should appear in history after destroy
    const history = bus.getHistory();
    const anomalyEvents = history.filter((e) => e.topic === "cost.anomaly");
    expect(anomalyEvents).toHaveLength(0);
  });

  it("destroy() is idempotent (safe to call multiple times)", () => {
    expect(() => {
      detector.destroy();
      detector.destroy();
    }).not.toThrow();
  });

  // ─── Window seeding from adapter ──────────────────────────────────────────

  it("seeds rolling window from adapter.getAllCosts on construction", () => {
    const costs = [1, 2, 3, 4, 5].map((n) => makeCostRow("seeded-agent", n));
    const adapterWithSeed = makeAdapter(costs);
    const det = new CostAnomalyDetector({ bus, adapter: adapterWithSeed });

    const stats = det.getStats("seeded-agent");
    expect(stats).not.toBeNull();
    expect(stats!.sampleCount).toBe(5);
    expect(stats!.mean).toBeCloseTo(3);
  });
});
