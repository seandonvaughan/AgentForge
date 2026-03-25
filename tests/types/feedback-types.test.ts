// tests/types/feedback-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  FeedbackCategory,
  FeedbackPriority,
  FeedbackTheme,
  RecommendedAction,
  FeedbackAnalysis,
  FeedbackSummary,
} from "../../src/types/feedback.js";

describe("v3 feedback types", () => {
  it("FeedbackTheme has required fields", () => {
    const theme: FeedbackTheme = {
      label: "model-routing-inefficiency",
      keywords: ["model", "routing", "tier", "opus"],
      corroborating_agents: ["model-routing-researcher", "budget-strategy-researcher"],
      entry_count: 3,
      peak_priority: "high",
      signal_strength: 0.85,
      entry_ids: ["a1", "a2", "a3"],
    };
    expect(theme.label).toBe("model-routing-inefficiency");
    expect(theme.corroborating_agents).toHaveLength(2);
    expect(theme.signal_strength).toBeGreaterThan(0.7);
  });

  it("RecommendedAction has typed action field", () => {
    const action: RecommendedAction = {
      action: "adjust-model-routing",
      rationale: "3 agents independently flagged model tier waste",
      urgency: "high",
      theme_label: "model-routing-inefficiency",
      confidence: 0.9,
    };
    expect(action.action).toBe("adjust-model-routing");
  });

  it("FeedbackAnalysis includes themes and actions", () => {
    const analysis: FeedbackAnalysis = {
      analyzed_at: new Date().toISOString(),
      total_entries: 10,
      date_range: { earliest: "2026-03-25", latest: "2026-03-25" },
      themes: [],
      recommended_actions: [],
      requires_escalation: false,
      summary: {
        total: 10,
        by_category: {} as Record<FeedbackCategory, number>,
        by_priority: {} as Record<FeedbackPriority, number>,
        by_agent: {},
        entries: [],
      } as FeedbackSummary,
    };
    expect(analysis.requires_escalation).toBe(false);
  });
});
