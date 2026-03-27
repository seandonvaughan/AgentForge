import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';

export async function sessionsRoutes(app: FastifyInstance, opts: { adapter: SqliteAdapter }) {
  const { adapter } = opts;

  // GET /api/v1/sessions
  // Query params: agentId?, status?, limit? (default 50), offset? (default 0)
  // Returns: { data: SessionRow[], meta: { limit, offset, total } }
  app.get('/api/v1/sessions', async (req, reply) => {
    const query = req.query as {
      agentId?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 50;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    // Get total count for meta (without limit/offset)
    const allForCount = adapter.listSessions({
      agentId: query.agentId,
      status: query.status,
    });
    const total = allForCount.length;

    const data = adapter.listSessions({
      agentId: query.agentId,
      status: query.status,
      limit,
      offset,
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
