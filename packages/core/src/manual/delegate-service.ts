import type { RuntimeMode } from '../runtime/types.js';
import {
  invokeAgentRun,
  type InvokeAgentRunResult,
} from './invoke-service.js';
import { listCatalogAgents, type CatalogAgent } from './agent-catalog.js';

export interface DelegateTaskOptions {
  projectRoot: string;
  task: string;
  limit?: number;
  run?: boolean;
  runtimeMode?: RuntimeMode;
  allowedTools?: string[];
  budgetUsd?: number;
  dataDir?: string;
}

export interface DelegateRecommendation {
  agentId: string;
  name: string;
  model: CatalogAgent['model'];
  score: number;
  confidence: number;
  reasons: string[];
}

export interface DelegateTaskResult {
  task: string;
  recommendations: DelegateRecommendation[];
  selected: DelegateRecommendation | null;
  invoked?: InvokeAgentRunResult;
}

export async function delegateTask(
  options: DelegateTaskOptions,
): Promise<DelegateTaskResult> {
  const agents = await listCatalogAgents(options.projectRoot);
  const scored = agents
    .map((agent) => scoreAgent(agent, options.task))
    .sort((left, right) => right.score - left.score);

  const maxScore = scored[0]?.score ?? 0;
  const limit = Math.min(options.limit ?? 5, Math.max(scored.length, 1));
  const recommendations = scored.slice(0, limit).map((entry) => ({
    agentId: entry.agent.agentId,
    name: entry.agent.name,
    model: entry.agent.model,
    score: entry.score,
    confidence: maxScore > 0 ? Math.max(1, Math.round((entry.score / maxScore) * 100)) : 0,
    reasons: entry.reasons,
  }));

  const selected = recommendations[0] ?? null;
  if (!options.run || !selected) {
    return {
      task: options.task,
      recommendations,
      selected,
    };
  }

  const invoked = await invokeAgentRun({
    projectRoot: options.projectRoot,
    agent: selected.agentId,
    task: options.task,
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    ...(options.allowedTools?.length ? { allowedTools: options.allowedTools } : {}),
    ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  });

  return {
    task: options.task,
    recommendations,
    selected,
    invoked,
  };
}

function scoreAgent(
  agent: CatalogAgent,
  task: string,
): { agent: CatalogAgent; score: number; reasons: string[] } {
  const taskLower = task.toLowerCase();
  const taskWords = taskLower.split(/\s+/);
  const reasons: string[] = [];
  let score = 5;

  for (const keyword of agent.keywords) {
    if (taskLower.includes(keyword.toLowerCase())) {
      score += 30;
      reasons.push(`Keyword match: "${keyword}"`);
    }
  }

  for (const pattern of agent.filePatterns) {
    const extensionHint = pattern.replace(/^\*\./, '').replace(/\*/g, '');
    if (extensionHint && taskLower.includes(extensionHint.toLowerCase())) {
      score += 15;
      reasons.push(`File pattern hint: "${pattern}"`);
    }
  }

  for (const skill of agent.skills) {
    if (taskLower.includes(skill.toLowerCase())) {
      score += 25;
      reasons.push(`Skill match: "${skill}"`);
    }
  }

  const descriptionWords = agent.description.toLowerCase().split(/\s+/);
  const overlap = taskWords.filter((word) => word.length > 3 && descriptionWords.includes(word));
  if (overlap.length > 0) {
    score += overlap.length * 5;
    reasons.push(`Description overlap: ${overlap.join(', ')}`);
  }

  if (reasons.length === 0) {
    reasons.push('Baseline capability match');
  }

  return { agent, score, reasons };
}
