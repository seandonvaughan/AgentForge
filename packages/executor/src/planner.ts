import { nowIso } from '@agentforge/shared';
import type { AgentProposal } from '@agentforge/core';
import type { CanaryDeploymentPlan, ExecutionPlan } from './types.js';

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

const SELF_MODIFICATION_TAGS = new Set([
  'self-modification',
  'self-modifications',
  'canary',
  'feature-flag',
  'feature-flags',
  'rollback',
  'reforge',
  'agent-override',
]);

const SELF_MODIFICATION_PHRASES = [
  'self-modification',
  'self modification',
  'canary deployment',
  'feature flag',
  'traffic split',
  'traffic splitting',
  'auto-rollback',
  'agent override',
  'system prompt',
  'prompt preamble',
  'model routing',
  'model tier',
];

function isSelfModifyingProposal(proposal: AgentProposal): boolean {
  if (proposal.tags.some(tag => SELF_MODIFICATION_TAGS.has(tag.toLowerCase()))) {
    return true;
  }

  const text = `${proposal.title} ${proposal.description}`.toLowerCase();
  return SELF_MODIFICATION_PHRASES.some(phrase => text.includes(phrase));
}

function buildDeploymentPlan(proposal: AgentProposal): CanaryDeploymentPlan {
  const canary = isSelfModifyingProposal(proposal);
  return {
    mode: canary ? 'canary' : 'standard',
    trafficPercent: canary ? 10 : 100,
    rollbackThreshold: canary ? 0.1 : 1,
    minimumSampleSize: canary ? 3 : 0,
    reason: canary
      ? 'Self-modifying proposal routed through a canary rollout before full promotion.'
      : 'Standard proposal execution does not require canary traffic splitting.',
  };
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
    deployment: buildDeploymentPlan(proposal),
    createdAt: nowIso(),
  };
}
