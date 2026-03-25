import { describe, it, expect, beforeAll } from "vitest";
import { FeedbackAnalyzer } from "../../src/feedback/feedback-analyzer.js";
import type { AgentFeedback, FeedbackAnalysis } from "../../src/types/feedback.js";

function makeFeedback(overrides: Partial<AgentFeedback>): AgentFeedback {
  return {
    id: crypto.randomUUID(),
    agent: "test-agent",
    category: "optimization",
    priority: "medium",
    title: "Test feedback",
    description: "A test feedback entry",
    context: { task: "test", files_involved: [], model_used: "haiku", tokens_consumed: 100, duration_ms: 1000 },
    suggestion: "Fix it",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("FeedbackAnalyzer", () => {
  const analyzer = new FeedbackAnalyzer();

  it("returns empty analysis for no entries", () => {
    const result = analyzer.analyze([]);
    expect(result.total_entries).toBe(0);
    expect(result.themes).toHaveLength(0);
    expect(result.recommended_actions).toHaveLength(0);
    expect(result.requires_escalation).toBe(false);
  });

  it("detects a theme when 2+ agents report same keywords", () => {
    const entries = [
      makeFeedback({ agent: "agent-a", description: "Model routing is inefficient, opus tier used for haiku tasks" }),
      makeFeedback({ agent: "agent-b", description: "The model tier routing wastes tokens on opus when haiku would suffice" }),
      makeFeedback({ agent: "agent-c", description: "Something completely unrelated about documentation" }),
    ];
    const result = analyzer.analyze(entries);
    const routingTheme = result.themes.find((t) => t.keywords.some((k) => k.includes("model") || k.includes("routing")));
    expect(routingTheme).toBeDefined();
    expect(routingTheme!.corroborating_agents.length).toBeGreaterThanOrEqual(2);
  });

  it("produces recommended actions for high-signal themes", () => {
    const entries = [
      makeFeedback({ agent: "agent-a", priority: "high", description: "Model routing is broken, opus used everywhere" }),
      makeFeedback({ agent: "agent-b", priority: "high", description: "Routing agents to wrong model tier, too much opus" }),
      makeFeedback({ agent: "agent-c", priority: "high", description: "Model tier selection ignores task complexity" }),
    ];
    const result = analyzer.analyze(entries);
    expect(result.recommended_actions.length).toBeGreaterThan(0);
  });

  it("sets requires_escalation when signal strength exceeds threshold", () => {
    const entries = [
      makeFeedback({ agent: "a1", priority: "critical", description: "Cost budget exceeded, model routing failure" }),
      makeFeedback({ agent: "a2", priority: "critical", description: "Model routing cost is out of control" }),
      makeFeedback({ agent: "a3", priority: "high", description: "Budget overrun due to routing" }),
    ];
    const result = analyzer.analyze(entries);
    expect(result.requires_escalation).toBe(true);
  });

  it("respects configurable corroboration threshold", () => {
    const strictAnalyzer = new FeedbackAnalyzer({ corroborationThreshold: 5 });
    const entries = [
      makeFeedback({ agent: "a1", description: "Model routing issue" }),
      makeFeedback({ agent: "a2", description: "Model routing problem" }),
    ];
    const result = strictAnalyzer.analyze(entries);
    // Only 2 agents — below threshold of 5
    expect(result.themes.filter((t) => t.signal_strength > 0.5)).toHaveLength(0);
  });

  it("includes backward-compatible summary", () => {
    const entries = [
      makeFeedback({ category: "optimization" }),
      makeFeedback({ category: "bug" }),
    ];
    const result = analyzer.analyze(entries);
    expect(result.summary.total).toBe(2);
    expect(result.summary.by_category.optimization).toBe(1);
    expect(result.summary.by_category.bug).toBe(1);
  });

  it("analyzes real AgentForge feedback files", async () => {
    // This test reads actual .agentforge/feedback/ files
    const { FeedbackCollector } = await import("../../src/feedback/feedback-collector.js");
    const collector = new FeedbackCollector(".");
    const entries = await collector.loadAllFeedback();

    // Skip if no feedback files exist (CI environment)
    if (entries.length === 0) return;

    const result = analyzer.analyze(entries);
    expect(result.total_entries).toBeGreaterThan(0);
    expect(result.themes.length).toBeGreaterThan(0);
    // Real feedback should detect the model-routing theme
    console.log("Real analysis:", JSON.stringify(result.themes.map(t => t.label), null, 2));
  });
});
