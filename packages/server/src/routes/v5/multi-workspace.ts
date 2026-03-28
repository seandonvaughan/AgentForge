import type { FastifyInstance } from 'fastify';
import { WorkspaceAggregator, WorkspaceSummary } from '@agentforge/core';

const aggregator = new WorkspaceAggregator();

/** In-memory store of known workspace summaries */
const knownWorkspaces: WorkspaceSummary[] = [
  {
    workspaceId: 'ws-default',
    name: 'Default Workspace',
    totalCostUsd: 12.50,
    sessionCount: 142,
    activeAgents: 5,
    lastActivityAt: new Date().toISOString(),
  },
  {
    workspaceId: 'ws-staging',
    name: 'Staging Workspace',
    totalCostUsd: 3.25,
    sessionCount: 38,
    activeAgents: 2,
    lastActivityAt: new Date().toISOString(),
  },
];

export async function multiWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v5/workspaces/summary
   * Aggregated view across all known workspaces.
   */
  app.get('/api/v5/workspaces/summary', async (_req, reply) => {
    const view = aggregator.aggregate(knownWorkspaces);
    return reply.send({
      data: view,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * GET /api/v5/workspaces/compare
   * Side-by-side comparison of two workspaces by ID.
   * Query params: leftId, rightId
   */
  app.get('/api/v5/workspaces/compare', async (req, reply) => {
    const q = req.query as { leftId?: string; rightId?: string };

    if (!q.leftId || !q.rightId) {
      return reply.status(400).send({
        error: 'leftId and rightId query parameters are required',
        code: 'MISSING_PARAMS',
      });
    }

    const left = knownWorkspaces.find((ws) => ws.workspaceId === q.leftId);
    const right = knownWorkspaces.find((ws) => ws.workspaceId === q.rightId);

    if (!left) {
      return reply.status(404).send({ error: `Workspace ${q.leftId} not found`, code: 'WORKSPACE_NOT_FOUND' });
    }
    if (!right) {
      return reply.status(404).send({ error: `Workspace ${q.rightId} not found`, code: 'WORKSPACE_NOT_FOUND' });
    }

    const comparison = aggregator.compare(left, right);
    return reply.send({
      data: comparison,
      meta: { timestamp: new Date().toISOString() },
    });
  });
}
