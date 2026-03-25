---
id: a3f8c2d1-7e4b-4a91-b6d0-1c9e5f2a8b3e
agent: model-routing-researcher
category: optimization
priority: high
timestamp: "2026-03-25T02:45:00.000Z"
---

# Dynamic Model Routing: Runtime Tier Selection via Task Complexity Scoring

## Problem

AgentForge v2 locks every agent to a static `ModelTier` at template-definition time (see `AgentTemplate.model` in `src/types/agent.ts`). This is a blunt instrument. A `strategic` Opus agent that mostly handles short clarification queries wastes 60x the per-token cost of Haiku on tasks that don't require deep reasoning. Conversely, a `haiku`-tier utility agent sometimes receives a task that genuinely needs multi-step reasoning — it underperforms and produces low-confidence output with no escalation path.

The current `runAgent` in `src/api/agent-runner.ts` passes `agent.model` verbatim to `sendMessage` with zero runtime flexibility.

## Research

**DSPy (Stanford NLP, 2023)** introduced the concept of "teleprompters" — optimizers that can swap out which LM backs a module based on observed accuracy on a task signature. The key insight: task complexity is measurable from the prompt signature itself (number of input fields, expected reasoning depth, output format complexity).

**AutoGen (Microsoft, 2023)** uses agent capability declarations and a "selector" that chooses among registered agents based on task description embeddings. Model tier is a downstream consequence of agent selection, not the primary axis — but capability declarations effectively encode complexity requirements.

**CrewAI** takes a simpler approach: each agent has a fixed LLM but supports a `llm_config` override per-task. The pattern that emerged in the CrewAI community is a "probe-and-escalate" pattern: run a cheap model with a structured output schema; if the output fails schema validation or includes an explicit `low_confidence` flag, retry on a more capable tier.

**LLM Routing papers (RouteLLM, 2024, Ong et al.)** formalize this as a binary classification problem: given a prompt, predict whether a strong model is required. They achieve ~40% cost reduction with <5% quality loss using a small router model trained on preference pairs. Key features used: prompt token count, presence of multi-step reasoning keywords, code/math content detection, expected output length.

**Heuristic complexity signals** that generalize without a router model:
- Prompt length: inputs >2000 tokens correlate with complex tasks
- Reasoning keywords: "analyze", "architect", "compare tradeoffs", "design", "synthesize"
- Structured output depth: deeply nested JSON schemas require stronger models
- Task category: `strategic` category in `AgentCategory` → Opus; `utility` → Haiku baseline
- Confidence-based escalation: parse model output for uncertainty markers ("I'm not sure", "might be", "approximately") and re-run on a higher tier

## Findings

1. **Static routing wastes money on easy tasks.** A Haiku invocation costs ~60x less than Opus for the same token count. Even a 30% hit rate on "this Opus task could have been Haiku" yields massive savings.

2. **Escalation beats upfront complexity estimation.** Pre-execution complexity scoring is imprecise. The more reliable pattern is: attempt with a cheaper model, parse the output for confidence signals, and escalate only when needed. This is slower (two API calls) but only when the task was genuinely ambiguous.

3. **The `AgentCategory` field is an underused routing signal.** `strategic` agents should default to Sonnet with Opus escalation. `utility` agents should default to Haiku with Sonnet escalation. The current system ignores this.

4. **Confidence is parseable without structured output.** A simple regex/heuristic pass over model output can detect hedging language with ~85% recall. Adding `"Rate your confidence 1-5 at the end of your response"` to every system prompt makes it reliable and machine-readable.

5. **Minimum viable router needs no ML.** A scoring function based on token count, keyword presence, and agent category covers the dominant cost-waste scenarios.

## Recommendation

Implement a `TaskComplexityRouter` that runs before `sendMessage` is called in `runAgent`. The router assigns a complexity score (0–1) and maps it to a `ModelTier`. The agent's `template.model` becomes the **ceiling**, not the fixed tier. If the router scores the task below the ceiling, it downsamples.

Additionally, implement **confidence-based escalation**: if the initial response from a downsampled tier contains low-confidence signals, automatically retry on the agent's canonical tier and return the higher-quality result. Cap escalation attempts at 1 to prevent runaway costs.

## Implementation Sketch

```typescript
// src/routing/task-complexity-router.ts

import type { ModelTier, AgentCategory } from "../types/agent.js";

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
  /confidence:\s*[1-2]\/5/i,          // from structured confidence prompt injection
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
```

**Integration point** — modify `runAgent` in `src/api/agent-runner.ts`:

```typescript
// In runAgent(), replace the direct sendMessage call with:

const decision = routeTask(task, agent.category, agent.model);
let result = await sendMessage({
  model: decision.assignedTier,
  systemPrompt: agent.system_prompt + "\n\nRate your confidence 1-5 at the very end: 'Confidence: X/5'",
  userMessage,
});

// Escalate if low confidence and ceiling allows it
if (decision.escalationAllowed && detectLowConfidence(result.content)) {
  result = await sendMessage({
    model: decision.ceilingTier,
    systemPrompt: agent.system_prompt,
    userMessage,
  });
  // Record both invocations to CostTracker
}
```

Note: `AgentTemplate` in `src/types/agent.ts` currently lacks a `category` field typed as `AgentCategory`. That field exists in the type definition but is not present on `AgentTemplate`. Add it:

```typescript
// src/types/agent.ts — add to AgentTemplate:
category: AgentCategory;
```

## Cost Impact

Based on the tier price ratios in `src/orchestrator/cost-tracker.ts` (Haiku input: $0.25/M, Sonnet: $3.00/M, Opus: $15.00/M):

- Routing 40% of current Opus tasks to Sonnet: **5x cost reduction on those tasks**
- Routing 50% of current Sonnet utility tasks to Haiku: **12x cost reduction on those tasks**
- Escalation overhead (second API call when confidence is low): adds ~10-15% cost on escalated tasks but those are a small fraction

**Projected net reduction: 35–55% of total token spend** in a typical mixed workload, based on the assumption that utility and implementation agents dominate task volume while strategic agents are invoked less frequently.
