import { nowIso } from '@agentforge/shared';
import type { AgentProposal } from '@agentforge/core';
import type { CanaryOptions, ExecutionPlan, ExecutionStage, RuntimeModelTier } from './types.js';

const COMPLEXITY_KEYWORDS = {
  high: ['architecture', 'refactor', 'migrate', 'overhaul', 'redesign', 'replace'],
  medium: ['add', 'implement', 'improve', 'optimize', 'update', 'extend'],
  low: ['fix', 'patch', 'tweak', 'rename', 'remove', 'minor'],
};

const DEFAULT_SELF_MODIFICATION_MARKERS = [
  'self-mod',
  'self mod',
  'self-modification',
  'self modification',
  'self-modifying',
  'modify itself',
  'agent yaml',
  'agent prompt',
  'override',
  'reforge',
];

function inferComplexity(proposal: AgentProposal): 'low' | 'medium' | 'high' {
  const text = `${proposal.title} ${proposal.description}`.toLowerCase();
  if (COMPLEXITY_KEYWORDS.high.some(k => text.includes(k))) return 'high';
  if (COMPLEXITY_KEYWORDS.low.some(k => text.includes(k))) return 'low';
  return 'medium';
}

export function modelForStage(
  complexity: 'low' | 'medium' | 'high',
  stage: ExecutionStage,
): RuntimeModelTier {
  switch (stage) {
    case 'planning':
      return complexity === 'high' ? 'sonnet' : 'haiku';
    case 'architecture':
      return 'sonnet';
    case 'coding':
      return 'sonnet';
    case 'linting':
      return 'haiku';
    case 'testing':
      return 'haiku';
    case 'canary':
      return complexity === 'high' ? 'sonnet' : 'haiku';
    case 'rollback':
      return 'haiku';
    case 'complete':
    case 'failed':
      return 'haiku';
    default:
      return 'haiku';
  }
}

export function isSelfModificationProposal(
  proposal: AgentProposal,
  markers: string[] = DEFAULT_SELF_MODIFICATION_MARKERS,
): boolean {
  const markerSet = new Set(markers.map((marker) => marker.toLowerCase()));
  const searchText = `${proposal.title} ${proposal.description}`.toLowerCase();
  if (proposal.tags.some((tag) => markerSet.has(tag.toLowerCase()))) return true;
  return [...markerSet].some((marker) => searchText.includes(marker));
}

export function buildPlan(proposal: AgentProposal, canary: CanaryOptions = {}): ExecutionPlan {
  const complexity = inferComplexity(proposal);
  const selfModification = isSelfModificationProposal(proposal, canary.selfModificationMarkers);
  const canaryEnabled = canary.enabled ?? true;
  const trafficPercent = clampPercent(canary.trafficPercent ?? 10);

  const baseStages = complexity === 'high'
    ? ['planning', 'architecture', 'coding', 'linting', 'testing', 'complete'] as const
    : complexity === 'medium'
    ? ['planning', 'coding', 'linting', 'testing', 'complete'] as const
    : ['planning', 'coding', 'testing', 'complete'] as const;

  const baseAgents = complexity === 'high'
    ? ['project-manager', 'architect', 'coder', 'linter', 'debugger']
    : complexity === 'medium'
    ? ['project-manager', 'coder', 'linter', 'debugger']
    : ['coder', 'debugger'];

  const stages: ExecutionStage[] = [...baseStages];
  const agents: string[] = [...baseAgents];
  if (canaryEnabled && selfModification) {
    stages.splice(stages.length - 1, 0, 'canary');
    agents.push('safety-auditor');
  }

  return {
    proposalId: proposal.id,
    stages,
    estimatedAgents: agents,
    estimatedComplexity: complexity,
    sandboxed: true,
    ...(canaryEnabled && selfModification
      ? {
        canary: {
          enabled: canaryEnabled,
          appliesToSelfModification: true,
          trafficPercent,
        },
      }
      : {}),
    createdAt: nowIso(),
  };
}

function clampPercent(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.floor(value)));
}
