/**
 * Budget and cost-optimization type definitions for AgentForge v3 Phase 2a.
 *
 * Used by TokenEstimator, BudgetEnvelope, ParallelFanOutEngine,
 * and CostAwareRunner to track spend and gate executions.
 */

import type { ModelTier } from "./agent.js";

/** Token count and cost estimate produced before an agent run. */
export interface TokenEstimate {
  /** Estimated number of input (prompt) tokens. */
  inputTokens: number;
  /** Estimated number of output (completion) tokens. */
  outputTokens: number;
  /** Estimated total cost in US dollars (with 20% safety buffer). */
  estimatedTotalCostUsd: number;
}

/** Result of checking a cost estimate against an envelope budget. */
export interface BudgetCheckResult {
  /** Whether the run is allowed to proceed. */
  allowed: boolean;
  /** Action directive — how the caller should respond. */
  action: "proceed" | "warn" | "approve" | "block";
  /** How many dollars remain in the envelope after this estimate. */
  remainingUsd: number;
  /** Percent of total budget consumed (0–100+). */
  percentUsed: number;
  /** Optional snippet to inject into the agent prompt for frugality. */
  budgetContextSnippet?: string;
}

/** Configuration for a parallel fan-out execution. */
export interface FanOutConfig {
  /** The full task to decompose and fan out. */
  task: string;
  /** Number of shards to create. */
  shardCount: number;
  /** Model tier used for shard execution. */
  shardTier: ModelTier;
  /** Model tier used for the merge step. */
  mergerTier: ModelTier;
}

/** Result of a fan-out execution across N shards. */
export interface FanOutResult {
  /**
   * Per-shard results — null when the shard failed or was rejected.
   */
  shardResults: Array<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  } | null>;
  /** All fulfilled shard outputs concatenated with a separator. */
  mergedContent: string;
  /** Sum of input tokens across all shards. */
  totalInputTokens: number;
  /** Sum of output tokens across all shards. */
  totalOutputTokens: number;
  /** Number of shards that succeeded. */
  successCount: number;
  /** Number of shards that failed. */
  failureCount: number;
}

/** Directive passed to CostAwareRunner. */
export interface CostAwareRunDirective {
  /** The agent template to run. */
  agent: import("./agent.js").AgentTemplate;
  /** The task string to execute. */
  task: string;
  /** Budget envelope governing this run. */
  envelope: import("../budget/budget-envelope.js").BudgetEnvelope;
  /** Whether to attempt parallel fan-out for decomposable tasks. */
  allowFanOut?: boolean;
  /** Tier ceiling for fan-out shards (defaults to haiku). */
  fanOutShardTier?: ModelTier;
}

/** Result from CostAwareRunner.runCostAware. */
export interface CostAwareRunResult {
  /** Content of the final response. */
  content: string;
  /** Tier actually used. */
  modelUsed: ModelTier;
  /** Input tokens consumed. */
  inputTokens: number;
  /** Output tokens consumed. */
  outputTokens: number;
  /** Budget check that was applied before execution. */
  budgetCheck: BudgetCheckResult;
  /** Whether fan-out was used for this run. */
  usedFanOut: boolean;
  /** Whether the response triggered low-confidence escalation. */
  escalated: boolean;
  /** Routing decision that was applied. */
  routingDecision: import("../routing/task-complexity-router.js").RoutingDecision;
}
