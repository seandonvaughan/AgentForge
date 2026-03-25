/**
 * Dynamic model routing based on task complexity signals.
 *
 * Analyzes a task prompt to extract signals (keywords, code, length, category)
 * and scores complexity on a 0–1 scale. Maps the score to a ModelTier,
 * respecting both floor (category minimum) and ceiling (agent maximum).
 *
 * Also provides confidence detection for escalation logic.
 */

import type { ModelTier, AgentCategory } from "../types/index.js";

/** Signals extracted from a task prompt for routing decisions. */
export interface TaskSignals {
  promptTokenEstimate: number;       // chars / 4 approximation
  hasReasoningKeywords: boolean;     // "analyze", "architect", "synthesize", etc.
  hasCodeOrMath: boolean;            // code blocks, equations, algorithmic content
  expectedOutputComplexity: "simple" | "structured" | "deep";
  agentCategory: AgentCategory;
  agentCeilingTier: ModelTier;       // the tier defined on AgentTemplate.model
}

/** Routing decision produced for a single task invocation. */
export interface RoutingDecision {
  assignedTier: ModelTier;
  ceilingTier: ModelTier;
  complexityScore: number;           // 0 (trivial) to 1 (maximum complexity)
  rationale: string;
  escalationAllowed: boolean;
}

const REASONING_KEYWORDS = [
  "analyze", "architect", "synthesize", "compare", "tradeoff",
  "design", "evaluate", "strategize", "refactor", "audit",
  "diagnose", "plan", "assess", "recommend",
];

const CONFIDENCE_HEDGE_PATTERNS = [
  /i'?m not (entirely |fully )?sure/i,
  /\bmight be\b/i,
  /\bpossibly\b/i,
  /\bnot certain\b/i,
  /\bapproximately\b/i,
  /confidence:\s*[1-3]\/5/i,          // from structured confidence prompt injection
  /\bunsure\b/i,
];

/** Tier floors by agent category — the minimum tier we'll route to. */
const CATEGORY_FLOOR: Record<AgentCategory, ModelTier> = {
  strategic:      "sonnet",   // strategic agents never go below Sonnet
  implementation: "haiku",
  quality:        "sonnet",
  utility:        "haiku",
};

/** Tier ordering for comparison. */
const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

function tierMax(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

function tierMin(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

export function extractTaskSignals(
  task: string,
  agentCategory: AgentCategory,
  agentCeilingTier: ModelTier,
): TaskSignals {
  const promptTokenEstimate = Math.ceil(task.length / 4);
  const lower = task.toLowerCase();

  const hasReasoningKeywords = REASONING_KEYWORDS.some((kw) => lower.includes(kw));
  const hasCodeOrMath = /```|`[^`]+`|\$\$?[^$]+\$\$?|def |function |class /.test(task);

  let expectedOutputComplexity: TaskSignals["expectedOutputComplexity"] = "simple";
  if (hasReasoningKeywords || promptTokenEstimate > 800) {
    expectedOutputComplexity = "structured";
  }
  if (promptTokenEstimate > 2000 && hasReasoningKeywords) {
    expectedOutputComplexity = "deep";
  }

  return {
    promptTokenEstimate,
    hasReasoningKeywords,
    hasCodeOrMath,
    expectedOutputComplexity,
    agentCategory,
    agentCeilingTier,
  };
}

export function scoreComplexity(signals: TaskSignals): number {
  let score = 0;

  // Token count contribution (0–0.3)
  if (signals.promptTokenEstimate > 500)  score += 0.1;
  if (signals.promptTokenEstimate > 1500) score += 0.1;
  if (signals.promptTokenEstimate > 3000) score += 0.1;

  // Reasoning signals (0–0.3)
  if (signals.hasReasoningKeywords) score += 0.2;
  if (signals.hasCodeOrMath)        score += 0.1;

  // Output complexity (0–0.2)
  if (signals.expectedOutputComplexity === "structured") score += 0.1;
  if (signals.expectedOutputComplexity === "deep")       score += 0.2;

  // Agent category (0–0.2)
  if (signals.agentCategory === "strategic") score += 0.2;
  if (signals.agentCategory === "quality")   score += 0.1;

  return Math.min(score, 1.0);
}

export function routeTask(
  task: string,
  agentCategory: AgentCategory,
  agentCeilingTier: ModelTier,
): RoutingDecision {
  const signals = extractTaskSignals(task, agentCategory, agentCeilingTier);
  const score = scoreComplexity(signals);

  // Map score to a candidate tier
  let candidate: ModelTier;
  if (score >= 0.75)      candidate = "opus";
  else if (score >= 0.40) candidate = "sonnet";
  else                    candidate = "haiku";

  // Apply category floor: never go below the floor for this category
  const floor = CATEGORY_FLOOR[agentCategory];
  const floored = tierMax(candidate, floor);

  // Apply ceiling: never exceed the agent's configured tier
  const assigned = tierMin(floored, agentCeilingTier);

  return {
    assignedTier: assigned,
    ceilingTier: agentCeilingTier,
    complexityScore: score,
    rationale: `score=${score.toFixed(2)}, category=${agentCategory}, floor=${floor}, ceiling=${agentCeilingTier}`,
    escalationAllowed: assigned !== agentCeilingTier,   // escalation possible if we're under ceiling
  };
}

export function detectLowConfidence(responseText: string): boolean {
  return CONFIDENCE_HEDGE_PATTERNS.some((p) => p.test(responseText));
}
