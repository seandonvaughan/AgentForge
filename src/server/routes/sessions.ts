import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';

export async function sessionsRoutes(app: FastifyInstance, opts: { adapter: SqliteAdapter }) {
  const { adapter } = opts;

  // GET /api/v1/sessions
  // Query params: agentId?, status?, limit? (default 50), offset? (default 0), since?, until?
  // Returns: { data: SessionRow[], meta: { limit, offset, total } }
  app.get('/api/v1/sessions', async (req, reply) => {
    const query = req.query as {
      agentId?: string;
      status?: string;
      limit?: string;
      offset?: string;
      since?: string;
      until?: string;
    };

    const rawLimit = query.limit !== undefined ? parseInt(query.limit, 10) : 50;
    const rawOffset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 500);
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

    // Get total count for meta (without limit/offset) using COUNT(*) query
    const total = adapter.countSessions({
      agentId: query.agentId,
      status: query.status,
      since: query.since,
      until: query.until,
    });

    const data = adapter.listSessions({
      agentId: query.agentId,
      status: query.status,
      limit,
      offset,
      since: query.since,
      until: query.until,
    });

    return reply.send({
      data,
      meta: { limit, offset, total },
    });
  });

  // GET /api/v1/sessions/:id
  // Returns: { data: SessionRow & { children: SessionRow[] } }
  // Returns 404 JSON if not found
  app.get('/api/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const session = adapter.getSession(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found', id });
    }

    // Get delegation chain via AgentDatabase
    const agentDb = adapter.getAgentDatabase();
    const tree = agentDb.getSessionTree(id);
    // children = all nodes in the tree except the root itself
    const children = tree.filter(s => s.id !== id);

    return reply.send({
      data: { ...session, children },
    });
  });
}
