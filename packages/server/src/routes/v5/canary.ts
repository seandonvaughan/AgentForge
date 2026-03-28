import type { FastifyInstance } from 'fastify';
import { CanaryManager } from '@agentforge/core';

const canary = new CanaryManager();

export async function canaryRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v5/canary/flags — create a feature flag
  app.post('/api/v5/canary/flags', async (req, reply) => {
    const body = req.body as any;
    if (!body?.name) {
      return reply.status(400).send({ error: 'name is required', code: 'MISSING_FIELD' });
    }
    const flag = canary.createFlag({
      name: body.name,
      description: body.description,
      trafficPercent: body.trafficPercent ?? 0,
      strategy: body.strategy ?? 'percentage',
      rollbackThreshold: body.rollbackThreshold ?? 0.05,
    });
    return reply.status(201).send({ data: flag, meta: { timestamp: new Date().toISOString() } });
  });

  // GET /api/v5/canary/flags — list all flags
  app.get('/api/v5/canary/flags', async (req, reply) => {
    const q = req.query as { status?: string };
    const flags = canary.listFlags(q.status as any);
    return reply.send({
      data: flags,
      meta: { total: flags.length, timestamp: new Date().toISOString() },
    });
  });

  // GET /api/v5/canary/flags/:id — get flag by id
  app.get<{ Params: { id: string } }>('/api/v5/canary/flags/:id', async (req, reply) => {
    const flag = canary.getFlag(req.params.id);
    if (!flag) return reply.status(404).send({ error: 'Flag not found', code: 'FLAG_NOT_FOUND' });
    return reply.send({ data: flag });
  });

  // PATCH /api/v5/canary/flags/:id — update a flag
  app.patch<{ Params: { id: string } }>('/api/v5/canary/flags/:id', async (req, reply) => {
    const body = req.body as any;
    const updated = canary.updateFlag(req.params.id, {
      trafficPercent: body.trafficPercent,
      status: body.status,
      rollbackThreshold: body.rollbackThreshold,
    });
    if (!updated) return reply.status(404).send({ error: 'Flag not found', code: 'FLAG_NOT_FOUND' });
    return reply.send({ data: updated });
  });

  // POST /api/v5/canary/flags/:id/activate — activate a flag
  app.post<{ Params: { id: string } }>('/api/v5/canary/flags/:id/activate', async (req, reply) => {
    const flag = canary.activateFlag(req.params.id);
    if (!flag) return reply.status(404).send({ error: 'Flag not found', code: 'FLAG_NOT_FOUND' });
    return reply.send({ data: flag });
  });

  // POST /api/v5/canary/flags/:id/rollback — manually trigger rollback
  app.post<{ Params: { id: string } }>('/api/v5/canary/flags/:id/rollback', async (req, reply) => {
    const body = req.body as any;
    const reason = body?.reason ?? 'Manual rollback';
    const result = canary.performRollback(req.params.id, reason);
    if (!result) return reply.status(404).send({ error: 'Flag not found', code: 'FLAG_NOT_FOUND' });
    return reply.send({ data: result });
  });

  // POST /api/v5/canary/split — route a request through traffic splitting
  app.post('/api/v5/canary/split', async (req, reply) => {
    const body = req.body as any;
    if (!body?.flagId || !body?.requestId) {
      return reply.status(400).send({ error: 'flagId and requestId are required', code: 'MISSING_FIELD' });
    }
    const result = canary.route(body.flagId, body.requestId, body.headerValue);
    return reply.send({ data: result, meta: { timestamp: new Date().toISOString() } });
  });

  // GET /api/v5/canary/metrics — all flag metrics
  app.get('/api/v5/canary/metrics', async (_req, reply) => {
    const metrics = canary.getAllMetrics();
    return reply.send({
      data: metrics,
      meta: { total: metrics.length, timestamp: new Date().toISOString() },
    });
  });

  // GET /api/v5/canary/metrics/:flagId — metrics for a specific flag
  app.get<{ Params: { flagId: string } }>('/api/v5/canary/metrics/:flagId', async (req, reply) => {
    const metrics = canary.getMetrics(req.params.flagId);
    if (!metrics) return reply.status(404).send({ error: 'Flag not found', code: 'FLAG_NOT_FOUND' });
    return reply.send({ data: metrics });
  });

  // GET /api/v5/canary/rollback-log — rollback history
  app.get('/api/v5/canary/rollback-log', async (_req, reply) => {
    const log = canary.getRollbackLog();
    return reply.send({ data: log, meta: { total: log.length, timestamp: new Date().toISOString() } });
  });
}
