import Fastify from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageBusV2 } from '@agentforge/core';
import type { WorkspaceAdapter, WorkspaceRegistry } from '@agentforge/db';
import { registerWebSocketRoutes } from './websocket/index.js';
import { registerWsHandler } from './websocket/ws-handler.js';
import { registerV5Routes } from './routes/v5/index.js';
import { registerV6Routes } from './routes/v6/index.js';
import { openApiRoutes } from './routes/v6/openapi.js';
import { agentRoutes } from './routes/v5/agents.js';
import { orgGraphRoutes } from './routes/v5/org-graph.js';
import { pluginRoutes } from './routes/v5/plugins.js';
import { rbacRoutes } from './routes/v5/rbac.js';
import { intelligenceRoutes } from './routes/v5/intelligence.js';
import { embeddingRoutes } from './routes/v5/embeddings.js';
import { sprintsRoutes } from './routes/v5/sprints.js';
import { cyclesRoutes } from './routes/v5/cycles.js';
import { cyclesPreviewRoutes } from './routes/v5/cycles-preview.js';
import { dashboardStubRoutes } from './routes/v5/dashboard-stubs.js';
import { runRoutes } from './routes/v5/run.js';
import { approvalsRoutes } from './routes/v5/approvals.js';
import { streamRoutes } from './routes/v5/stream.js';
import { mergeQueueRoutes } from './routes/v5/merge-queue.js';
import { agentStreamingRoutes } from './routes/v5/streaming.js';
import { multiWorkspaceRoutes } from './routes/v5/multi-workspace.js';
import { agentVersioningRoutes } from './routes/v5/agent-versioning.js';
import { federationRoutes } from './routes/v5/federation.js';
import { chatRoutes } from './routes/v5/chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptionsV5 {
  port?: number;
  host?: string;
  dashboardPath?: string;
  /** Optional message bus — enables WebSocket bridge when provided. */
  bus?: MessageBusV2;
  /** Optional workspace adapter — enables full v5 REST API when provided. */
  adapter?: WorkspaceAdapter;
  /** Optional workspace registry — enables workspace listing when provided. */
  registry?: WorkspaceRegistry;
  /** Optional project root path for resolving agent YAML files. Defaults to auto-detected from __dirname. */
  projectRoot?: string;
  /** Optional data directory for embeddings and other persistent data. */
  dataDir?: string;
  /** Optional path to plugins directory — enables plugin hot-reload when provided. */
  pluginsDir?: string;
  /** Set to false to skip app.listen() — useful for testing with inject(). Default: true. */
  listen?: boolean;
}

export async function createServerV5(options: ServerOptionsV5 = {}) {
  const port = options.port ?? 4750;
  const host = options.host ?? '127.0.0.1';
  const projectRoot = options.projectRoot ?? join(__dirname, '../../../');
  const dataDir = options.dataDir ?? join(projectRoot, '.agentforge/v5');

  const app = Fastify({
    logger: { transport: { target: 'pino-pretty', options: { colorize: true } } },
  });

  await app.register(FastifyCors, {
    origin: [
      `http://${host}:${port}`,
      `http://localhost:${port}`,
      'http://localhost:4751',
      'http://localhost:4752',
      'http://127.0.0.1:4751',
      'http://127.0.0.1:4752',
    ],
  });

  // ── v5 REST routes (full stack when adapter+registry provided) ───────────────
  if (options.adapter && options.registry) {
    await registerV5Routes(app, {
      adapter: options.adapter,
      registry: options.registry,
    });
  } else {
    // Minimal stubs so the server is usable without a database adapter
    app.get('/api/v5/health', async (_req, reply) => {
      return reply.send({
        status: 'ok',
        version: '6.1.0',
        api: 'v5',
        timestamp: new Date().toISOString(),
      });
    });

    app.get('/api/v5/workspaces', async (_req, reply) => {
      return reply.send({ data: [], meta: { total: 0, timestamp: new Date().toISOString() } });
    });

    // RBAC routes use in-memory state only — always available
    await rbacRoutes(app);

    // Approvals gateway — in-memory, no adapter required
    await approvalsRoutes(app);

    // SSE stream + dashboard refresh signal — in-memory, no adapter required
    await streamRoutes(app);

    // Git branch manager / merge queue — in-memory, no adapter required
    await mergeQueueRoutes(app);

    // Agent runtime streaming — in-memory, no adapter required
    await agentStreamingRoutes(app);

    // Multi-workspace aggregation — in-memory, no adapter required
    await multiWorkspaceRoutes(app);

    // Agent version pinning — in-memory, no adapter required
    await agentVersioningRoutes(app);

    // Cross-instance federation — in-memory dry-run, no adapter required
    await federationRoutes(app);
  }

  // ── Agent routes (reads .agentforge/agents/*.yaml — no adapter required) ──────
  await agentRoutes(app, { adapter: options.adapter, projectRoot });

  // ── Org graph (reads delegation.yaml — no adapter required) ──────────────────
  await orgGraphRoutes(app, { projectRoot });

  // ── Sprints (reads .agentforge/sprints/*.json — no adapter required) ─────────
  await sprintsRoutes(app, { projectRoot });

  // ── Cycles (reads .agentforge/cycles/*/ — no adapter required) ───────────────
  await cyclesRoutes(app, { projectRoot });
  await cyclesPreviewRoutes(app, { projectRoot });

  // ── Dashboard stubs (flywheel, memory, settings — file-based, no adapter) ──
  await dashboardStubRoutes(app, { projectRoot });

  // ── Execution API (reads .agentforge/agents/*.yaml — optional adapter for persistence) ──
  await runRoutes(app, { adapter: options.adapter });

  // ── Agent Chat Interface (P0-3) — no adapter required, uses audit.db directly ──
  await chatRoutes(app);

  // ── Plugin loader (hot-reload when pluginsDir provided) ───────────────────────
  if (options.pluginsDir) {
    const { PluginLoader } = await import('./plugins/plugin-loader.js');
    const loader = new PluginLoader(options.pluginsDir);
    const result = await loader.loadAll();
    if (result.loaded.length > 0) {
      console.log(`  Loaded ${result.loaded.length} plugin(s): ${result.loaded.join(', ')}`);
    }
  }

  // ── Plugin routes ─────────────────────────────────────────────────────────────
  await pluginRoutes(app);

  // ── Intelligence routes ───────────────────────────────────────────────────────
  await intelligenceRoutes(app);

  // ── Embedding routes ──────────────────────────────────────────────────────────
  await embeddingRoutes(app, { dataDir });

  // ── v6 Unified API routes + OpenAPI spec ────────────────────────────────────
  if (options.adapter && options.registry) {
    await registerV6Routes(app, {
      adapter: options.adapter,
      registry: options.registry,
      projectRoot,
    });
  }
  // OpenAPI spec is always available (no adapter required)
  await openApiRoutes(app);

  // ── WebSocket handler on /ws (P1-5) — always available ─────────────────────
  await registerWsHandler(app);

  // ── WebSocket bus bridge on /api/v5/ws (enabled when bus is provided) ───────
  if (options.bus && options.adapter) {
    await registerWebSocketRoutes(app, {
      bus: options.bus,
      adapter: options.adapter,
    });
  }

  // ── Static dashboard (optional) ───────────────────────────────────────────────
  if (options.dashboardPath) {
    await app.register(FastifyStatic, {
      root: options.dashboardPath,
      prefix: '/',
      decorateReply: false,
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found', path: req.url });
    }
    return reply.status(404).send({ error: 'Not found' });
  });

  if (options.listen !== false) {
    await app.listen({ port, host });
  }

  return { app, port, host };
}
