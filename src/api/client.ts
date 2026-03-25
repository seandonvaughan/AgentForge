/**
 * Claude CLI subprocess client for the AgentForge system.
 *
 * Invokes `claude -p` (print mode) instead of the Anthropic SDK so that
 * agent runs use the current Claude Code Max-plan OAuth auth rather than
 * requiring a separate ANTHROPIC_API_KEY.
 */

import { execFileSync } from "node:child_process";
import type { ModelTier, EffortLevel } from "../types/index.js";

/** Maps each ModelTier to its concrete Claude model ID. */
export const MODEL_MAP: Record<ModelTier, string> = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
};

/** Default maxTokens for each model tier (used by token estimator). */
export const MODEL_DEFAULTS: Record<ModelTier, { maxTokens: number; temperature: number }> = {
  opus: { maxTokens: 4096, temperature: 0.7 },
  sonnet: { maxTokens: 4096, temperature: 0.5 },
  haiku: { maxTokens: 2048, temperature: 0.3 },
};

/** Default effort level per model tier. */
export const MODEL_EFFORT_DEFAULTS: Record<ModelTier, EffortLevel> = {
  opus: "high",
  sonnet: "medium",
  haiku: "low",
};

/** Parameters accepted by {@link sendMessage}. */
export interface SendMessageParams {
  /** Model tier to use for the invocation. */
  model: ModelTier;
  /** System prompt for the conversation. */
  systemPrompt: string;
  /** The user message / task to send. */
  userMessage: string;
  /** Reasoning effort level for this invocation. */
  effort?: EffortLevel;
  /** Maximum USD spend for this invocation (budget cap). */
  maxBudgetUsd?: number;
}

/** Structured result returned by {@link sendMessage}. */
export interface SendMessageResult {
  /** The text content of the model's response. */
  content: string;
  /** Number of input (prompt) tokens consumed. */
  inputTokens: number;
  /** Number of output (completion) tokens consumed. */
  outputTokens: number;
  /** Total cost in USD (from claude CLI usage data). */
  costUsd: number;
  /** Actual model ID used (may differ if claude auto-routed). */
  modelUsed: string;
}

/**
 * Parses the `--output-format stream-json --verbose` output from `claude -p`.
 *
 * The CLI streams JSON lines. Text lives in assistant message content blocks;
 * cost and token counts live in the final result line.
 */
function parseStreamJsonOutput(raw: string): SendMessageResult {
  const lines = raw.trim().split("\n").filter(Boolean);

  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let modelUsed = "";

  for (const line of lines) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Assistant message content blocks carry the text response.
    if (data["type"] === "assistant") {
      const msg = data["message"] as Record<string, unknown> | undefined;
      const contentArr = msg?.["content"] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(contentArr)) {
        for (const block of contentArr) {
          if (block["type"] === "text" && typeof block["text"] === "string") {
            content += block["text"];
          }
        }
      }
    }

    // Result line carries cost and usage data.
    if (data["type"] === "result") {
      costUsd = (data["total_cost_usd"] as number | undefined) ?? 0;

      // Top-level usage uses snake_case field names.
      const usage = data["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = (usage["input_tokens"] as number | undefined) ?? 0;
        outputTokens = (usage["output_tokens"] as number | undefined) ?? 0;
      }

      // modelUsage is a map of modelId → { inputTokens, outputTokens, ... }
      // Keys use camelCase. Prefer this for the model name; token totals are
      // already correct from usage above.
      const modelUsage = data["modelUsage"] as Record<string, unknown> | undefined;
      if (modelUsage) {
        const modelIds = Object.keys(modelUsage);
        if (modelIds.length > 0) {
          modelUsed = modelIds[0]!;
        }
      }
    }
  }

  return { content, inputTokens, outputTokens, costUsd, modelUsed };
}

/**
 * Sends a message using `claude -p` (print mode).
 *
 * Uses the current Claude Code Max-plan OAuth auth — no API key required.
 * The response text is extracted from stream-json content blocks.
 */
export function sendMessage(params: SendMessageParams): SendMessageResult {
  const modelId = MODEL_MAP[params.model];
  const effort = params.effort ?? MODEL_EFFORT_DEFAULTS[params.model];

  const args: string[] = [
    "-p",
    params.userMessage,
    "--system-prompt",
    params.systemPrompt,
    "--model",
    modelId,
    "--effort",
    effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  if (params.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", params.maxBudgetUsd.toFixed(2));
  }

  const raw = execFileSync("claude", args, {
    encoding: "utf-8",
    timeout: 300_000, // 5 minutes
    input: "",
  });

  const result = parseStreamJsonOutput(raw);

  // Fallback: if modelUsed is still empty, use the requested model ID.
  if (!result.modelUsed) {
    result.modelUsed = modelId;
  }

  return result;
}
