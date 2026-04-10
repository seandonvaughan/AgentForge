import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

interface OrgNode {
  id: string;
  label: string;
  model?: string;
}

interface OrgEdge {
  from: string;
  to: string;
}

export async function orgGraphRoutes(
  app: FastifyInstance,
  opts: { projectRoot: string },
): Promise<void> {
  app.get('/api/v5/org-graph', async (_req, reply) => {
    const agentforgeDir = join(opts.projectRoot, '.agentforge');
    const agentsDir = join(agentforgeDir, 'agents');
    const delegationPath = join(agentforgeDir, 'config', 'delegation.yaml');

    // Agents that are plugins/tooling, not part of the org hierarchy
    const EXCLUDED_AGENTS = new Set(['genesis', 'genesis-pipeline-dev']);

    // Build nodes from agent YAMLs; retain parsed docs for edge extraction
    const nodes: OrgNode[] = [];
    const agentDocs = new Map<string, Record<string, unknown>>();

    if (existsSync(agentsDir)) {
      const files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
      for (const file of files) {
        try {
          const raw = readFileSync(join(agentsDir, file), 'utf-8');
          const doc = yaml.load(raw) as Record<string, unknown>;
          const id = file.replace('.yaml', '');
          if (EXCLUDED_AGENTS.has(id)) continue;
          nodes.push({
            id,
            label: (doc['name'] as string) ?? id,
            model: (doc['model'] as string) ?? undefined,
          });
          agentDocs.set(id, doc);
        } catch { /* skip malformed */ }
      }
    }

    // Build edges from three sources, deduplicating via a Set.
    //
    // Source priority (all merged, duplicates dropped):
    //   1. collaboration.can_delegate_to — parent's explicit outgoing grants
    //   2. collaboration.reports_to     — child's reported parent (fills gaps
    //      when a manager's can_delegate_to list is stale or incomplete)
    //   3. delegation.yaml              — legacy supplementary config
    //
    // Edges where either endpoint is an EXCLUDED_AGENT are always dropped so
    // internal tooling agents never appear in the operator-facing hierarchy.
    const edgeSet = new Set<string>();
    const edges: OrgEdge[] = [];

    function addEdge(from: string, to: string): void {
      if (EXCLUDED_AGENTS.has(from) || EXCLUDED_AGENTS.has(to)) return;
      const key = `${from}\0${to}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push({ from, to });
    }

    // Source 1: can_delegate_to (parent → children, authoritative delegation grants)
    for (const [id, doc] of agentDocs) {
      const collab = (doc['collaboration'] ?? {}) as Record<string, unknown>;
      const delegates = collab['can_delegate_to'];
      if (Array.isArray(delegates)) {
        for (const to of delegates) {
          if (typeof to === 'string') addEdge(id, to);
        }
      }
    }

    // Source 2: reports_to (parent → this agent; fills gaps in can_delegate_to)
    for (const [id, doc] of agentDocs) {
      const collab = (doc['collaboration'] ?? {}) as Record<string, unknown>;
      const reportsTo = collab['reports_to'];
      if (typeof reportsTo === 'string' && reportsTo) {
        addEdge(reportsTo, id);
      }
    }

    // Source 3: delegation.yaml (supplementary; any remaining edges not above)
    if (existsSync(delegationPath)) {
      try {
        const raw = readFileSync(delegationPath, 'utf-8');
        const delegation = yaml.load(raw) as Record<string, string[]>;
        for (const [from, targets] of Object.entries(delegation)) {
          if (Array.isArray(targets)) {
            for (const to of targets) {
              addEdge(from, to);
            }
          }
        }
      } catch { /* skip malformed */ }
    }

    return reply.send({
      data: { nodes, edges },
      meta: {
        total: nodes.length,
        edgeCount: edges.length,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
