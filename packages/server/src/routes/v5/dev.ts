import type { FastifyInstance } from 'fastify';

export async function devRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/dev/status — full server status snapshot
  app.get('/api/v5/dev/status', async (_req, reply) => {
    return reply.send({
      data: {
        version: '5.1.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        env: process.env['NODE_ENV'] ?? 'development',
        timestamp: new Date().toISOString(),
      },
    });
  });

  // POST /api/v5/dev/reload — trigger a soft reload (for dev)
  app.post('/api/v5/dev/reload', async (_req, reply) => {
    return reply.send({ ok: true, message: 'Reload acknowledged (restart process to apply changes)' });
  });
}
