import { generateId, nowIso } from '@agentforge/shared';
import type { AgentProposal } from '@agentforge/core';
import type { ExecutionPlan } from './types.js';

const COMPLEXITY_KEYWORDS = {
  high: ['architecture', 'refactor', 'migrate', 'overhaul', 'redesign', 'replace'],
  medium: ['add', 'implement', 'improve', 'optimize', 'update', 'extend'],
  low: ['fix', 'patch', 'tweak', 'rename', 'remove', 'minor'],
};

function inferComplexity(proposal: AgentProposal): 'low' | 'medium' | 'high' {
  const text = `${proposal.title} ${proposal.description}`.toLowerCase();
  if (COMPLEXITY_KEYWORDS.high.some(k => text.includes(k))) return 'high';
  if (COMPLEXITY_KEYWORDS.low.some(k => text.includes(k))) return 'low';
  return 'medium';
}

function isSelfModificationProposal(proposal: AgentProposal): boolean {
  const text = `${proposal.title} ${proposal.description}`.toLowerCase();
  const markers = ['self-modification', 'self modification', 'self-mod', 'reforge'];
  if (markers.some((marker) => text.includes(marker))) return true;

  const tagSet = new Set(proposal.tags.map((tag) => tag.toLowerCase()));
  return tagSet.has('self-modification') || tagSet.has('self-mod');
}

export function buildPlan(proposal: AgentProposal): ExecutionPlan {
  const complexity = inferComplexity(proposal);
  const selfModification = isSelfModificationProposal(proposal);

  const stages = complexity === 'high'
    ? ['planning', 'architecture', 'coding', 'linting', 'testing'] as const
    : complexity === 'medium'
    ? ['planning', 'coding', 'linting', 'testing'] as const
    : ['planning', 'coding', 'testing'] as const;

  const plannedStages = selfModification
    ? [...stages, 'canary', 'complete'] as const
    : [...stages, 'complete'] as const;

  const agents = complexity === 'high'
    ? ['project-manager', 'architect', 'coder', 'linter', 'debugger']
    : complexity === 'medium'
    ? ['project-manager', 'coder', 'linter', 'debugger']
    : ['coder', 'debugger'];

  const plannedAgents = selfModification
    ? [...agents, 'safety-reviewer']
    : agents;

  return {
    proposalId: proposal.id,
    stages: [...plannedStages],
    estimatedAgents: plannedAgents,
    estimatedComplexity: complexity,
    ...(selfModification
      ? {
          canary: {
            enabled: true,
            reason: 'self-modification safety policy',
            rollbackOnFailure: true,
            minSuccessfulStages: 2,
          },
        }
      : {}),
    sandboxed: true,
    createdAt: nowIso(),
  };
}
