import type { FastifyInstance } from 'fastify';
import { ExecutionLog, SprintReporter } from '@agentforge/core';

const executionLog = new ExecutionLog();
const sprintReporter = new SprintReporter();

export async function observabilityRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/execution-log — query execution log
  app.get('/api/v5/execution-log', async (req, reply) => {
    const q = req.query as { level?: string; category?: string; sprintVersion?: string; agentId?: string; limit?: string };
    const entries = executionLog.query({
      level: q.level as any,
      category: q.category as any,
      ...(q.sprintVersion !== undefined ? { sprintVersion: q.sprintVersion } : {}),
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      limit: q.limit ? parseInt(q.limit) : 100,
    });
    return reply.send({ data: entries, meta: { total: executionLog.count() } });
  });

  // POST /api/v5/execution-log — append a log entry
  app.post('/api/v5/execution-log', async (req, reply) => {
    const { level, category, message, data } = req.body as any;
    if (!message) return reply.status(400).send({ error: 'message is required' });
    const entry = executionLog.log(level ?? 'info', category ?? 'system', message, data);
    return reply.status(201).send({ data: entry });
  });

  // GET /api/v5/sprint-reports — list sprint summaries
  app.get('/api/v5/sprint-reports', async (_req, reply) => {
    return reply.send({ data: sprintReporter.list(), meta: { total: sprintReporter.list().length } });
  });

  // GET /api/v5/sprint-reports/:version — get specific sprint summary
  app.get<{ Params: { version: string } }>('/api/v5/sprint-reports/:version', async (req, reply) => {
    const summary = sprintReporter.get(req.params.version);
    if (!summary) return reply.status(404).send({ error: 'Sprint not found' });
    return reply.send({ data: summary });
  });
}
