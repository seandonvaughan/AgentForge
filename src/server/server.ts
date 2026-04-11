import Fastify from 'fastify';
import FastifyStatic from '@fastify/static';
import FastifyCors from '@fastify/cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { SqliteAdapter } from '../db/index.js';
import type { SseManager } from './sse/sse-manager.js';
import { registerOAuth2Hook } from './auth/index.js';
import type { OAuth2Config } from './auth/index.js';
import { sessionsRoutes } from './routes/sessions.js';
import { agentsRoutes } from './routes/agents.js';
import { costsRoutes } from './routes/costs.js';
import { sseRoute } from './sse/sse-route.js';
import { sprintsRoutes } from './routes/sprints.js';
import { orgGraphRoutes } from './routes/org-graph.js';
import { flywheelRoutes } from './routes/flywheel.js';
import { autonomyRoutes } from './routes/autonomy.js';
import { capabilitiesRoutes } from './routes/capabilities.js';
import { reviewsRoutes } from './routes/reviews.js';
import { memoryRoutes } from './routes/memory.js';
import { reforgeRoutes } from './routes/reforge.js';
import { teamsRoutes } from './routes/teams.js';
import { careersRoutes } from './routes/careers.js';
import { branchesRoutes } from './routes/branches.js';
import { cyclesRoutes } from './routes/cycles.js';
import { searchRoutes } from './routes/search.js';
import { runRoutes } from './routes/run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

export interface ServerOptions {
  port?: number;        // default 4700
  host?: string;        // default '127.0.0.1'
  dashboardPath?: string; // path to serve static files from
  adapter?: SqliteAdapter; // optional data layer for REST API routes
  sseManager?: SseManager; // optional SSE manager — registers GET /api/v1/stream when provided
  /** OAuth2 authentication configuration. Defaults to disabled (no auth). */
  auth?: OAuth2Config;
  /** Override the project root directory (used in tests to point at a temp directory). */
  projectRoot?: string;
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

  // OAuth2 Bearer token authentication — registered at root scope so the
  // onRequest hook covers all paths including 404 handlers.
  // No-op when mode is "disabled" (the default).
  const authConfig: OAuth2Config = options.auth ?? { mode: 'disabled' };
  registerOAuth2Hook(app, authConfig);

  // Serve dashboard static files
  const staticPath = options.dashboardPath ?? join(__dirname, '../../dashboard');
  await app.register(FastifyStatic, {
    root: staticPath,
    prefix: '/app',
  });

  // Health check — liveness + basic readiness signals
  app.get('/api/v1/health', async (_req, reply) => {
    const mem = process.memoryUsage();

    // Probe DB connectivity when an adapter is present
    let dbStatus: 'ok' | 'unavailable' | 'error' = 'unavailable';
    if (options.adapter) {
      try {
        options.adapter.getAgentDatabase().getDb().prepare('SELECT 1').get();
        dbStatus = 'ok';
      } catch {
        dbStatus = 'error';
      }
    }

    return reply.send({
      status: 'ok',
      version,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      db: dbStatus,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
      },
    });
  });

  // REST API routes — only registered when an adapter is provided
  if (options.adapter) {
    await app.register(sessionsRoutes, { adapter: options.adapter });
    await app.register(agentsRoutes, {
      adapter: options.adapter,
      agentsDir: options.projectRoot ? join(options.projectRoot, '.agentforge', 'agents') : undefined,
    });
    await app.register(costsRoutes, { adapter: options.adapter });
    await app.register(flywheelRoutes, { adapter: options.adapter });
    await app.register(autonomyRoutes, { adapter: options.adapter });
    await app.register(capabilitiesRoutes, { adapter: options.adapter });
    await app.register(reviewsRoutes, { adapter: options.adapter });
    await app.register(memoryRoutes, { adapter: options.adapter, projectRoot: options.projectRoot });
    await app.register(reforgeRoutes, { adapter: options.adapter });
    await app.register(teamsRoutes, { adapter: options.adapter });
    await app.register(careersRoutes, { adapter: options.adapter });
    await app.register(searchRoutes, { adapter: options.adapter, projectRoot: options.projectRoot });
    await app.register(runRoutes, { adapter: options.adapter, sseManager: options.sseManager });
  }

  // Branches route — git-backed, no DB adapter required
  await app.register(branchesRoutes, {});

  // Org-graph route — filesystem-backed (reads delegation.yaml + agent YAMLs), no DB adapter required
  await app.register(orgGraphRoutes, {});

  // Sprints route — filesystem-backed (reads .agentforge/sprints/*.json), no DB adapter required.
  // Registered unconditionally so the dashboard's /sprints pages work without a DB.
  await app.register(sprintsRoutes, { projectRoot: options.projectRoot });

  // Cycles route — filesystem-backed, exposes approval GET/POST + SSE broadcast
  await app.register(cyclesRoutes, { sseManager: options.sseManager });

  // SSE streaming endpoint — only registered when an sseManager is provided
  if (options.sseManager) {
    await app.register(sseRoute, { sseManager: options.sseManager });
  }

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
