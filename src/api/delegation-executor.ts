/**
 * Delegation Executor for the AgentForge system.
 *
 * Handles the execution of delegated tasks between agents,
 * running the delegate agent and producing a summary suitable
 * for feeding back to the requesting agent.
 */

import type { AgentTemplate } from "../types/index.js";
import { runAgent } from "./agent-runner.js";
import type { AgentRunResult } from "./agent-runner.js";

/** Result of a delegation execution. */
export interface DelegationExecResult {
  /** Full result from running the delegate agent. */
  delegateResult: AgentRunResult;
  /** Concise summary suitable for feeding back to the requesting agent. */
  summary: string;
}

/**
 * Executes a delegated task by running the target agent and
 * returning the result along with a summary.
 *
 * @param fromAgent - The agent that requested the delegation.
 * @param toAgent   - The agent that will execute the delegated task.
 * @param task      - The task description to delegate.
 * @param context   - Optional file context to pass to the delegate.
 */
export async function executeDelegation(
  fromAgent: AgentTemplate,
  toAgent: AgentTemplate,
  task: string,
  context?: { files?: string[] },
): Promise<DelegationExecResult> {
  const delegateResult = await runAgent(toAgent, task, context);

  // Build a concise summary for the requesting agent.
  const responsePreview = delegateResult.response.length > 500
    ? delegateResult.response.slice(0, 500) + "..."
    : delegateResult.response;

  const summary = [
    `Delegation from "${fromAgent.name}" to "${toAgent.name}" completed.`,
    `Model: ${toAgent.model} | Tokens: ${delegateResult.inputTokens + delegateResult.outputTokens} | Duration: ${delegateResult.duration_ms}ms`,
    ``,
    `Response:`,
    responsePreview,
  ].join("\n");

  return { delegateResult, summary };
}
