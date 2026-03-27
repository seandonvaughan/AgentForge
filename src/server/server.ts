import Fastify from 'fastify';
import FastifyStatic from '@fastify/static';
import FastifyCors from '@fastify/cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

export interface ServerOptions {
  port?: number;        // default 4700
  host?: string;        // default '127.0.0.1'
  dashboardPath?: string; // path to serve static files from
}

export async function createServer(options: ServerOptions = {}) {
  const port = options.port ?? 4700;
  const host = options.host ?? '127.0.0.1';

  const isTest = process.env.NODE_ENV === 'test';

  const app = Fastify({
    logger: isTest
      ? false
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        },
  });

  // CORS — allow localhost in dev
  await app.register(FastifyCors, {
    origin: [`http://${host}:${port}`, `http://localhost:${port}`],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  // Serve dashboard static files
  const staticPath = options.dashboardPath ?? join(__dirname, '../../dashboard');
  await app.register(FastifyStatic, {
    root: staticPath,
    prefix: '/app',
  });

  // Health check
  app.get('/api/v1/health', async (_req, reply) => {
    return reply.send({
      status: 'ok',
      version,
      timestamp: new Date().toISOString(),
    });
  });

  // SPA catch-all: return index.html for non-API routes
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found', path: req.url });
    }
    // Serve SPA
    return reply.sendFile('index.html', staticPath);
  });

  return { app, port, host };
}

export async function startServer(options: ServerOptions = {}) {
  const { app, port, host } = await createServer(options);
  try {
    await app.listen({ port, host });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use. Use the port option to specify a different port.`);
    }
    throw err;
  }
  return app;
}
