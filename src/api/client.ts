/**
 * Anthropic API client wrapper for the AgentForge system.
 *
 * Provides model configuration, a singleton client, and a high-level
 * `sendMessage` function that maps ModelTier to real Claude model IDs.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelTier } from "../types/index.js";

/** Configuration for a specific model invocation. */
export interface ModelConfig {
  /** The actual Anthropic model ID (e.g. "claude-opus-4-20250514"). */
  model: string;
  /** Maximum number of tokens to generate. */
  maxTokens: number;
  /** Sampling temperature. */
  temperature: number;
}

/** Maps each ModelTier to its concrete Anthropic model ID. */
export const MODEL_MAP: Record<ModelTier, string> = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
};

/** Default maxTokens and temperature for each model tier. */
export const MODEL_DEFAULTS: Record<ModelTier, { maxTokens: number; temperature: number }> = {
  opus: { maxTokens: 4096, temperature: 0.7 },
  sonnet: { maxTokens: 4096, temperature: 0.5 },
  haiku: { maxTokens: 2048, temperature: 0.3 },
};

/** Cached singleton client instance. */
let cachedClient: Anthropic | null = null;

/**
 * Creates (or returns the cached) Anthropic client.
 *
 * Reads `ANTHROPIC_API_KEY` from the environment. Throws a descriptive
 * error if the key is missing.
 */
export function createClient(): Anthropic {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. " +
      "Please set the ANTHROPIC_API_KEY environment variable to your Anthropic API key. " +
      "You can obtain one at https://console.anthropic.com/",
    );
  }

  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/** Parameters accepted by {@link sendMessage}. */
export interface SendMessageParams {
  /** Model tier to use for the invocation. */
  model: ModelTier;
  /** System prompt for the conversation. */
  systemPrompt: string;
  /** The user message / task to send. */
  userMessage: string;
  /** Override default maxTokens for this tier. */
  maxTokens?: number;
  /** Override default temperature for this tier. */
  temperature?: number;
}

/** Structured result returned by {@link sendMessage}. */
export interface SendMessageResult {
  /** The text content of the model's response. */
  content: string;
  /** Number of input (prompt) tokens consumed. */
  inputTokens: number;
  /** Number of output (completion) tokens consumed. */
  outputTokens: number;
}

/**
 * Sends a message to the Anthropic API using the appropriate model
 * for the given tier.
 *
 * Maps the ModelTier to a concrete model ID, applies default or
 * overridden parameters, and returns the text response with token counts.
 */
export async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const client = createClient();
  const modelId = MODEL_MAP[params.model];
  const defaults = MODEL_DEFAULTS[params.model];

  const response = await client.messages.create({
    model: modelId,
    max_tokens: params.maxTokens ?? defaults.maxTokens,
    temperature: params.temperature ?? defaults.temperature,
    system: params.systemPrompt,
    messages: [
      { role: "user", content: params.userMessage },
    ],
  });

  // Extract text from the response content blocks.
  const textContent = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    content: textContent,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
