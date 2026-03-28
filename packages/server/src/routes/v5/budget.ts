import type { FastifyInstance } from 'fastify';
import { BudgetEnforcer, ModelSelector } from '@agentforge/core';
import type { BudgetConfig } from '@agentforge/core';

// Singleton per server instance
const enforcer = new BudgetEnforcer();
const selector = new ModelSelector();

export async function budgetRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/budget — current budget status
  app.get('/api/v5/budget', async (_req, reply) => {
    return reply.send({ data: enforcer.status() });
  });

  // POST /api/v5/budget/config — update budget ceilings
  app.post('/api/v5/budget/config', async (req, reply) => {
    const config = req.body as Partial<BudgetConfig>;
    enforcer.updateConfig(config);
    return reply.send({ data: enforcer.status() });
  });

  // POST /api/v5/budget/reset — reset spend counters (operator action)
  app.post('/api/v5/budget/reset', async (_req, reply) => {
    enforcer.reset();
    return reply.send({ data: enforcer.status(), message: 'Budget counters reset' });
  });

  // POST /api/v5/budget/select-model — get recommended model tier for a task
  app.post('/api/v5/budget/select-model', async (req, reply) => {
    const { task, explicitModel } = req.body as { task: string; explicitModel?: string };
    if (!task) return reply.status(400).send({ error: 'task is required' });
    const model = selector.select(task, explicitModel);
    const complexity = selector.inferComplexity(task);
    return reply.send({ data: { model, complexity, task } });
  });
}
