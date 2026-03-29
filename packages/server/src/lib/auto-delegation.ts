/**
 * auto-delegation.ts — lightweight AutoDelegationPipeline adapter for the
 * server package.
 *
 * Mirrors the public interface of src/orchestrator/auto-delegation.ts
 * without crossing the package boundary. The core keyword-routing logic
 * is reproduced here so the server package compiles standalone.
 *
 * Synchronises intent with the root-level AutoDelegationPipeline: if the
 * root implementation changes, update the DOMAIN_KEYWORDS map below.
 */

// ---------------------------------------------------------------------------
// Public types (mirrors src/orchestrator/auto-delegation.ts)
// ---------------------------------------------------------------------------

export interface SprintItemInput {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  assignee: string;
  status: string;
}

export interface DelegationStep {
  from: string;
  to: string;
  itemId: string;
  action: string;
  rationale: string;
  timestamp: string;
}

export interface AutoDelegationResult {
  steps: DelegationStep[];
  assignments: Map<string, string[]>;   // agentId → item IDs
  unassigned: string[];
}

// ---------------------------------------------------------------------------
// Domain → keyword mapping (kept in sync with the root-level module)
// ---------------------------------------------------------------------------

type Layer = 'frontend' | 'backend' | 'infra' | 'data' | 'qa' | 'platform' | 'research';

const DOMAIN_KEYWORDS: Record<Layer, string[]> = {
  frontend: [
    'ui', 'component', 'page', 'dashboard', 'css', 'style', 'svelte',
    'react', 'html', 'dom', 'animation', 'layout', 'theme', 'design',
  ],
  backend: [
    'api', 'endpoint', 'route', 'server', 'handler', 'middleware',
    'rest', 'graphql', 'websocket', 'http', 'request', 'response',
  ],
  infra: [
    'ci', 'cd', 'deploy', 'docker', 'pipeline', 'security', 'monitor',
    'kubernetes', 'k8s', 'terraform', 'nginx', 'github actions',
  ],
  data: [
    'database', 'schema', 'migration', 'query', 'embedding',
    'sql', 'sqlite', 'postgres', 'mongodb', 'redis', 'index', 'vector',
  ],
  qa: [
    'test', 'coverage', 'quality', 'lint', 'spec', 'fixture',
    'mock', 'assertion', 'vitest', 'jest', 'e2e', 'playwright',
  ],
  platform: ['platform', 'sdk', 'library', 'package', 'workspace', 'monorepo'],
  research: ['research', 'poc', 'prototype', 'experiment', 'benchmark', 'eval'],
};

/** Default agent for each domain when no team roster is provided. */
const DOMAIN_DEFAULT_AGENT: Record<Layer, string> = {
  frontend: 'architect',
  backend: 'coder',
  infra: 'coder',
  data: 'dba',
  qa: 'backend-qa',
  platform: 'coder',
  research: 'researcher',
};

// ---------------------------------------------------------------------------
// AutoDelegationPipeline
// ---------------------------------------------------------------------------

export class AutoDelegationPipeline {
  /**
   * Classify a sprint item into a technical layer using keyword scoring.
   * Defaults to 'backend' when nothing matches.
   */
  inferDomain(item: SprintItemInput): Layer {
    const text = `${item.title} ${item.description}`.toLowerCase();
    let bestLayer: Layer = 'backend';
    let bestScore = 0;

    for (const [layer, keywords] of Object.entries(DOMAIN_KEYWORDS) as [Layer, string[]][]) {
      const score = keywords.reduce((s, kw) => s + (text.includes(kw) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestLayer = layer;
      }
    }

    return bestLayer;
  }

  /**
   * Run the delegation pipeline and return an assignment plan.
   *
   * When no team roster is provided (the common server-layer case), falls
   * back to domain-default agents (coder, dba, researcher, etc.) so that
   * every item gets an assignee.
   */
  delegateSprint(items: SprintItemInput[]): AutoDelegationResult {
    const steps: DelegationStep[] = [];
    const assignments = new Map<string, string[]>();
    const unassigned: string[] = [];
    const now = new Date().toISOString();

    for (const item of items) {
      // Skip items that are already assigned
      if (item.assignee && item.assignee.trim() !== '') {
        const list = assignments.get(item.assignee) ?? [];
        list.push(item.id);
        assignments.set(item.assignee, list);

        steps.push({
          from: 'cto',
          to: item.assignee,
          itemId: item.id,
          action: `Retain existing assignment: ${item.id} → ${item.assignee}`,
          rationale: `Item already has assignee "${item.assignee}"; retained without change`,
          timestamp: now,
        });
        continue;
      }

      const domain = this.inferDomain(item);
      const agentId = DOMAIN_DEFAULT_AGENT[domain] ?? 'coder';

      steps.push({
        from: 'cto',
        to: agentId,
        itemId: item.id,
        action: `Assign: ${item.id} → ${agentId}`,
        rationale: `Item "${item.title}" classified as ${domain} domain; routed to default ${domain} agent`,
        timestamp: now,
      });

      const list = assignments.get(agentId) ?? [];
      list.push(item.id);
      assignments.set(agentId, list);
    }

    return { steps, assignments, unassigned };
  }
}
