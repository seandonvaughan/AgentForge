import type { FastifyInstance } from 'fastify';
import { FederationManager } from '@agentforge/core';

const federation = new FederationManager({ dryRun: true });

export async function federationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v5/federation/status
   * Returns current federation status.
   */
  app.get('/api/v5/federation/status', async (_req, reply) => {
    const status = federation.getStatus();
    return reply.send({ data: status, meta: { timestamp: new Date().toISOString() } });
  });

  /**
   * GET /api/v5/federation/peers
   * List all registered federation peers.
   */
  app.get('/api/v5/federation/peers', async (_req, reply) => {
    const peers = federation.listPeers();
    return reply.send({
      data: peers,
      meta: { total: peers.length, timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v5/federation/peers
   * Register a new federation peer.
   */
  app.post('/api/v5/federation/peers', async (req, reply) => {
    const body = req.body as any;
    if (!body?.id || !body?.name || !body?.url) {
      return reply.status(400).send({
        error: 'id, name, and url are required',
        code: 'MISSING_FIELD',
      });
    }

    try {
      const peer = federation.registerPeer({ id: body.id, name: body.name, url: body.url });
      return reply.status(201).send({
        data: peer,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err: any) {
      return reply.status(422).send({ error: err.message, code: 'PEER_LIMIT_EXCEEDED' });
    }
  });

  /**
   * GET /api/v5/federation/learnings
   * Get all shared learnings in the local store.
   */
  app.get('/api/v5/federation/learnings', async (_req, reply) => {
    const learnings = federation.getSharedLearnings();
    return reply.send({
      data: learnings,
      meta: { total: learnings.length, timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v5/federation/share
   * Share a new learning with federation peers.
   */
  app.post('/api/v5/federation/share', async (req, reply) => {
    const body = req.body as any;
    if (!body?.agentId || !body?.category || !body?.content) {
      return reply.status(400).send({
        error: 'agentId, category, and content are required',
        code: 'MISSING_FIELD',
      });
    }

    const learning = federation.shareLearning({
      agentId: body.agentId,
      category: body.category,
      content: body.content,
      confidence: body.confidence ?? 0.8,
      sourcePeerId: body.sourcePeerId ?? null,
    });

    return reply.status(201).send({
      data: learning,
      meta: { timestamp: new Date().toISOString() },
    });
  });
}
