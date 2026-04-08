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

    // Build nodes from agent YAMLs
    const nodes: OrgNode[] = [];
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
        } catch { /* skip malformed */ }
      }
    }

    // Build edges from delegation.yaml
    const edges: OrgEdge[] = [];
    if (existsSync(delegationPath)) {
      try {
        const raw = readFileSync(delegationPath, 'utf-8');
        const delegation = yaml.load(raw) as Record<string, string[]>;
        for (const [from, targets] of Object.entries(delegation)) {
          // Skip edges from excluded agents — their children would otherwise
          // gain a parent and vanish from the tree (no renderable parent node).
          if (EXCLUDED_AGENTS.has(from)) continue;
          if (Array.isArray(targets)) {
            for (const to of targets) {
              edges.push({ from, to });
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
