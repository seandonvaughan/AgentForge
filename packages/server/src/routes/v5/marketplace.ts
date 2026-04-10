import type { FastifyInstance } from 'fastify';
import { MarketplaceRegistry } from '@agentforge/core';
import { join } from 'node:path';

const registry = new MarketplaceRegistry(join(process.cwd(), '.agentforge/agents'));

export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/marketplace
  app.get('/api/v5/marketplace', async (_req, reply) => {
    const entries = registry.list();
    const stats = registry.stats();
    return reply.send({
      data: entries,
      meta: {
        total: entries.length,
        stats,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // GET /api/v5/marketplace/:id
  app.get<{ Params: { id: string } }>('/api/v5/marketplace/:id', async (req, reply) => {
    const entry = registry.get(req.params.id);
    if (!entry) {
      return reply.status(404).send({ error: 'Entry not found', code: 'ENTRY_NOT_FOUND' });
    }
    return reply.send({ data: entry, meta: { timestamp: new Date().toISOString() } });
  });

  // POST /api/v5/marketplace/search
  app.post('/api/v5/marketplace/search', async (req, reply) => {
    const body = req.body as { query?: string };
    if (!body?.query) {
      return reply.status(400).send({ error: 'query is required', code: 'MISSING_FIELD' });
    }
    const results = registry.search(body.query);
    return reply.send({
      data: results,
      meta: { total: results.length, query: body.query, timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v5/marketplace/publish
  app.post('/api/v5/marketplace/publish', async (req, reply) => {
    const body = req.body as {
      id?: string;
      name?: string;
      description?: string;
      agentType?: string;
      metadata?: Record<string, unknown>;
      yamlContent?: string;
    };

    if (!body?.id || !body?.name) {
      return reply.status(400).send({ error: 'id and name are required', code: 'MISSING_FIELD' });
    }

    const entry = registry.publish({
      id: body.id,
      name: body.name,
      description: body.description ?? '',
      ...(body.agentType !== undefined ? { agentType: body.agentType } : {}),
      ...(body.yamlContent !== undefined ? { yamlContent: body.yamlContent } : {}),
    });

    return reply.status(201).send({
      data: entry,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v5/marketplace/:id/install
  app.post<{ Params: { id: string } }>('/api/v5/marketplace/:id/install', async (req, reply) => {
    const body = req.body as { targetDir?: string } | null;
    const result = registry.install(req.params.id, body?.targetDir);

    if (!result.success) {
      return reply.status(400).send({ error: result.error, code: 'INSTALL_FAILED' });
    }

    return reply.send({
      data: result,
      meta: { timestamp: new Date().toISOString() },
    });
  });
}
