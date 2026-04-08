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
import { workspacesRoutes } from './routes/v5/workspaces.js';
import { agentVersioningRoutes } from './routes/v5/agent-versioning.js';
import { federationRoutes } from './routes/v5/federation.js';
import { chatRoutes } from './routes/v5/chat.js';
import { settingsRoutes } from './routes/v5/settings.js';
import { searchRoutes } from './routes/v5/search.js';

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

  // Register @fastify/websocket exactly once for the entire app. Both
  // registerWsHandler (/ws) and registerWebSocketRoutes (/api/v5/ws) depend on
  // it; registering twice throws FST_ERR_DEC_ALREADY_PRESENT('ws').
  await app.register(import('@fastify/websocket'));

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
    // v6.7.3: read version from root package.json so dashboard + health
    // endpoint always agree with the actual shipped version. Single source
    // of truth — no more hardcoded "6.1.0" drift.
    let pkgVersion = 'unknown';
    try {
      const pkgPath = join(projectRoot, 'package.json');
      const { readFileSync } = await import('node:fs');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkgVersion = String(pkg.version ?? 'unknown');
    } catch { /* fall back to 'unknown' */ }
    app.get('/api/v5/health', async (_req, reply) => {
      return reply.send({
        status: 'ok',
        version: pkgVersion,
        api: 'v5',
        timestamp: new Date().toISOString(),
      });
    });

    // v6.6.0 — workspace registry CRUD (~/.agentforge/workspaces.json)
    await workspacesRoutes(app);

    // Settings — file-backed YAML, no adapter required. Registering here
    // unconditionally fixes the 404 the dashboard hit when saving settings.
    await settingsRoutes(app);

    // RBAC routes use in-memory state only — always available
    await rbacRoutes(app);

    // Approvals gateway — in-memory, no adapter required.
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
  // v9.0.0: registerV5Routes already calls agentRoutes in adapter mode, so
  // only register here when we're in the no-adapter path. Without the guard
  // agentRoutes is called twice and Fastify throws FST_ERR_DUPLICATED_ROUTE.
  if (!options.adapter || !options.registry) {
    await agentRoutes(app, { adapter: options.adapter, projectRoot });
  }

  // ── Org graph (reads delegation.yaml — no adapter required) ──────────────────
  await orgGraphRoutes(app, { projectRoot });

  // ── Sprints (reads .agentforge/sprints/*.json — no adapter required) ─────────
  await sprintsRoutes(app, { projectRoot });

  // ── Cycles (reads .agentforge/cycles/*/ — no adapter required) ───────────────
  await cyclesRoutes(app, { projectRoot });
  await cyclesPreviewRoutes(app, { projectRoot });

  // ── Unified keyword search (sessions, agents, sprints, cycles, memory) ────────
  // No adapter required — falls back gracefully; adapter enables session search.
  await searchRoutes(app, { projectRoot, adapter: options.adapter });

  // ── Dashboard stubs (flywheel, memory, settings — file-based, no adapter) ──
  await dashboardStubRoutes(app, { projectRoot });

  // ── Execution API (reads .agentforge/agents/*.yaml — optional adapter for persistence) ──
  // v9.0.0: registerV5Routes also calls runRoutes in adapter mode. Guard to
  // avoid FST_ERR_DUPLICATED_ROUTE.
  if (!options.adapter || !options.registry) {
    await runRoutes(app, { adapter: options.adapter });
  }

  // ── Agent Chat Interface (P0-3) — no adapter required, uses audit.db directly ──
  // v6.7.1 fix: only register here when adapter is NOT present, because
  // registerV5Routes already registers chatRoutes when an adapter exists.
  // Without this guard, the chat routes get declared twice and Fastify
  // throws FST_ERR_DUPLICATED_ROUTE on startup.
  if (!options.adapter) {
    await chatRoutes(app);
  }

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
  // Pass adapter so the store can be seeded from sessions on first search.
  await embeddingRoutes(app, { dataDir, adapter: options.adapter });

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
