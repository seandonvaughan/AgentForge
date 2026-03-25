/**
 * Agent Runner for the AgentForge system.
 *
 * Executes an agent against a task by calling the Anthropic API
 * with the agent's configured model tier and system prompt.
 */

import type { AgentTemplate, ModelTier } from "../types/index.js";
import { sendMessage } from "./client.js";

/** Result of running an agent against a task. */
export interface AgentRunResult {
  /** Name of the agent that was run. */
  agent: string;
  /** Model tier used for the invocation. */
  model: ModelTier;
  /** The model's text response. */
  response: string;
  /** Number of input (prompt) tokens consumed. */
  inputTokens: number;
  /** Number of output (completion) tokens consumed. */
  outputTokens: number;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
  /** Names of agents this run delegated to (populated externally). */
  delegations: string[];
}

/** Optional context to include alongside the task. */
export interface RunContext {
  /** File contents or paths to include in the prompt. */
  files?: string[];
  /** High-level project information to provide as context. */
  projectInfo?: string;
}

/**
 * Runs an agent by sending its system prompt and the user's task
 * to the Anthropic API using the agent's configured model tier.
 */
export async function runAgent(
  agent: AgentTemplate,
  task: string,
  context?: RunContext,
): Promise<AgentRunResult> {
  // Build user message from task and optional context.
  const parts: string[] = [];

  if (context?.projectInfo) {
    parts.push(`## Project Context\n${context.projectInfo}`);
  }

  if (context?.files && context.files.length > 0) {
    parts.push(`## Relevant Files\n${context.files.join("\n")}`);
  }

  parts.push(`## Task\n${task}`);

  const userMessage = parts.join("\n\n");

  const start = Date.now();

  const result = await sendMessage({
    model: agent.model,
    systemPrompt: agent.system_prompt,
    userMessage,
  });

  const duration_ms = Date.now() - start;

  return {
    agent: agent.name,
    model: agent.model,
    response: result.content,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    duration_ms,
    delegations: [],
  };
}
