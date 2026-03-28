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

export function buildPlan(proposal: AgentProposal): ExecutionPlan {
  const complexity = inferComplexity(proposal);

  const stages = complexity === 'high'
    ? ['planning', 'architecture', 'coding', 'linting', 'testing', 'complete'] as const
    : complexity === 'medium'
    ? ['planning', 'coding', 'linting', 'testing', 'complete'] as const
    : ['planning', 'coding', 'testing', 'complete'] as const;

  const agents = complexity === 'high'
    ? ['project-manager', 'architect', 'coder', 'linter', 'debugger']
    : complexity === 'medium'
    ? ['project-manager', 'coder', 'linter', 'debugger']
    : ['coder', 'debugger'];

  return {
    proposalId: proposal.id,
    stages: [...stages],
    estimatedAgents: agents,
    estimatedComplexity: complexity,
    sandboxed: true,
    createdAt: nowIso(),
  };
}
