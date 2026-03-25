/**
 * Cost-Aware Runner — the 6-stage cost-optimized execution pipeline.
 *
 * Stages:
 *   1. Budget check     — gate against BudgetEnvelope before any spend
 *   2. Routing          — pick the cheapest appropriate ModelTier
 *   3. Fan-out decision — decompose if beneficial
 *   4. Execution        — call runAgent (wrapped, never modified)
 *   5. Recording        — commit actual cost to envelope
 *   6. Escalation       — flag low-confidence responses
 *
 * Iron Law 1: runAgent is never modified — only wrapped.
 */

import type { AgentTemplate } from "../types/agent.js";
import type {
  CostAwareRunDirective,
  CostAwareRunResult,
  FanOutConfig,
} from "../types/budget.js";
import type { BudgetCheckResult } from "../types/budget.js";
import { runAgent } from "../api/agent-runner.js";
import { estimateTokensHeuristic } from "../budget/token-estimator.js";
import { MODEL_COSTS } from "./cost-tracker.js";
import { routeTask, detectLowConfidence } from "../routing/task-complexity-router.js";
import { shouldFanOut, runParallelFanOut } from "./parallel-fan-out.js";

/**
 * Executes an agent through the 6-stage cost-aware pipeline.
 *
 * Throws if the budget envelope blocks the run.
 */
export async function runCostAware(
  directive: CostAwareRunDirective,
): Promise<CostAwareRunResult> {
  const { agent, task, envelope, allowFanOut = false } = directive;
  const fanOutShardTier = directive.fanOutShardTier ?? "haiku";

  // ── Stage 1: Budget check ────────────────────────────────────────────────
  const estimate = estimateTokensHeuristic(agent.system_prompt, task, agent.model);
  const budgetCheck: BudgetCheckResult = envelope.checkBefore(
    estimate.estimatedTotalCostUsd,
    agent.model,
  );

  if (!budgetCheck.allowed) {
    throw new Error(
      `Budget envelope blocked execution: action=${budgetCheck.action}, ` +
      `remaining=$${budgetCheck.remainingUsd.toFixed(6)}`,
    );
  }

  // ── Stage 2: Routing ─────────────────────────────────────────────────────
  const agentCategory = agent.category ?? "utility";
  const routingDecision = routeTask(task, agentCategory, agent.model);
  const resolvedTier = routingDecision.assignedTier;

  // Build routed agent (same template, possibly cheaper tier)
  const routedAgent: AgentTemplate = { ...agent, model: resolvedTier };

  // ── Stage 3: Fan-out decision ────────────────────────────────────────────
  const doFanOut =
    allowFanOut &&
    shouldFanOut(task, agentCategory, agent.model);

  let content: string;
  let inputTokens: number;
  let outputTokens: number;

  if (doFanOut) {
    // ── Stage 4a: Fan-out execution ────────────────────────────────────────
    const fanConfig: FanOutConfig = {
      task,
      shardCount: 3,
      shardTier: fanOutShardTier,
      mergerTier: fanOutShardTier,
    };

    const fanResult = await runParallelFanOut(fanConfig);
    content = fanResult.mergedContent;
    inputTokens = fanResult.totalInputTokens;
    outputTokens = fanResult.totalOutputTokens;
  } else {
    // ── Stage 4b: Single agent execution ──────────────────────────────────
    const runResult = await runAgent(routedAgent, task);
    content = runResult.response;
    inputTokens = runResult.inputTokens;
    outputTokens = runResult.outputTokens;
  }

  // ── Stage 5: Recording ───────────────────────────────────────────────────
  const costs = MODEL_COSTS[resolvedTier];
  const actualCost =
    (inputTokens / 1_000_000) * costs.input +
    (outputTokens / 1_000_000) * costs.output;

  envelope.recordActual(actualCost);

  // ── Stage 6: Escalation ──────────────────────────────────────────────────
  const escalated = detectLowConfidence(content);

  return {
    content,
    modelUsed: resolvedTier,
    inputTokens,
    outputTokens,
    budgetCheck,
    usedFanOut: doFanOut,
    escalated,
    routingDecision,
  };
}
