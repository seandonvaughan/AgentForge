/**
 * Parallel fan-out engine for decomposing tasks into Haiku shards.
 *
 * Dispatches N agents simultaneously via Promise.allSettled,
 * collects fulfilled results, concatenates them with a separator,
 * and reports partial failure counts.
 */

import type { ModelTier, AgentCategory, AgentTemplate } from "../types/agent.js";
import type { FanOutConfig, FanOutResult } from "../types/budget.js";
import { runAgent } from "../api/agent-runner.js";

const SHARD_SEPARATOR = "\n\n---\n\n";

/**
 * Minimum task character length considered "decomposable".
 * Short tasks don't justify the overhead of fan-out.
 */
const MIN_DECOMPOSABLE_CHARS = 20;

/**
 * Decides whether a task should be fanned out.
 *
 * Fan-out makes sense when:
 *  - The ceiling tier is at least sonnet (not haiku — already cheap)
 *  - The task is long enough to decompose meaningfully
 */
export function shouldFanOut(
  task: string,
  _agentCategory: AgentCategory,
  ceilingTier: ModelTier,
): boolean {
  if (ceilingTier === "haiku") return false;
  if (task.length < MIN_DECOMPOSABLE_CHARS) return false;
  return true;
}

/**
 * Splits a task into sub-task strings for parallel shards.
 *
 * Strategy:
 *  - Split on " and " or ", " conjunctions
 *  - Each segment becomes one shard prompt
 *  - Always returns at least one shard
 */
export function decomposeTask(task: string): string[] {
  // Split on " and " or commas (capturing the full surrounding context)
  const parts = task.split(/\s+and\s+|,\s*/i).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [task];
}

/**
 * Builds a minimal agent template for a shard with the given tier.
 */
function makeShardAgent(tier: ModelTier, shardIndex: number): AgentTemplate {
  return {
    name: `shard-agent-${shardIndex}`,
    model: tier,
    version: "1.0.0",
    description: "Fan-out shard agent",
    system_prompt:
      "You are a focused research assistant. Answer only the specific subtask given to you. Be concise.",
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: { reports_to: null, reviews_from: [], can_delegate_to: [], parallel: true },
    context: { max_files: 0, auto_include: [], project_specific: [] },
  };
}

/**
 * Runs N shards in parallel and merges their results.
 *
 * Shard count comes from config.shardCount. If the task can be
 * decomposed into fewer parts than shardCount, each decomposed part
 * becomes one shard prompt; otherwise shards get the full task with
 * an index hint for variety.
 */
export async function runParallelFanOut(config: FanOutConfig): Promise<FanOutResult> {
  const { task, shardCount, shardTier } = config;

  // Decompose task into shard prompts
  const decomposed = decomposeTask(task);
  const shardPrompts: string[] = [];
  for (let i = 0; i < shardCount; i++) {
    if (i < decomposed.length) {
      shardPrompts.push(decomposed[i]);
    } else {
      shardPrompts.push(`${task} (part ${i + 1} of ${shardCount})`);
    }
  }

  // Dispatch all shards simultaneously
  const settled = await Promise.allSettled(
    shardPrompts.map((prompt, idx) =>
      runAgent(makeShardAgent(shardTier, idx), prompt),
    ),
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let successCount = 0;
  let failureCount = 0;
  const mergedParts: string[] = [];

  const shardResults: FanOutResult["shardResults"] = settled.map((outcome) => {
    if (outcome.status === "fulfilled") {
      const r = outcome.value;
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      successCount++;
      mergedParts.push(r.response);
      return {
        content: r.response,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      };
    } else {
      failureCount++;
      return null;
    }
  });

  return {
    shardResults,
    mergedContent: mergedParts.join(SHARD_SEPARATOR),
    totalInputTokens,
    totalOutputTokens,
    successCount,
    failureCount,
  };
}
