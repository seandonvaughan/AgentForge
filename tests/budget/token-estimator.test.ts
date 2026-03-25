import { describe, it, expect } from "vitest";
import { estimateTokensHeuristic } from "../../src/budget/token-estimator.js";
import { MODEL_COSTS } from "../../src/orchestrator/cost-tracker.js";
import { MODEL_DEFAULTS } from "../../src/api/client.js";

describe("estimateTokensHeuristic", () => {
  it("estimates input tokens as ceil((systemPrompt.length + userMessage.length) / 4)", () => {
    const system = "a".repeat(400);  // 400 chars
    const user = "b".repeat(400);    // 400 chars → 800 total → 200 tokens
    const result = estimateTokensHeuristic(system, user, "haiku");
    expect(result.inputTokens).toBe(200);
  });

  it("estimates output tokens as MODEL_DEFAULTS maxTokens * 0.3", () => {
    const result = estimateTokensHeuristic("sys", "msg", "haiku");
    expect(result.outputTokens).toBe(Math.round(MODEL_DEFAULTS.haiku.maxTokens * 0.3));
  });

  it("estimates output tokens using sonnet maxTokens * 0.3", () => {
    const result = estimateTokensHeuristic("sys", "msg", "sonnet");
    expect(result.outputTokens).toBe(Math.round(MODEL_DEFAULTS.sonnet.maxTokens * 0.3));
  });

  it("estimates output tokens using opus maxTokens * 0.3", () => {
    const result = estimateTokensHeuristic("sys", "msg", "opus");
    expect(result.outputTokens).toBe(Math.round(MODEL_DEFAULTS.opus.maxTokens * 0.3));
  });

  it("computes cost from MODEL_COSTS with 20% safety buffer", () => {
    const system = "a".repeat(400);
    const user = "b".repeat(400);
    const result = estimateTokensHeuristic(system, user, "opus");

    const inputTokens = Math.ceil(800 / 4);
    const outputTokens = Math.round(MODEL_DEFAULTS.opus.maxTokens * 0.3);
    const rawCost =
      (inputTokens / 1_000_000) * MODEL_COSTS.opus.input +
      (outputTokens / 1_000_000) * MODEL_COSTS.opus.output;
    const expected = rawCost * 1.2;

    expect(result.estimatedTotalCostUsd).toBeCloseTo(expected, 8);
  });

  it("applies 20% safety buffer (cost is > raw cost)", () => {
    const result = estimateTokensHeuristic("system", "user message", "sonnet");
    const inputTokens = Math.ceil(("system" + "user message").length / 4);
    const outputTokens = Math.round(MODEL_DEFAULTS.sonnet.maxTokens * 0.3);
    const rawCost =
      (inputTokens / 1_000_000) * MODEL_COSTS.sonnet.input +
      (outputTokens / 1_000_000) * MODEL_COSTS.sonnet.output;
    expect(result.estimatedTotalCostUsd).toBeGreaterThan(rawCost);
    expect(result.estimatedTotalCostUsd).toBeCloseTo(rawCost * 1.2, 8);
  });

  it("handles empty strings without throwing", () => {
    const result = estimateTokensHeuristic("", "", "haiku");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.estimatedTotalCostUsd).toBeGreaterThan(0);
  });

  it("returns a TokenEstimate shape with all three fields", () => {
    const result = estimateTokensHeuristic("hello", "world", "haiku");
    expect(result).toHaveProperty("inputTokens");
    expect(result).toHaveProperty("outputTokens");
    expect(result).toHaveProperty("estimatedTotalCostUsd");
  });
});
