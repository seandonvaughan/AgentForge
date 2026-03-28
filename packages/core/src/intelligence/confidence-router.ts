import type { RoutingDecision, TaskComplexity } from './types.js';

const COMPLEXITY_SIGNALS: Record<TaskComplexity, string[]> = {
  simple: ['list', 'format', 'sort', 'count', 'echo', 'summarize', 'lint'],
  moderate: ['write', 'create', 'update', 'fix', 'test', 'document', 'review'],
  complex: ['design', 'architect', 'refactor', 'debug', 'analyze', 'optimize', 'implement'],
  strategic: ['plan', 'vision', 'strategy', 'roadmap', 'evaluate', 'decide', 'assess'],
};

const MODEL_CONFIDENCE: Record<'opus' | 'sonnet' | 'haiku', number> = {
  opus: 0.95,
  sonnet: 0.75,
  haiku: 0.55,
};

function classifyTask(task: string): TaskComplexity {
  const lower = task.toLowerCase();
  for (const [complexity, signals] of Object.entries(COMPLEXITY_SIGNALS) as Array<[TaskComplexity, string[]]>) {
    if (signals.some(s => lower.includes(s))) return complexity;
  }
  return 'moderate';
}

function selectModel(complexity: TaskComplexity, minConfidence: number): 'opus' | 'sonnet' | 'haiku' {
  // Start from cheapest, escalate until confidence threshold met
  if (complexity === 'simple' && minConfidence <= MODEL_CONFIDENCE.haiku) return 'haiku';
  if (complexity !== 'strategic' && minConfidence <= MODEL_CONFIDENCE.sonnet) return 'sonnet';
  return 'opus';
}

export class ConfidenceRouter {
  /**
   * Decide which model to use for a task.
   * @param agentId The agent making the request
   * @param task The task description
   * @param minConfidence Minimum acceptable confidence (0–1, default 0.7)
   * @param agentDefaultModel The agent's configured default model
   */
  route(
    agentId: string,
    task: string,
    minConfidence = 0.7,
    agentDefaultModel: 'opus' | 'sonnet' | 'haiku' = 'sonnet',
  ): RoutingDecision {
    const complexity = classifyTask(task);
    const selected = selectModel(complexity, minConfidence);

    // Don't downgrade from agent's configured model
    const modelPriority = { opus: 3, sonnet: 2, haiku: 1 };
    const finalModel = modelPriority[selected] >= modelPriority[agentDefaultModel]
      ? selected
      : agentDefaultModel;

    return {
      agentId,
      task,
      selectedModel: finalModel,
      confidence: MODEL_CONFIDENCE[finalModel],
      reasoning: `Task complexity: ${complexity}. Min confidence: ${minConfidence}. Selected: ${finalModel} (confidence: ${MODEL_CONFIDENCE[finalModel]})`,
      ...(finalModel !== 'opus' && { fallbackModel: (finalModel === 'haiku' ? 'sonnet' : 'opus') as 'opus' | 'sonnet' | 'haiku' }),
    };
  }

  /** Check if a routing decision meets the confidence threshold. */
  meetsThreshold(decision: RoutingDecision, threshold: number): boolean {
    return decision.confidence >= threshold;
  }
}
