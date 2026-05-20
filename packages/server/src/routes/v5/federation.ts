import type { FastifyInstance } from 'fastify';
import {
  FEDERATION_PROTOCOL_VERSION,
  FederationManager,
  FederationSafetyError,
} from '@agentforge/core';

const federation = new FederationManager({
  enabled: process.env['AGENTFORGE_FEDERATION_ENABLED'] === 'true',
  dryRun: true,
});

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
}

function federationErrorStatus(code: string): number {
  if (code === 'FEDERATION_DISABLED' || code === 'REMOTE_INGEST_DISABLED') return 403;
  if (code === 'CONTENT_TOO_LARGE') return 413;
  return 422;
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

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
    const body = bodyRecord(req.body);
    if (
      !isNonEmptyString(body['id']) ||
      !isNonEmptyString(body['name']) ||
      !isNonEmptyString(body['url']) ||
      !isNonEmptyString(body['protocolVersion'])
    ) {
      return reply.status(400).send({
        error: 'id, name, url, and protocolVersion are required',
        code: 'MISSING_FIELD',
        expectedProtocolVersion: FEDERATION_PROTOCOL_VERSION,
      });
    }

    try {
      const peer = federation.registerPeer({
        id: body['id'],
        name: body['name'],
        url: body['url'],
        protocolVersion: body['protocolVersion'],
      });
      return reply.status(201).send({
        data: peer,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err: unknown) {
      if (err instanceof FederationSafetyError) {
        return reply.status(federationErrorStatus(err.code)).send({
          error: err.message,
          code: err.code,
        });
      }
      throw err;
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
    const body = bodyRecord(req.body);
    if (
      !isNonEmptyString(body['agentId']) ||
      !isNonEmptyString(body['category']) ||
      !isNonEmptyString(body['content'])
    ) {
      return reply.status(400).send({
        error: 'agentId, category, and content are required',
        code: 'MISSING_FIELD',
      });
    }

    const confidence = body['confidence'] ?? 0.8;
    if (!isValidConfidence(confidence)) {
      return reply.status(400).send({
        error: 'confidence must be a number from 0 to 1',
        code: 'INVALID_CONFIDENCE',
      });
    }

    try {
      const sourcePeerId = isNonEmptyString(body['sourcePeerId']) ? body['sourcePeerId'] : null;
      const learning = federation.shareLearning({
        agentId: body['agentId'],
        category: body['category'],
        content: body['content'],
        confidence,
        sourcePeerId,
      });

      return reply.status(201).send({
        data: learning,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err: unknown) {
      if (err instanceof FederationSafetyError) {
        return reply.status(federationErrorStatus(err.code)).send({
          error: err.message,
          code: err.code,
        });
      }
      throw err;
    }
  });
}
