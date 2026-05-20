import { nowIso } from '@agentforge/shared';
import { getGlobalTraceCollector } from '@agentforge/core';
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

export function buildPlan(proposal: AgentProposal, options: { traceId?: string } = {}): ExecutionPlan {
  const collector = getGlobalTraceCollector();
  const span = collector.startRootSpan({
    ...(options.traceId ? { traceId: options.traceId } : {}),
    name: 'executor.plan',
    kind: 'internal',
    attributes: {
      'agentforge.proposal_id': proposal.id,
      'agentforge.agent_id': proposal.agentId,
      'agentforge.priority': proposal.priority,
      'agentforge.tag_count': proposal.tags.length,
    },
  });

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

  const plan: ExecutionPlan = {
    proposalId: proposal.id,
    stages: [...stages],
    estimatedAgents: agents,
    estimatedComplexity: complexity,
    sandboxed: true,
    createdAt: nowIso(),
    traceId: span.traceId,
  };

  span.setAttributes({
    'agentforge.plan.trace_id': span.traceId,
    'agentforge.plan.complexity': complexity,
    'agentforge.plan.stage_count': stages.length,
    'agentforge.plan.estimated_agent_count': agents.length,
  });
  span.setStatus('ok');
  collector.endSpan(span);

  return plan;
}
