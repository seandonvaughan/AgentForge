---
id: d4a6f3b0-8e2c-4d95-c7f1-3b5e9a2d6c4f
agent: cost-optimization-lead
category: feature
priority: critical
timestamp: "2026-03-25T02:45:00.000Z"
---

# Cost-Aware Architecture for AgentForge v3: Unified Synthesis

## Problem

AgentForge v2's cost model has three structural gaps that compound each other:

1. **Static routing**: model tiers are fixed at template authoring time, not at task execution time (`AgentTemplate.model` in `src/types/agent.ts`)
2. **No pre-execution awareness**: `runAgent` in `src/api/agent-runner.ts` sends requests without knowing or checking cost in advance; `CostTracker` in `src/orchestrator/cost-tracker.ts` only records after the fact
3. **No parallelism engine**: the `parallel: boolean` collaboration flag exists but there is no `Promise.allSettled`-based fan-out primitive that knows how to route shards to cheaper tiers

Each gap alone wastes money. Together, they mean AgentForge v3 could easily cost 3-5x more than necessary at scale. The three squads have independently identified concrete solutions. This synthesis integrates them into a single coherent architecture.

## Research

See companion proposals:
- `2026-03-25-model-routing-researcher-dynamic-model-selection.md` — complexity-scored routing, confidence escalation
- `2026-03-25-parallel-execution-researcher-fanout-engine.md` — fan-out engine, work stealing, partial failure recovery
- `2026-03-25-budget-strategy-researcher-budget-enforcement.md` — token estimation, budget envelopes, mid-run control

Additional synthesis research:

**The three problems are not independent.** Budget envelopes depend on cost estimates; cost estimates depend on which tier will be used; which tier is used depends on the routing decision. The system must be layered in this order:

```
1. Budget check (can we afford this at all?)
   ↓
2. Routing decision (which tier minimizes cost within quality constraints?)
   ↓
3. Fan-out decision (is parallelism cheaper than single-agent for this tier?)
   ↓
4. Execution (runAgent, with dynamic max_tokens from budget envelope)
   ↓
5. Post-execution recording (CostTracker + BudgetEnvelope.recordActual)
   ↓
6. Escalation check (did confidence warrant re-running at a higher tier?)
```

**The v2 `ProgressLedger.confidence` field** (0-1 float in `src/types/orchestration.ts`) is the natural integration point for routing escalation decisions. When the orchestrator updates the ledger after an agent run, it should compare the reported confidence against a minimum threshold; if below threshold AND budget remains, it should trigger an escalation re-run.

**The `Handoff.artifact.confidence` field** in `src/types/orchestration.ts` is likewise an escalation trigger: if an agent hands off an artifact with confidence < 0.6, the receiving agent should be routed to a higher tier than its default.

## Findings

### Key integration points in v2 that become v3 cost levers

| v2 artifact | Location | v3 cost lever |
|---|---|---|
| `AgentTemplate.model` | `src/types/agent.ts` | Becomes the **ceiling**, not the fixed tier |
| `AgentTemplate.category` | `src/types/agent.ts` | Routing floor: `strategic`→Sonnet floor, `utility`→Haiku floor |
| `ProgressLedger.confidence` | `src/types/orchestration.ts` | Escalation trigger threshold |
| `Handoff.artifact.confidence` | `src/types/orchestration.ts` | Handoff-point tier upgrade signal |
| `AgentCollaboration.parallel` | `src/types/agent.ts` | Fan-out eligibility gate |
| `runAgent` | `src/api/agent-runner.ts` | Wrapping point for budget + routing middleware |
| `sendMessage` params (`maxTokens`) | `src/api/client.ts` | Dynamic budget cap injection point |
| `CostTracker.recordUsage` | `src/orchestrator/cost-tracker.ts` | Feeds budget envelope's `recordActual` |

### The compound savings are multiplicative, not additive

- Dynamic routing alone: **35-55% spend reduction**
- Fan-out for parallelizable tasks: **20-40% wall-clock reduction** + **up to 70% cost reduction on Opus-class tasks** when routed to Haiku fan-out + Sonnet merge
- Budget enforcement alone: **10-20% spend reduction** from capping and context injection
- Combined, with interaction effects: **estimated 50-70% total spend reduction** vs v2 on a mixed workload

These are not independent — they interact. Routing sends a task to Haiku, budget enforcement caps its output, and fan-out ensures it finishes in parallel with 3 other Haiku agents rather than waiting for a sequential Sonnet run. The compounding is real.

## Recommendation

Introduce a `CostAwareRunner` layer that sits between the orchestrator and `runAgent`. This layer owns all three concerns: budget checking, routing decisions, and fan-out dispatch. It is the single entry point for all agent execution in v3.

The architecture is a **pipeline with 6 stages** (see diagram above). Each stage is independently testable and replaceable. No existing interface is broken — `runAgent` remains unchanged; we wrap it.

## Implementation Sketch

### New directory structure

```
src/
  routing/
    task-complexity-router.ts    # From model-routing-researcher proposal
  budget/
    token-estimator.ts           # From budget-strategy-researcher proposal
    budget-envelope.ts           # From budget-strategy-researcher proposal
    budget-aware-runner.ts       # From budget-strategy-researcher proposal
  orchestrator/
    parallel-fan-out.ts          # From parallel-execution-researcher proposal
    cost-aware-runner.ts         # NEW — synthesis integration point (see below)
    cost-tracker.ts              # EXISTING — unchanged
```

### Updated type additions

```typescript
// src/types/agent.ts — add to AgentTemplate:

/** Per-invocation and per-session budget constraints. */
budget?: {
  maxCostPerInvocationUsd: number;
  maxCostPerSessionUsd: number;
};

/**
 * Minimum confidence threshold (0-1) below which this agent's output
 * triggers an escalation re-run on a higher model tier.
 * Defaults to 0.6 if not set.
 */
confidenceEscalationThreshold?: number;
```

```typescript
// src/types/orchestration.ts — add:

/**
 * Cost-aware execution directive passed from orchestrator to CostAwareRunner.
 * Replaces direct runAgent calls in orchestration logic.
 */
export interface CostAwareRunDirective {
  /** Agent to run. */
  agent: AgentTemplate;
  /** Task string. */
  task: string;
  /** Session budget envelope. */
  envelope: BudgetEnvelope;
  /** Cost tracker for this session. */
  costTracker: CostTracker;
  /** Optional fan-out config — if set, uses ParallelFanOutEngine instead of single runAgent. */
  fanOut?: FanOutDirective;
  /** Optional override to skip routing and use this tier directly. */
  forceTier?: ModelTier;
  /** Optional run context. */
  context?: RunContext;
}

/** Result from CostAwareRunner — extends AgentRunResult with cost metadata. */
export interface CostAwareRunResult extends AgentRunResult {
  routingDecision: RoutingDecision;
  budgetCheckResult: BudgetCheckResult;
  escalated: boolean;
  estimatedCostUsd: number;
  actualCostUsd: number;
}
```

### The `CostAwareRunner` — the synthesis integration point

```typescript
// src/orchestrator/cost-aware-runner.ts

import type { AgentTemplate, ModelTier } from "../types/agent.js";
import type { CostAwareRunDirective, CostAwareRunResult } from "../types/orchestration.js";
import { runAgent } from "../api/agent-runner.js";
import { routeTask, detectLowConfidence } from "../routing/task-complexity-router.js";
import { estimateTokensHeuristic } from "../budget/token-estimator.js";
import { BudgetExceededError } from "../budget/budget-aware-runner.js";
import { runParallelFanOut } from "./parallel-fan-out.js";

const MODEL_COSTS = {
  opus:   { input: 15.0,  output: 75.0  },
  sonnet: { input: 3.0,   output: 15.0  },
  haiku:  { input: 0.25,  output: 1.25  },
} as const;

function computeActualCost(model: ModelTier, inputTokens: number, outputTokens: number): number {
  const c = MODEL_COSTS[model];
  return (inputTokens / 1_000_000) * c.input + (outputTokens / 1_000_000) * c.output;
}

/**
 * The unified cost-aware execution entry point for AgentForge v3.
 *
 * Orchestrates: budget check → routing → fan-out (optional) → execution
 * → post-execution recording → escalation check.
 *
 * Replaces direct runAgent() calls in the orchestrator.
 */
export async function runCostAware(directive: CostAwareRunDirective): Promise<CostAwareRunResult> {
  const { agent, task, envelope, costTracker, fanOut, forceTier, context } = directive;

  // Build user message for estimation (mirrors runAgent internals)
  const parts: string[] = [];
  if (context?.projectInfo) parts.push(`## Project Context\n${context.projectInfo}`);
  if (context?.files?.length) parts.push(`## Relevant Files\n${context.files.join("\n")}`);
  parts.push(`## Task\n${task}`);
  const userMessage = parts.join("\n\n");

  // Stage 1: Route — determine which tier to actually use
  const routingDecision = forceTier
    ? {
        assignedTier: forceTier,
        ceilingTier: agent.model,
        complexityScore: -1,
        rationale: "forced",
        escalationAllowed: false,
      }
    : routeTask(task, agent.category, agent.model);

  // Stage 2: Estimate cost at the assigned tier
  const estimate = estimateTokensHeuristic(agent.system_prompt, userMessage, routingDecision.assignedTier);

  // Stage 3: Budget check
  const budgetCheck = envelope.checkBefore(estimate.estimatedTotalCostUsd, routingDecision.assignedTier);
  if (!budgetCheck.allowed) {
    throw new BudgetExceededError(agent.name, budgetCheck);
  }
  if (budgetCheck.action === "warn") {
    console.warn(`[CostAwareRunner] Budget warning for "${agent.name}": ${budgetCheck.remainingUsd.toFixed(4)} remaining`);
  }

  // Stage 4a: Fan-out path
  if (fanOut && agent.collaboration.parallel) {
    const fanOutResult = await runParallelFanOut({
      ...fanOut,
      task,
      costTracker,
      context,
    });
    const actualCost = computeActualCost(
      fanOutResult.mergeResult.model,
      fanOutResult.totalInputTokens,
      fanOutResult.totalOutputTokens,
    );
    envelope.recordActual(actualCost);

    return {
      ...fanOutResult.mergeResult,
      routingDecision,
      budgetCheckResult: budgetCheck,
      escalated: false,
      estimatedCostUsd: estimate.estimatedTotalCostUsd,
      actualCostUsd: actualCost,
    };
  }

  // Stage 4b: Single-agent path — run at the routed tier
  const tieredAgent: AgentTemplate = {
    ...agent,
    model: routingDecision.assignedTier,
    system_prompt: budgetCheck.budgetContextSnippet
      ? agent.system_prompt + budgetCheck.budgetContextSnippet
      : agent.system_prompt,
  };

  let runResult = await runAgent(tieredAgent, task, context);
  let escalated = false;

  // Stage 5: Post-execution recording
  const actualCost = computeActualCost(runResult.model, runResult.inputTokens, runResult.outputTokens);
  envelope.recordActual(actualCost);
  costTracker.recordUsage(agent.name, runResult.model, runResult.inputTokens, runResult.outputTokens);

  // Stage 6: Confidence-based escalation
  const minConfidence = agent.confidenceEscalationThreshold ?? 0.6;
  const shouldEscalate =
    routingDecision.escalationAllowed &&
    detectLowConfidence(runResult.response);

  if (shouldEscalate) {
    const escalationEstimate = estimateTokensHeuristic(
      agent.system_prompt, userMessage, routingDecision.ceilingTier
    );
    const escalationCheck = envelope.checkBefore(escalationEstimate.estimatedTotalCostUsd, routingDecision.ceilingTier);

    if (escalationCheck.allowed) {
      console.log(`[CostAwareRunner] Escalating "${agent.name}" from ${routingDecision.assignedTier} to ${routingDecision.ceilingTier}`);
      const escalatedAgent: AgentTemplate = { ...agent, model: routingDecision.ceilingTier };
      runResult = await runAgent(escalatedAgent, task, context);
      escalated = true;

      const escalationCost = computeActualCost(runResult.model, runResult.inputTokens, runResult.outputTokens);
      envelope.recordActual(escalationCost);
      costTracker.recordUsage(agent.name, runResult.model, runResult.inputTokens, runResult.outputTokens);
    }
  }

  return {
    ...runResult,
    routingDecision,
    budgetCheckResult: budgetCheck,
    escalated,
    estimatedCostUsd: estimate.estimatedTotalCostUsd,
    actualCostUsd: actualCost,
  };
}
```

### Orchestrator integration

The v3 orchestrator replaces all `runAgent(agent, task)` calls with:

```typescript
// Before (v2):
const result = await runAgent(agent, task, context);
costTracker.recordUsage(agent.name, result.model, result.inputTokens, result.outputTokens);

// After (v3):
const result = await runCostAware({
  agent,
  task,
  envelope: sessionEnvelope,
  costTracker,
  context,
});
// Budget recording, routing, escalation — all handled inside runCostAware
```

### Session initialization

```typescript
import { BudgetEnvelope, DEFAULT_THRESHOLDS } from "../budget/budget-envelope.js";
import { CostTracker } from "./cost-tracker.js";

export function createCostAwareSession(ceilingUsd: number) {
  const costTracker = new CostTracker();
  const envelope = new BudgetEnvelope({
    id: `session-${Date.now()}`,
    ceilingUsd,
    maxOutputTokensPerInvocation: 4096,
    thresholds: DEFAULT_THRESHOLDS,
    injectBudgetContext: true,
  });
  return { costTracker, envelope };
}
```

### Required changes to existing files

| File | Change | Reason |
|---|---|---|
| `src/types/agent.ts` | Add `category: AgentCategory` to `AgentTemplate` (it's typed but missing) | Required by router |
| `src/types/agent.ts` | Add optional `budget` and `confidenceEscalationThreshold` to `AgentTemplate` | Per-agent budget config |
| `src/types/orchestration.ts` | Add `CostAwareRunDirective`, `CostAwareRunResult`, `FanOutDirective` | New execution types |
| `src/orchestrator/cost-tracker.ts` | Export `MODEL_COSTS` constant (currently private) | Reused in budget-aware-runner and cost-aware-runner |
| `src/api/agent-runner.ts` | No changes required | Wrapped, not modified |
| `src/api/client.ts` | No changes required | Wrapped, not modified |

### Minimal migration path

v3 is fully backward-compatible with v2 agent templates. Existing `AgentTemplate` instances without `budget` or `confidenceEscalationThreshold` fields will use sensible defaults ($10 per session ceiling for new sessions, 0.6 confidence threshold for escalation). The `runAgent` function is not modified — only the orchestrator's call sites change.

## Cost Impact

**Compounded projections for a mixed workload (based on pricing in `src/orchestrator/cost-tracker.ts`):**

| Optimization layer | Mechanism | Estimated savings |
|---|---|---|
| Dynamic routing | Task complexity scoring downsamples 40% of Opus→Sonnet, 50% of Sonnet→Haiku | 35-55% |
| Fan-out (Opus tasks) | Haiku fan-out + Sonnet merge replaces single Opus | up to 70% on those tasks |
| Budget enforcement | Output capping, context injection, hard blocking | 10-20% |
| **Combined (with interaction effects)** | | **50-70% net reduction** |

**Wall-clock time improvement:** 20-40% reduction on sessions with 3+ parallel-eligible agents.

**Quality impact:** Neutral to positive. The routing system never exceeds the template ceiling tier. Escalation ensures low-confidence results are re-run at the appropriate tier. Fan-out produces higher-quality aggregate answers on research tasks due to multiple independent perspectives.

**Breaking changes:** None. The v3 architecture wraps v2 primitives without modifying them. Adoption can be incremental: replace one `runAgent` call at a time.

## Prioritized Implementation Order

1. **Export `MODEL_COSTS` from `cost-tracker.ts`** — 5 min, unblocks everything else
2. **Add `category` field to `AgentTemplate`** — required for routing; currently typed but missing from the interface
3. **Implement `TaskComplexityRouter`** (`src/routing/task-complexity-router.ts`) — highest ROI, standalone module
4. **Implement `TokenEstimator` + `BudgetEnvelope`** (`src/budget/`) — needed before `CostAwareRunner`
5. **Implement `CostAwareRunner`** (`src/orchestrator/cost-aware-runner.ts`) — integrates 1-4
6. **Implement `ParallelFanOutEngine`** (`src/orchestrator/parallel-fan-out.ts`) — can be done in parallel with 3-4
7. **Update orchestrator call sites** — one-line replacements of `runAgent` → `runCostAware`
8. **Add `budget` + `confidenceEscalationThreshold` to `AgentTemplate`** — optional but enables per-agent control

The first 5 steps can ship as a single PR. Steps 6-8 are independent follow-ons.
