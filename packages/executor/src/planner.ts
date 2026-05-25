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

const SELF_MODIFICATION_HINTS = ['self-modification', 'self modification', 'reforge'];

export function isSelfModificationProposal(proposal: AgentProposal): boolean {
  const titleAndDescription = `${proposal.title} ${proposal.description}`.toLowerCase();
  if (SELF_MODIFICATION_HINTS.some((hint) => titleAndDescription.includes(hint))) {
    return true;
  }
  return proposal.tags.some((tag) => {
    const normalized = tag.toLowerCase();
    return normalized === 'self-modification' || normalized === 'self_modification' || normalized === 'reforge';
  });
}

export function buildPlan(proposal: AgentProposal): ExecutionPlan {
  const complexity = inferComplexity(proposal);
  const includeCanary = isSelfModificationProposal(proposal);

  const baseStages = complexity === 'high'
    ? ['planning', 'architecture', 'coding', 'linting', 'testing'] as const
    : complexity === 'medium'
    ? ['planning', 'coding', 'linting', 'testing'] as const
    : ['planning', 'coding', 'testing'] as const;
  const stages = [...baseStages, ...(includeCanary ? ['canary' as const] : []), 'complete' as const];

  const agents = complexity === 'high'
    ? ['project-manager', 'architect', 'coder', 'linter', 'debugger', ...(includeCanary ? ['qa-manager'] : [])]
    : complexity === 'medium'
    ? ['project-manager', 'coder', 'linter', 'debugger', ...(includeCanary ? ['qa-manager'] : [])]
    : ['coder', 'debugger', ...(includeCanary ? ['qa-manager'] : [])];

  return {
    proposalId: proposal.id,
    stages: [...stages],
    estimatedAgents: agents,
    estimatedComplexity: complexity,
    sandboxed: true,
    createdAt: nowIso(),
  };
}
