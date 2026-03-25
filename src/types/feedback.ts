/**
 * Feedback type definitions for the AgentForge feedback loop system.
 *
 * Agents submit structured feedback as markdown files that accumulate
 * in .agentforge/feedback/ for later review and optimization.
 */

import type { ModelTier } from "./agent.js";

/** Categories of feedback an agent can submit */
export type FeedbackCategory = 'optimization' | 'bug' | 'feature' | 'process' | 'cost' | 'quality';

/** Priority levels for feedback */
export type FeedbackPriority = 'critical' | 'high' | 'medium' | 'low';

/** A feedback entry submitted by an agent */
export interface AgentFeedback {
  id: string;
  agent: string;
  category: FeedbackCategory;
  priority: FeedbackPriority;
  title: string;
  description: string;
  context: {
    task?: string;
    files_involved?: string[];
    model_used?: ModelTier;
    tokens_consumed?: number;
    duration_ms?: number;
  };
  suggestion: string;
  timestamp: string;
}

/** Summary of all feedback for review */
export interface FeedbackSummary {
  total: number;
  by_category: Record<FeedbackCategory, number>;
  by_priority: Record<FeedbackPriority, number>;
  by_agent: Record<string, number>;
  entries: AgentFeedback[];
}

/** A detected theme cluster from feedback analysis. */
export interface FeedbackTheme {
  label: string;
  keywords: string[];
  corroborating_agents: string[];
  entry_count: number;
  peak_priority: FeedbackPriority;
  signal_strength: number;
  entry_ids: string[];
}

/** A recommended action derived from a detected feedback theme. */
export interface RecommendedAction {
  action:
    | "reforge-team"
    | "adjust-model-routing"
    | "increase-budget-ceiling"
    | "add-agent"
    | "remove-agent"
    | "update-system-prompt"
    | "review-manually";
  rationale: string;
  urgency: FeedbackPriority;
  theme_label: string;
  confidence: number;
}

/** Enriched analysis output from FeedbackAnalyzer. */
export interface FeedbackAnalysis {
  analyzed_at: string;
  total_entries: number;
  date_range: { earliest: string; latest: string };
  themes: FeedbackTheme[];
  recommended_actions: RecommendedAction[];
  requires_escalation: boolean;
  summary: FeedbackSummary;
}
