import type { FastifyInstance } from 'fastify';
import { EmbeddingStore } from '@agentforge/embeddings';
import { join } from 'node:path';

// Singleton store per server process
let store: EmbeddingStore | null = null;

function getStore(dataDir: string): EmbeddingStore {
  if (!store) {
    store = new EmbeddingStore(join(dataDir, 'embeddings.db'));
  }
  return store;
}

export async function embeddingRoutes(app: FastifyInstance, opts: { dataDir: string }): Promise<void> {
  const s = getStore(opts.dataDir);

  // POST /api/v5/embeddings/index
  app.post('/api/v5/embeddings/index', async (req, reply) => {
    const { id, content, metadata, workspaceId } = req.body as {
      id: string; content: string; metadata?: Record<string, unknown>; workspaceId?: string;
    };
    const vec = await s.index({ id, content, metadata, workspaceId });
    return reply.status(201).send({ data: { id, dims: vec.length } });
  });

  // POST /api/v5/embeddings/index/batch
  app.post('/api/v5/embeddings/index/batch', async (req, reply) => {
    const { documents } = req.body as {
      documents: Array<{ id: string; content: string; metadata?: Record<string, unknown>; workspaceId?: string }>;
    };
    await s.indexBatch(documents);
    return reply.send({ data: { indexed: documents.length } });
  });

  // POST /api/v5/embeddings/search
  app.post('/api/v5/embeddings/search', async (req, reply) => {
    const { query, topK, minScore, workspaceId } = req.body as {
      query: string; topK?: number; minScore?: number; workspaceId?: string;
    };
    const results = await s.search(query, { topK, minScore, workspaceId });
    return reply.send({ data: results, meta: { total: results.length } });
  });

  // GET /api/v5/embeddings/stats
  app.get('/api/v5/embeddings/stats', async (_req, reply) => {
    return reply.send({ data: s.stats() });
  });

  // POST /api/v5/embeddings/learn-session
  app.post('/api/v5/embeddings/learn-session', async (req, reply) => {
    const { sessionId, agentId, task, response, model, costUsd, workspaceId } = req.body as {
      sessionId: string;
      agentId: string;
      task: string;
      response: string;
      model: string;
      costUsd?: number;
      workspaceId?: string;
    };
    await s.indexSession({ sessionId, agentId, task, response, model, costUsd, workspaceId });
    return reply.status(201).send({ data: { sessionId } });
  });

  // DELETE /api/v5/embeddings/:id
  app.delete<{ Params: { id: string } }>('/api/v5/embeddings/:id', async (req, reply) => {
    s.delete(req.params.id);
    return reply.send({ ok: true });
  });
}
