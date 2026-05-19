import Fastify, { type FastifyInstance } from 'fastify';
import FastifyCors from '@fastify/cors';
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
import { agentCrudRoutes } from './routes/v5/agent-crud.js';
import { orgGraphRoutes } from './routes/v5/org-graph.js';
import { pluginRoutes } from './routes/v5/plugins.js';
import { rbacRoutes } from './routes/v5/rbac.js';
import { intelligenceRoutes } from './routes/v5/intelligence.js';
import { embeddingRoutes } from './routes/v5/embeddings.js';
import { sprintsRoutes } from './routes/v5/sprints.js';
import { cyclesRoutes } from './routes/v5/cycles.js';
import { cyclesPreviewRoutes } from './routes/v5/cycles-preview.js';
import { codexReadinessRoutes } from './routes/v5/codex-readiness.js';
import { dashboardStubRoutes } from './routes/v5/dashboard-stubs.js';
import { runRoutes } from './routes/v5/run.js';
import { runStreamRoutes } from './routes/v5/run-stream.js';
import { approvalsRoutes } from './routes/v5/approvals.js';
import { streamRoutes } from './routes/v5/stream.js';
import { mergeQueueRoutes } from './routes/v5/merge-queue.js';
import { agentStreamingRoutes } from './routes/v5/streaming.js';
import { multiWorkspaceRoutes } from './routes/v5/multi-workspace.js';
import { workspacesRoutes } from './routes/v5/workspaces.js';
import { workspacesActiveRoutes } from './routes/v5/workspaces-active.js';
import { agentVersioningRoutes } from './routes/v5/agent-versioning.js';
import { federationRoutes } from './routes/v5/federation.js';
import { chatRoutes } from './routes/v5/chat.js';
import { settingsRoutes } from './routes/v5/settings.js';
import { searchRoutes } from './routes/v5/search.js';
import { knowledgeRoutes } from './routes/v5/knowledge.js';
import { auditRoutes } from './routes/v5/audit.js';
import { billingRoutes } from './routes/v5/billing.js';
import { registerFlywheelContinuousImprovementRoutes } from './routes/v5/flywheel-continuous-improvement.js';
import { cyclePrsRoutes } from './routes/v5/cycle-prs.js';
import { cycleCostBreakdownRoutes } from './routes/v5/cycle-cost-breakdown.js';
import { qualityRoutes } from './routes/v5/quality.js';
import { sendContainedStaticFile } from './lib/static-files.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const securityHeaders: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (_req, reply) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      reply.raw.setHeader(name, value);
    }
  });
}

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

  registerSecurityHeaders(app);

  // Register @fastify/websocket exactly once for the entire app. Both
  // registerWsHandler (/ws) and registerWebSocketRoutes (/api/v5/ws) depend on
  // it; registering twice throws FST_ERR_DEC_ALREADY_PRESENT('ws').
  await app.register(import('@fastify/websocket'));

  await app.register(FastifyCors, {
    // Strict localhost-only allowlist — no wildcard, no credentials.
    // If the server is ever exposed beyond loopback, extend this list and
    // register the OAuth2 auth hook (registerOAuth2Hook) before doing so.
    origin: [
      `http://${host}:${port}`,
      `http://localhost:${port}`,
      'http://localhost:4751',
      'http://localhost:4752',
      'http://127.0.0.1:4751',
      'http://127.0.0.1:4752',
    ],
    // Explicit values for defense-in-depth — do not rely on @fastify/cors defaults.
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Workspace-Id'],
  });

  // ── v5 REST routes (full stack when adapter+registry provided) ───────────────
  if (options.adapter && options.registry) {
    await registerV5Routes(app, {
      adapter: options.adapter,
      registry: options.registry,
      projectRoot,
      ...(options.bus ? { bus: options.bus } : {}),
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

    // Codex runtime readiness is needed by the dashboard in the no-adapter
    // local dev path as well as the full workspace-backed route set.
    await codexReadinessRoutes(app, { projectRoot });

    // v6.6.0 — workspace registry CRUD (~/.agentforge/workspaces.json)
    await workspacesRoutes(app);

    // Settings — file-backed YAML, no adapter required. Registering here
    // unconditionally fixes the 404 the dashboard hit when saving settings.
    await settingsRoutes(app);

    // RBAC routes use in-memory state only — always available
    await rbacRoutes(app);

    // Approvals gateway — SQLite-backed (.agentforge/audit.db). projectRoot
    // pinning prevents the no-adapter boot path from writing to the monorepo's
    // shared audit.db when running outside a project.
    await approvalsRoutes(app, { projectRoot });

    // SSE stream + dashboard refresh signal — in-memory, no adapter required
    await streamRoutes(app);

    // Git branch manager / merge queue — uses SQLite when adapter is available
    // (else-branch may have adapter without registry; mirror knowledgeRoutes pattern)
    await mergeQueueRoutes(app, { adapter: options.adapter });

    // Knowledge graph — reads .agentforge/knowledge/entities.jsonl so the
    // /knowledge page is populated from cycle-accumulated entity data.
    // Pass adapter when available (else-branch may have adapter without registry)
    // so SQLite KV persistence is engaged rather than running fully in-memory.
    await knowledgeRoutes(app, { projectRoot, adapter: options.adapter });

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
    await agentRoutes(app, { ...(options.adapter !== undefined ? { adapter: options.adapter } : {}), projectRoot });
    // Agent CRUD (create, patch, delete, fork, promote, raw YAML) — no adapter required.
    // Same guard: registerV5Routes already calls agentCrudRoutes in adapter mode.
    await agentCrudRoutes(app, { projectRoot });
    // Audit log — file-backed SQLite, no adapter required.
    // Guard: registerV5Routes already calls auditRoutes in adapter mode.
    await auditRoutes(app, { projectRoot });
    // Billing scaffolding — no adapter required (reads/writes settings.yaml).
    // Guard: registerV5Routes registers billingRoutes in adapter mode.
    await billingRoutes(app, { projectRoot });
  }

  // ── Active Worktrees (T4.7) — no adapter required ────────────────────────────
  // Guard: registerV5Routes already calls workspacesActiveRoutes in adapter mode.
  if (!options.adapter || !options.registry) {
    await workspacesActiveRoutes(app, { projectRoot });
  }

  // ── Org graph (reads delegation.yaml — no adapter required) ──────────────────
  // Registered unconditionally here (no adapter+registry guard) so it is
  // available in BOTH adapter mode and no-adapter mode. It is intentionally
  // NOT in registerV5Routes — adding it there would cause FST_ERR_DUPLICATED_ROUTE
  // when adapter+registry are provided. Same pattern as searchRoutes.
  await orgGraphRoutes(app, { projectRoot });

  // ── Sprints (reads .agentforge/sprints/*.json — no adapter required) ─────────
  await sprintsRoutes(app, { projectRoot });

  // ── Cycles (reads .agentforge/cycles/*/ — no adapter required) ───────────────
  await cyclesRoutes(app, { projectRoot });
  await cyclesPreviewRoutes(app, { projectRoot });

  // ── Cycle PR ledger (MergeQueue enriched with CI status) ─────────────────
  // Guard: registerV5Routes already calls cyclePrsRoutes in adapter mode.
  if (!options.adapter || !options.registry) {
    await cyclePrsRoutes(app, { projectRoot });
  }

  // ── Cycle cost breakdown (per-token breakdown from cycle.json) ────────────
  // Guard: registerV5Routes already calls cycleCostBreakdownRoutes in adapter mode.
  if (!options.adapter || !options.registry) {
    await cycleCostBreakdownRoutes(app, { projectRoot });
  }

  // ── Quality metrics (step-scores, aggregates, skill-effectiveness) ────────
  // Guard: registerV5Routes already calls qualityRoutes in adapter mode.
  if (!options.adapter || !options.registry) {
    await qualityRoutes(app, { projectRoot });
  }

  // ── Unified keyword search (sessions, agents, sprints, cycles, memory) ────────
  // No adapter required — falls back gracefully; adapter enables session search.
  await searchRoutes(app, { projectRoot, ...(options.adapter !== undefined ? { adapter: options.adapter } : {}) });

  // ── Dashboard stubs (flywheel, memory, settings — file-based, no adapter) ──
  await dashboardStubRoutes(app, { projectRoot });

  // ── Flywheel: continuous-improvement per-cycle preventability metrics ──
  // Reads .agentforge/flywheel/continuous-improvement-*.json — no adapter required.
  // Guard: registerV5Routes already registers this in adapter mode.
  if (!options.adapter || !options.registry) {
    registerFlywheelContinuousImprovementRoutes(app, { projectRoot });
  }

  // ── Execution API (reads .agentforge/agents/*.yaml — optional adapter for persistence) ──
  // v9.0.0: registerV5Routes also calls runRoutes in adapter mode. Guard to
  // avoid FST_ERR_DUPLICATED_ROUTE.
  if (!options.adapter || !options.registry) {
    await runRoutes(app, { ...(options.adapter !== undefined ? { adapter: options.adapter } : {}) });
    // Per-run SSE stream (T5.2). registerV5Routes also wires this in adapter
    // mode, so guard accordingly.
    await runStreamRoutes(app);
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
  await embeddingRoutes(app, { dataDir, ...(options.adapter !== undefined ? { adapter: options.adapter } : {}) });

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

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found', path: req.url });
    }
    if (options.dashboardPath) {
      const served = await sendContainedStaticFile(req, reply, {
        root: options.dashboardPath,
        fallbackFile: 'index.html',
      });
      if (served) return reply;
    }
    return reply.status(404).send({ error: 'Not found' });
  });

  if (options.listen !== false) {
    await app.listen({ port, host });
  }

  return { app, port, host };
}
