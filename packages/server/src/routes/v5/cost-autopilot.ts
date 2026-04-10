import type { FastifyInstance } from 'fastify';
import { CostAutopilot } from '@agentforge/core';

const autopilot = new CostAutopilot(async (task, model) => {
  // Stub executor — real usage would call an LLM
  return {
    response: { text: `Processed: ${task}`, model },
    costUsd: model === 'haiku' ? 0.001 : model === 'sonnet' ? 0.003 : 0.015,
  };
});

export async function costAutopilotRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/cost-autopilot/stats
  app.get('/api/v5/cost-autopilot/stats', async (_req, reply) => {
    const stats = autopilot.getStats();
    return reply.send({
      data: stats,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v5/cost-autopilot/process
  app.post('/api/v5/cost-autopilot/process', async (req, reply) => {
    const body = req.body as {
      task?: string;
      complexity?: 'low' | 'medium' | 'high';
      maxCostUsd?: number;
      allowBatching?: boolean;
    };

    if (!body?.task) {
      return reply.status(400).send({ error: 'task is required', code: 'MISSING_FIELD' });
    }

    const executor = async (task: string, model: string) => ({
      response: { text: `Processed: ${task}`, model },
      costUsd: model === 'haiku' ? 0.001 : model === 'sonnet' ? 0.003 : 0.015,
    });

    const result = await autopilot.process(
      {
        task: body.task,
        ...(body.complexity !== undefined ? { complexity: body.complexity } : {}),
        ...(body.maxCostUsd !== undefined ? { maxCostUsd: body.maxCostUsd } : {}),
        ...(body.allowBatching !== undefined ? { allowBatching: body.allowBatching } : {}),
      },
      executor as Parameters<typeof autopilot.process>[1],
    );

    return reply.send({
      data: result,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v5/cost-autopilot/cache/clear
  app.post('/api/v5/cost-autopilot/cache/clear', async (_req, reply) => {
    autopilot.clearCache();
    return reply.send({
      data: { cleared: true },
      meta: { timestamp: new Date().toISOString() },
    });
  });
}
