import type { FastifyInstance } from 'fastify';
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

export async function agentRoutes(
  app: FastifyInstance,
  opts: { adapter?: WorkspaceAdapter; projectRoot: string },
): Promise<void> {
  const agentforgeDir = join(opts.projectRoot, '.agentforge');

  // GET /api/v5/agents — list agents from .agentforge/agents/
  app.get('/api/v5/agents', async (_req, reply) => {
    try {
      const agentsDir = join(agentforgeDir, 'agents');
      if (!existsSync(agentsDir)) return reply.send({ data: [], meta: { total: 0 } });

      const files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
      const agents = await Promise.all(
        files.map(f => loadAgentConfig(f.replace('.yaml', ''), agentforgeDir)),
      );
      const data = agents.filter(Boolean);
      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // GET /api/v5/agents/:id
  app.get<{ Params: { id: string } }>('/api/v5/agents/:id', async (req, reply) => {
    const config = await loadAgentConfig(req.params.id, agentforgeDir);
    if (!config) return reply.status(404).send({ error: 'Agent not found' });
    return reply.send({ data: config });
  });

  // POST /api/v5/agents/:id/run — invoke an agent
  app.post<{ Params: { id: string } }>('/api/v5/agents/:id/run', async (req, reply) => {
    const { task, context, parentSessionId, budgetUsd } = req.body as {
      task: string;
      context?: string;
      parentSessionId?: string;
      budgetUsd?: number;
    };

    if (!task) return reply.status(400).send({ error: 'task is required' });

    const config = await loadAgentConfig(req.params.id, agentforgeDir);
    if (!config) return reply.status(404).send({ error: 'Agent not found' });

    config.workspaceId = 'default';
    const runtime = new AgentRuntime(config, opts.adapter);
    const result = await runtime.run({ task, context, parentSessionId, budgetUsd });

    return reply.send({ data: result });
  });

  // GET /api/v5/agents/:id/scorecard — performance score (requires adapter)
  app.get<{ Params: { id: string } }>('/api/v5/agents/:id/scorecard', async (req, reply) => {
    if (!opts.adapter) return reply.status(503).send({ error: 'No adapter configured' });
    const score = opts.adapter.getAgentScore(req.params.id);
    if (!score) return reply.status(404).send({ error: 'No scorecard data for this agent' });
    return reply.send({ data: score });
  });

  // GET /api/v5/scorecards — list all agent scores (requires adapter)
  app.get('/api/v5/scorecards', async (_req, reply) => {
    if (!opts.adapter) return reply.send({ data: [], meta: { total: 0 } });
    const scores = opts.adapter.listAgentScores();
    return reply.send({ data: scores, meta: { total: scores.length } });
  });
}
