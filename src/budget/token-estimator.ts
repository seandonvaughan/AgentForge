/**
 * Token estimator for pre-flight cost checks.
 *
 * Uses a character-based heuristic (chars / 4 ≈ tokens) to estimate
 * input tokens, MODEL_DEFAULTS maxTokens * 0.3 for expected output,
 * and MODEL_COSTS for pricing — with a 20% safety buffer added to
 * the final cost estimate.
 */

import type { ModelTier } from "../types/agent.js";
import type { TokenEstimate } from "../types/budget.js";
import { MODEL_COSTS } from "../orchestrator/cost-tracker.js";
import { MODEL_DEFAULTS } from "../api/client.js";

/**
 * Estimates token usage and cost for a prompt before execution.
 *
 * @param systemPrompt - The agent system prompt text.
 * @param userMessage  - The user task / message text.
 * @param tier         - The model tier to price against.
 * @returns A TokenEstimate with input/output tokens and buffered cost.
 */
export function estimateTokensHeuristic(
  systemPrompt: string,
  userMessage: string,
  tier: ModelTier,
): TokenEstimate {
  const totalChars = systemPrompt.length + userMessage.length;
  const inputTokens = Math.ceil(totalChars / 4);

  const maxTokens = MODEL_DEFAULTS[tier].maxTokens;
  const outputTokens = Math.round(maxTokens * 0.3);

  const costs = MODEL_COSTS[tier];
  const rawCost =
    (inputTokens / 1_000_000) * costs.input +
    (outputTokens / 1_000_000) * costs.output;

  const estimatedTotalCostUsd = rawCost * 1.2;

  return { inputTokens, outputTokens, estimatedTotalCostUsd };
}
