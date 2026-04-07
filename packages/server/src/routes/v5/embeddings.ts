import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
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

/**
 * Seed the embedding store with completed sessions from the adapter.
 * Runs at most once per process (when the store is empty).
 * This ensures the /search dashboard page returns results immediately without
 * requiring a separate index-population step.
 */
async function maybeSeedFromSessions(s: EmbeddingStore, adapter: WorkspaceAdapter): Promise<void> {
  if (s.stats().totalDocuments > 0) return;

  const sessions = adapter.listSessions({ status: 'completed', limit: 500 });
  if (sessions.length === 0) return;

  const docs = sessions.map(session => ({
    id: `session:${session.id}`,
    content: `Agent: ${session.agent_id}\nTask: ${session.task}`,
    metadata: {
      type: 'session',
      source: session.agent_id,
      agentId: session.agent_id,
      status: session.status,
      model: session.model ?? 'sonnet',
      costUsd: session.cost_usd,
      startedAt: session.started_at,
    },
  }));

  await s.indexBatch(docs);
}

export async function embeddingRoutes(
  app: FastifyInstance,
  opts: { dataDir: string; adapter?: WorkspaceAdapter },
): Promise<void> {
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
  // Accepts `limit` as an alias for `topK` (the dashboard sends `limit`).
  app.post('/api/v5/embeddings/search', async (req, reply) => {
    const { query, topK, limit, minScore, workspaceId } = req.body as {
      query: string; topK?: number; limit?: number; minScore?: number; workspaceId?: string;
    };

    // Seed from sessions on first search if store is empty and adapter is available.
    if (opts.adapter) {
      await maybeSeedFromSessions(s, opts.adapter);
    }

    const k = topK ?? limit ?? 10;
    const results = await s.search(query, { topK: k, minScore, workspaceId });
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
