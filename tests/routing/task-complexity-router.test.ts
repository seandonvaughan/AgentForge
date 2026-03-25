import { describe, it, expect } from "vitest";
import {
  extractTaskSignals,
  scoreComplexity,
  routeTask,
  detectLowConfidence,
} from "../../src/routing/task-complexity-router.js";

describe("extractTaskSignals", () => {
  it("detects reasoning keywords", () => {
    const signals = extractTaskSignals(
      "Analyze the architecture and synthesize a recommendation",
      "strategic",
      "opus",
    );
    expect(signals.hasReasoningKeywords).toBe(true);
  });

  it("detects code content", () => {
    const signals = extractTaskSignals(
      "Fix this function:\n```typescript\nfunction foo() {}\n```",
      "implementation",
      "sonnet",
    );
    expect(signals.hasCodeOrMath).toBe(true);
  });

  it("estimates token count from char length", () => {
    const task = "a".repeat(2000);
    const signals = extractTaskSignals(task, "utility", "haiku");
    expect(signals.promptTokenEstimate).toBe(500);
  });

  it("classifies output complexity based on signals", () => {
    const simple = extractTaskSignals("List files", "utility", "haiku");
    expect(simple.expectedOutputComplexity).toBe("simple");

    const deep = extractTaskSignals(
      "a".repeat(8001) + " analyze the tradeoffs and synthesize",
      "strategic",
      "opus",
    );
    expect(deep.expectedOutputComplexity).toBe("deep");
  });
});

describe("scoreComplexity", () => {
  it("scores a trivial utility task low", () => {
    const signals = extractTaskSignals("Read file.txt", "utility", "haiku");
    const score = scoreComplexity(signals);
    expect(score).toBeLessThan(0.3);
  });

  it("scores a complex strategic task high", () => {
    const signals = extractTaskSignals(
      "a".repeat(12001) + " Analyze the system architecture, compare tradeoffs between approaches, and design a new integration pattern",
      "strategic",
      "opus",
    );
    const score = scoreComplexity(signals);
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it("scores a moderate implementation task in the middle", () => {
    const signals = extractTaskSignals(
      "Refactor the delegation manager to support conditional edges",
      "implementation",
      "sonnet",
    );
    const score = scoreComplexity(signals);
    expect(score).toBeGreaterThanOrEqual(0.1);
    expect(score).toBeLessThan(0.7);
  });
});

describe("routeTask", () => {
  it("routes trivial utility tasks to haiku", () => {
    const decision = routeTask("Read file.txt", "utility", "sonnet");
    expect(decision.assignedTier).toBe("haiku");
    expect(decision.escalationAllowed).toBe(true);
  });

  it("respects category floor — strategic never below sonnet", () => {
    const decision = routeTask("Short question", "strategic", "opus");
    expect(decision.assignedTier).not.toBe("haiku");
  });

  it("respects ceiling — never exceeds agent template tier", () => {
    const decision = routeTask(
      "a".repeat(12001) + " Analyze and synthesize the entire architecture",
      "strategic",
      "sonnet",  // ceiling is sonnet even though task scores high
    );
    expect(decision.assignedTier).toBe("sonnet");
  });

  it("allows escalation when assigned below ceiling", () => {
    const decision = routeTask("List files", "utility", "sonnet");
    expect(decision.assignedTier).toBe("haiku");
    expect(decision.escalationAllowed).toBe(true);
  });

  it("disallows escalation when assigned at ceiling", () => {
    const decision = routeTask(
      "a".repeat(12001) + " Analyze and synthesize and design",
      "strategic",
      "opus",
    );
    expect(decision.assignedTier).toBe("opus");
    expect(decision.escalationAllowed).toBe(false);
  });
});

describe("detectLowConfidence", () => {
  it("detects hedging language", () => {
    expect(detectLowConfidence("I'm not sure about this approach")).toBe(true);
    expect(detectLowConfidence("This might be correct")).toBe(true);
    // Confidence scores 1-3 of 5 are hedging. The regex is /confidence:\s*[1-3]\/5/i
    expect(detectLowConfidence("Confidence: 2/5")).toBe(true);
    expect(detectLowConfidence("Confidence: 1/5")).toBe(true);
  });

  it("passes confident responses", () => {
    // Confidence scores 4/5 and 5/5 are NOT hedging
    expect(detectLowConfidence("Here is the implementation. Confidence: 5/5")).toBe(false);
    expect(detectLowConfidence("Confidence: 4/5")).toBe(false);
    expect(detectLowConfidence("The correct approach is to use a factory pattern.")).toBe(false);
  });
});
