import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

interface OrgNode {
  id: string;
  /** Human-readable display name (REST-conventional field). */
  name: string;
  /** Alias for name — kept for frontend graph rendering compatibility. */
  label: string;
  model: string;
  team?: string;
  role?: string;
}

interface OrgEdge {
  from: string;
  to: string;
  type: 'reports_to';
}

interface AgentYaml {
  name?: string;
  model?: string;
  team?: string;
  role?: string;
  collaboration?: {
    reports_to?: string;
  };
}

function readAgentYaml(agentId: string): AgentYaml | null {
  const agentsDir = join(PROJECT_ROOT, '.agentforge/agents');
  const filePath = join(agentsDir, `${agentId}.yaml`);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    return yaml.load(content) as AgentYaml;
  } catch {
    return null;
  }
}

function inferModel(agentId: string): string {
  try {
    const modelsPath = join(PROJECT_ROOT, '.agentforge/config/models.yaml');
    if (existsSync(modelsPath)) {
      const content = readFileSync(modelsPath, 'utf-8');
      const models = yaml.load(content) as Record<string, unknown>;
      if (models && typeof models === 'object') {
        // Look for agent-specific mapping
        const agentModels = models['agents'] as Record<string, string> | undefined;
        if (agentModels && agentModels[agentId]) {
          return agentModels[agentId];
        }
      }
    }
  } catch {
    // ignore
  }
  return 'sonnet';
}

/** Shared handler — builds org graph data from delegation.yaml + agents directory. */
async function handleOrgGraph(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const delegationPath = join(PROJECT_ROOT, '.agentforge/config/delegation.yaml');
    if (!existsSync(delegationPath)) {
      reply.send({ data: { nodes: [], edges: [] }, meta: { total: 0 } });
      return;
    }

    const delegationContent = readFileSync(delegationPath, 'utf-8');
    const delegation = yaml.load(delegationContent) as Record<string, string[]>;

    if (!delegation || typeof delegation !== 'object') {
      reply.send({ data: { nodes: [], edges: [] }, meta: { total: 0 } });
      return;
    }

    const nodeMap = new Map<string, OrgNode>();
    const edges: OrgEdge[] = [];

    // Collect all agent IDs from delegation graph
    const allAgentIds = new Set<string>();
    for (const [manager, reports] of Object.entries(delegation)) {
      allAgentIds.add(manager);
      if (Array.isArray(reports)) {
        for (const report of reports) {
          allAgentIds.add(report);
        }
      }
    }

    // Also scan the agents directory for any additional agents
    const agentsDir = join(PROJECT_ROOT, '.agentforge/agents');
    if (existsSync(agentsDir)) {
      const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
      for (const f of agentFiles) {
        allAgentIds.add(f.replace('.yaml', ''));
      }
    }

    // Build nodes
    for (const agentId of allAgentIds) {
      if (nodeMap.has(agentId)) continue;
      const agentYaml = readAgentYaml(agentId);
      const model = agentYaml?.model ?? inferModel(agentId);
      const displayName = agentYaml?.name ?? agentId;
      nodeMap.set(agentId, {
        id: agentId,
        name: displayName,
        label: displayName,
        model,
        team: agentYaml?.team,
        role: agentYaml?.role,
      });
    }

    // Build edges: manager → [reports].
    // Edge direction is parent → child so the frontend buildTree() treats e.from as parent.
    for (const [manager, reports] of Object.entries(delegation)) {
      if (!Array.isArray(reports)) continue;
      for (const report of reports) {
        edges.push({ from: manager, to: report, type: 'reports_to' });
      }
    }

    const nodes = Array.from(nodeMap.values());
    reply.send({
      data: { nodes, edges },
      meta: { total: nodes.length },
    });
  } catch {
    reply.send({ data: { nodes: [], edges: [] }, meta: { total: 0 } });
  }
}

export async function orgGraphRoutes(
  app: FastifyInstance,
  _opts: { adapter?: SqliteAdapter }
) {
  app.get('/api/v1/org-graph', handleOrgGraph);
  app.get('/api/v5/org-graph', handleOrgGraph);
}
