import type { FastifyInstance } from 'fastify';
import { AgentVersionManager } from '@agentforge/core';

const versionManager = new AgentVersionManager();

export async function agentVersioningRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v5/agents/:id/versions
   * Get the full version history for an agent.
   */
  app.get<{ Params: { id: string } }>('/api/v5/agents/:id/versions', async (req, reply) => {
    const history = versionManager.getHistory(req.params.id);
    return reply.send({
      data: history,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v5/agents/:id/versions
   * Record a new version snapshot for an agent.
   */
  app.post<{ Params: { id: string } }>('/api/v5/agents/:id/versions', async (req, reply) => {
    const body = req.body as any;
    if (!body?.config || typeof body.config !== 'object') {
      return reply.status(400).send({ error: 'config (object) is required', code: 'MISSING_FIELD' });
    }

    const record = versionManager.recordVersion(req.params.id, body.config, body.notes);
    return reply.status(201).send({
      data: record,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v5/agents/:id/pin
   * Pin a specific version for an agent.
   */
  app.post<{ Params: { id: string } }>('/api/v5/agents/:id/pin', async (req, reply) => {
    const body = req.body as any;
    if (!body?.versionId) {
      return reply.status(400).send({ error: 'versionId is required', code: 'MISSING_FIELD' });
    }

    try {
      const pin = versionManager.pin(req.params.id, body.versionId);
      return reply.send({
        data: pin,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err: any) {
      return reply.status(404).send({ error: err.message, code: 'VERSION_NOT_FOUND' });
    }
  });

  /**
   * POST /api/v5/agents/:id/rollback
   * Rollback an agent to a specific version.
   */
  app.post<{ Params: { id: string } }>('/api/v5/agents/:id/rollback', async (req, reply) => {
    const body = req.body as any;
    if (!body?.versionId) {
      return reply.status(400).send({ error: 'versionId is required', code: 'MISSING_FIELD' });
    }

    try {
      const record = versionManager.rollback(req.params.id, body.versionId);
      return reply.send({
        data: record,
        meta: { rolledBackAt: new Date().toISOString(), timestamp: new Date().toISOString() },
      });
    } catch (err: any) {
      return reply.status(404).send({ error: err.message, code: 'VERSION_NOT_FOUND' });
    }
  });
}
