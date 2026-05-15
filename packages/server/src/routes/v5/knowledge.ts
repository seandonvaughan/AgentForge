import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import { KnowledgeGraph, loadKnowledgeEntities } from '@agentforge/core';

export interface KnowledgeRoutesOptions {
  /**
   * WorkspaceAdapter for SQLite-backed KV persistence. When provided,
   * entities and relationships survive server restarts (stored under
   * `knowledge:graph:entities` / `knowledge:graph:relationships`).
   * When omitted the graph operates purely in-memory.
   */
  adapter?: WorkspaceAdapter | undefined;
  /**
   * Absolute path to the project root — used to locate
   * `.agentforge/knowledge/entities.jsonl` so the in-memory graph is
   * hydrated from entities written by past audit and review phases.
   *
   * When omitted the graph starts empty (backward-compat with tests that
   * do not need disk-backed state).
   *
   * Typed as `string | undefined` (rather than optional `?`) so callers
   * can safely pass `opts.projectRoot` (which is `string | undefined`)
   * without triggering exactOptionalPropertyTypes TS2379.
   */
  projectRoot?: string | undefined;
}

export async function knowledgeRoutes(
  app: FastifyInstance,
  opts: KnowledgeRoutesOptions = {},
): Promise<void> {
  // Adapter-backed construction hydrates from the KV store automatically,
  // ensuring entities and relationships survive server restarts.
  const graph = new KnowledgeGraph(opts.adapter);

  // Also hydrate from entities.jsonl written by audit/review phases so the
  // /knowledge page is populated from cycle-accumulated entity data even when
  // the adapter KV store is empty (e.g. first run after a data directory move).
  if (opts.projectRoot) {
    const persisted = loadKnowledgeEntities(opts.projectRoot);
    for (const entity of persisted) {
      graph.addEntity({
        name: entity.name,
        type: entity.type,
        ...(entity.description !== undefined ? { description: entity.description } : {}),
        properties: entity.properties,
      });
    }
  }

  // GET /api/v5/knowledge/entities — list all entities, optional ?type= filter
  app.get('/api/v5/knowledge/entities', async (req, reply) => {
    const q = req.query as { type?: string };
    const entities = graph.listEntities(q.type ? { type: q.type as any } : undefined);
    return reply.send({
      data: entities,
      meta: { total: entities.length, timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v5/knowledge/entities — create a new entity
  app.post('/api/v5/knowledge/entities', async (req, reply) => {
    const body = req.body as any;
    if (!body?.name) {
      return reply.status(400).send({ error: 'name is required', code: 'MISSING_FIELD' });
    }
    const entity = graph.addEntity({
      name: body.name,
      type: body.type ?? 'concept',
      description: body.description,
      properties: body.properties ?? {},
    });
    return reply.status(201).send({ data: entity, meta: { timestamp: new Date().toISOString() } });
  });

  // GET /api/v5/knowledge/entities/:id — get entity by id
  app.get<{ Params: { id: string } }>('/api/v5/knowledge/entities/:id', async (req, reply) => {
    const entity = graph.getEntity(req.params.id);
    if (!entity) return reply.status(404).send({ error: 'Entity not found', code: 'ENTITY_NOT_FOUND' });
    return reply.send({ data: entity });
  });

  // GET /api/v5/knowledge/graph — full graph with stats
  app.get('/api/v5/knowledge/graph', async (_req, reply) => {
    const stats = graph.stats();
    return reply.send({
      data: {
        entities: graph.listEntities(),
        relationships: graph.listRelationships(),
        stats,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v5/knowledge/query — semantic query
  app.post('/api/v5/knowledge/query', async (req, reply) => {
    const body = req.body as any;
    if (!body?.query) {
      return reply.status(400).send({ error: 'query is required', code: 'MISSING_FIELD' });
    }
    const result = graph.query({
      query: body.query,
      entityTypes: body.entityTypes,
      maxEntities: body.maxEntities ?? 20,
      minRelevance: body.minRelevance ?? 0.1,
      includeRelationships: body.includeRelationships ?? true,
    });
    return reply.send({ data: result, meta: { timestamp: new Date().toISOString() } });
  });

  // POST /api/v5/knowledge/relationships — create a relationship
  app.post('/api/v5/knowledge/relationships', async (req, reply) => {
    const body = req.body as any;
    if (!body?.sourceId || !body?.targetId || !body?.type) {
      return reply.status(400).send({ error: 'sourceId, targetId, and type are required' });
    }
    const result = graph.addRelationship({
      sourceId: body.sourceId,
      targetId: body.targetId,
      type: body.type,
      weight: body.weight,
      properties: body.properties,
    });
    if ('error' in result) {
      return reply.status(422).send({ error: result.error, code: 'RELATIONSHIP_ERROR' });
    }
    return reply.status(201).send({ data: result, meta: { timestamp: new Date().toISOString() } });
  });
}
