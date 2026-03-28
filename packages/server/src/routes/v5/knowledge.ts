import type { FastifyInstance } from 'fastify';
import { KnowledgeGraph } from '@agentforge/core';

const graph = new KnowledgeGraph();

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
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
