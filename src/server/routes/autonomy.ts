import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';

export async function autonomyRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter }
) {
  const { adapter } = opts;

  app.get('/api/v1/autonomy', async (_req, reply) => {
    try {
      const data = adapter.listPromotions();
      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });
}
