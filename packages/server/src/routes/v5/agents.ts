import type { FastifyInstance } from 'fastify';
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import { join } from 'node:path';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

export async function agentRoutes(
  app: FastifyInstance,
  opts: { adapter?: WorkspaceAdapter; projectRoot: string },
): Promise<void> {
  const agentforgeDir = join(opts.projectRoot, '.agentforge');

  // GET /api/v5/agents — list agents from .agentforge/agents/*.yaml
  // Returns rich display data (name, model, description, role) from YAML directly.
  app.get('/api/v5/agents', async (_req, reply) => {
    try {
      const agentsDir = join(agentforgeDir, 'agents');
      if (!existsSync(agentsDir)) return reply.send({ data: [], meta: { total: 0 } });

      const files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
      const data = files.flatMap(f => {
        const agentId = f.replace(/\.ya?ml$/, '');
        try {
          const raw = yaml.load(readFileSync(join(agentsDir, f), 'utf-8')) as Record<string, unknown> | null;
          if (!raw || typeof raw !== 'object') return [];
          const modelRaw = typeof raw.model === 'string' ? raw.model : 'sonnet';
          const model = (modelRaw === 'opus' || modelRaw === 'haiku') ? modelRaw : 'sonnet';
          return [{
            agentId,
            name: typeof raw.name === 'string' ? raw.name : agentId,
            model,
            description: typeof raw.description === 'string' ? raw.description.trim() : null,
            role: typeof raw.role === 'string' ? raw.role : null,
          }];
        } catch {
          return [];
        }
      });

      data.sort((a, b) => a.agentId.localeCompare(b.agentId));
      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // GET /api/v5/agents/:id
  app.get<{ Params: { id: string } }>('/api/v5/agents/:id', async (req, reply) => {
    const agentId = req.params.id;
    const filePath = join(agentforgeDir, 'agents', `${agentId}.yaml`);
    if (!existsSync(filePath)) return reply.status(404).send({ error: 'Agent not found' });
    try {
      const raw = yaml.load(readFileSync(filePath, 'utf-8')) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') return reply.status(404).send({ error: 'Agent not found' });
      const modelRaw = typeof raw.model === 'string' ? raw.model : 'sonnet';
      const model = (modelRaw === 'opus' || modelRaw === 'haiku') ? modelRaw : 'sonnet';
      return reply.send({
        data: {
          agentId,
          name: typeof raw.name === 'string' ? raw.name : agentId,
          model,
          description: typeof raw.description === 'string' ? raw.description.trim() : null,
          role: typeof raw.role === 'string' ? raw.role : null,
          systemPrompt: typeof raw.system_prompt === 'string' ? raw.system_prompt : null,
        },
      });
    } catch {
      return reply.status(404).send({ error: 'Agent not found' });
    }
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
    const runOpts = {
      task,
      ...(context !== undefined ? { context } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    };
    const result = await runtime.run(runOpts);

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
