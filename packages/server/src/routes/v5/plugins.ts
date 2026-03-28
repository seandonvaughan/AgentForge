import type { FastifyInstance } from 'fastify';
import { PluginHost } from '@agentforge/plugins-sdk';

const host = new PluginHost();

export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/plugins
  app.get('/api/v5/plugins', async (_req, reply) => {
    return reply.send({ data: host.list(), meta: { total: host.list().length } });
  });

  // POST /api/v5/plugins/load — body: { manifestPath: string }
  app.post('/api/v5/plugins/load', async (req, reply) => {
    const { manifestPath } = req.body as { manifestPath: string };
    try {
      const instance = await host.load(manifestPath);
      return reply.status(201).send({ data: instance });
    } catch (err: unknown) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/v5/plugins/:id/start — body: { entrypointDir: string }
  app.post<{ Params: { id: string } }>('/api/v5/plugins/:id/start', async (req, reply) => {
    const { id } = req.params;
    const { entrypointDir } = req.body as { entrypointDir: string };
    try {
      await host.start(id, entrypointDir);
      return reply.send({ ok: true });
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // POST /api/v5/plugins/:id/stop
  app.post<{ Params: { id: string } }>('/api/v5/plugins/:id/stop', async (req, reply) => {
    await host.stop(req.params.id);
    return reply.send({ ok: true });
  });
}
