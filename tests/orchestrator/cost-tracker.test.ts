import { describe, it, expect, beforeEach } from "vitest";
import { CostTracker } from "../../src/orchestrator/cost-tracker.js";

describe("cost-tracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe("recordUsage", () => {
    it("should record a single usage event", () => {
      tracker.recordUsage("coder", "sonnet", 1000, 500);

      const report = tracker.getReport();

      expect(report.usages).toHaveLength(1);
      expect(report.usages[0].agent).toBe("coder");
      expect(report.usages[0].model).toBe("sonnet");
      expect(report.usages[0].input_tokens).toBe(1000);
      expect(report.usages[0].output_tokens).toBe(500);
      expect(report.usages[0].total_tokens).toBe(1500);
    });

    it("should calculate estimated cost based on model pricing", () => {
      // Sonnet: input $3/M, output $15/M
      tracker.recordUsage("coder", "sonnet", 1_000_000, 1_000_000);

      const report = tracker.getReport();

      // 1M input * $3/M + 1M output * $15/M = $18
      expect(report.usages[0].estimated_cost_usd).toBe(18);
    });

    it("should calculate opus pricing correctly", () => {
      // Opus: input $15/M, output $75/M
      tracker.recordUsage("architect", "opus", 1_000_000, 1_000_000);

      const report = tracker.getReport();

      // 1M * $15 + 1M * $75 = $90
      expect(report.usages[0].estimated_cost_usd).toBe(90);
    });

    it("should calculate haiku pricing correctly", () => {
      // Haiku: input $0.25/M, output $1.25/M
      tracker.recordUsage("file-reader", "haiku", 1_000_000, 1_000_000);

      const report = tracker.getReport();

      // 1M * $0.25 + 1M * $1.25 = $1.50
      expect(report.usages[0].estimated_cost_usd).toBe(1.5);
    });
  });

  describe("getReport", () => {
    it("should aggregate totals across multiple usages", () => {
      tracker.recordUsage("coder", "sonnet", 1000, 500);
      tracker.recordUsage("architect", "opus", 2000, 1000);
      tracker.recordUsage("file-reader", "haiku", 500, 200);

      const report = tracker.getReport();

      expect(report.total_tokens).toBe(1000 + 500 + 2000 + 1000 + 500 + 200);
      expect(report.total_cost_usd).toBeGreaterThan(0);
    });

    it("should break down by model tier", () => {
      tracker.recordUsage("coder", "sonnet", 1000, 500);
      tracker.recordUsage("architect", "opus", 2000, 1000);

      const report = tracker.getReport();

      expect(report.by_model.sonnet.tokens).toBe(1500);
      expect(report.by_model.opus.tokens).toBe(3000);
      expect(report.by_model.haiku.tokens).toBe(0);
    });

    it("should break down by agent", () => {
      tracker.recordUsage("coder", "sonnet", 1000, 500);
      tracker.recordUsage("coder", "sonnet", 2000, 800);
      tracker.recordUsage("architect", "opus", 3000, 1000);

      const report = tracker.getReport();

      expect(report.by_agent["coder"].tokens).toBe(1000 + 500 + 2000 + 800);
      expect(report.by_agent["architect"].tokens).toBe(3000 + 1000);
    });

    it("should return empty report when no usage recorded", () => {
      const report = tracker.getReport();

      expect(report.usages).toEqual([]);
      expect(report.total_tokens).toBe(0);
      expect(report.total_cost_usd).toBe(0);
      expect(report.by_model.opus.tokens).toBe(0);
      expect(report.by_model.sonnet.tokens).toBe(0);
      expect(report.by_model.haiku.tokens).toBe(0);
    });

    it("should aggregate cost correctly in by_model", () => {
      tracker.recordUsage("coder", "sonnet", 1_000_000, 0);
      // $3 for 1M input tokens at sonnet
      const report = tracker.getReport();
      expect(report.by_model.sonnet.cost).toBe(3);
    });
  });

  describe("getAgentCost", () => {
    it("should return cost for a specific agent", () => {
      tracker.recordUsage("coder", "sonnet", 1_000_000, 0);
      tracker.recordUsage("architect", "opus", 1_000_000, 0);

      expect(tracker.getAgentCost("coder")).toBe(3);
      expect(tracker.getAgentCost("architect")).toBe(15);
    });

    it("should return 0 for unknown agent", () => {
      expect(tracker.getAgentCost("nonexistent")).toBe(0);
    });

    it("should aggregate across multiple usages for same agent", () => {
      tracker.recordUsage("coder", "sonnet", 1_000_000, 0);
      tracker.recordUsage("coder", "sonnet", 1_000_000, 0);

      expect(tracker.getAgentCost("coder")).toBe(6);
    });
  });

  describe("formatReport", () => {
    it("should return a formatted string report", () => {
      tracker.recordUsage("coder", "sonnet", 10000, 5000);
      tracker.recordUsage("architect", "opus", 20000, 10000);

      const formatted = tracker.formatReport();

      expect(typeof formatted).toBe("string");
      expect(formatted).toContain("AgentForge Cost Report");
      expect(formatted).toContain("Total tokens:");
      expect(formatted).toContain("Total cost:");
      expect(formatted).toContain("By Model Tier");
      expect(formatted).toContain("By Agent");
      expect(formatted).toContain("coder");
      expect(formatted).toContain("architect");
      expect(formatted).toContain("sonnet");
      expect(formatted).toContain("opus");
    });

    it("should show dollar amounts", () => {
      tracker.recordUsage("coder", "sonnet", 1000, 500);

      const formatted = tracker.formatReport();

      expect(formatted).toContain("$");
    });
  });
});
