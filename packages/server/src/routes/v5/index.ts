import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import type { WorkspaceRegistry } from '@agentforge/db';
import { rbacRoutes } from './rbac.js';
import { costsRoutes } from './costs.js';
import { approvalsRoutes } from './approvals.js';
import { workflowRoutes } from './workflows.js';
import { budgetRoutes } from './budget.js';
import { observabilityRoutes } from './observability.js';
import { streamRoutes } from './stream.js';
import { mergeQueueRoutes } from './merge-queue.js';
import { knowledgeRoutes } from './knowledge.js';
import { canaryRoutes } from './canary.js';
import { tracingRoutes } from './tracing.js';
import { costAutopilotRoutes } from './cost-autopilot.js';
import { predictivePlanningRoutes } from './predictive-planning.js';
import { marketplaceRoutes } from './marketplace.js';
import { nlInterfaceRoutes } from './nl-interface.js';
import { agentStreamingRoutes } from './streaming.js';
import { multiWorkspaceRoutes } from './multi-workspace.js';
import { agentVersioningRoutes } from './agent-versioning.js';
import { federationRoutes } from './federation.js';
import { registerHealthServicesRoutes } from './health-services.js';
import { sprintOrchestrationRoutes } from './sprint-orchestration.js';
import { settingsRoutes } from './settings.js';
import { agentCrudRoutes } from './agent-crud.js';
import { agentRoutes } from './agents.js';
import { chatRoutes } from './chat.js';
import { runRoutes } from './run.js';

export interface V5RouteOptions {
  adapter: WorkspaceAdapter;
  registry: WorkspaceRegistry;
  projectRoot?: string;
}

/**
 * Register all v5 REST API routes.
 *
 * These routes are workspace-scoped and complement the WebSocket bus.
 * The workspace in scope is determined by the adapter passed in — swap
 * the adapter to serve a different workspace.
 */
export async function registerV5Routes(
  app: FastifyInstance,
  opts: V5RouteOptions,
): Promise<void> {
  const { adapter, registry } = opts;

  // ── Approvals Gateway ─────────────────────────────────────────────────────────
  await approvalsRoutes(app);

  // ── RBAC & Audit ─────────────────────────────────────────────────────────────
  await rbacRoutes(app);

  // ── Workspaces ───────────────────────────────────────────────────────────────

  /** List all registered workspaces. */
  app.get('/api/v5/workspaces', async (_req, reply) => {
    const workspaces = registry.listWorkspaces();
    return reply.send({
      data: workspaces,
      meta: {
        total: workspaces.length,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // ── Sessions ─────────────────────────────────────────────────────────────────

  /** List sessions with optional pagination and filtering. */
  app.get('/api/v5/sessions', async (req, reply) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      agentId?: string;
      status?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);

    const data = adapter.listSessions({
      limit,
      offset,
      agentId: q.agentId,
      status: q.status,
    });
    const total = adapter.countSessions({ agentId: q.agentId, status: q.status });

    return reply.send({
      data,
      meta: {
        total,
        limit,
        offset,
        workspaceId: adapter.workspaceId,
        timestamp: new Date().toISOString(),
      },
    });
  });

  /** Get a single session by ID. */
  app.get('/api/v5/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = adapter.getSession(id);
    if (!session) {
      return reply.status(404).send({
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND',
        details: { id },
      });
    }
    return reply.send({ data: session, meta: { timestamp: new Date().toISOString() } });
  });

  // ── Costs ────────────────────────────────────────────────────────────────────

  /** List all cost records for the workspace. */
  app.get('/api/v5/costs', async (_req, reply) => {
    const costs = adapter.getAllCosts();
    const total = adapter.getTotalCost();
    return reply.send({
      data: costs,
      meta: {
        total: costs.length,
        totalCostUsd: total,
        workspaceId: adapter.workspaceId,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // ── Autonomy / Promotions ─────────────────────────────────────────────────────

  /** List all promotion/demotion records. */
  app.get('/api/v5/autonomy', async (_req, reply) => {
    const data = adapter.listPromotions();
    return reply.send({
      data,
      meta: {
        total: data.length,
        workspaceId: adapter.workspaceId,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // ── Costs Summary ─────────────────────────────────────────────────────────────
  await costsRoutes(app, { adapter });

  // ── Workflow orchestration ─────────────────────────────────────────────────────
  await workflowRoutes(app);

  // ── Cost governance ───────────────────────────────────────────────────────────
  await budgetRoutes(app);

  // ── Observability ─────────────────────────────────────────────────────────────
  await observabilityRoutes(app);

  // ── SSE stream + Git branch manager ───────────────────────────────────────────
  await streamRoutes(app);
  await mergeQueueRoutes(app);

  // ── Knowledge Graph ───────────────────────────────────────────────────────────
  await knowledgeRoutes(app);

  // ── Canary Deployments ────────────────────────────────────────────────────────
  await canaryRoutes(app);

  // ── Distributed Tracing ───────────────────────────────────────────────────────
  await tracingRoutes(app);

  // ── Cost Autopilot ────────────────────────────────────────────────────────────
  await costAutopilotRoutes(app);

  // ── Predictive Sprint Planning ────────────────────────────────────────────────
  await predictivePlanningRoutes(app);

  // ── Agent Marketplace ─────────────────────────────────────────────────────────
  await marketplaceRoutes(app);

  // ── Natural Language Interface ────────────────────────────────────────────────
  await nlInterfaceRoutes(app);

  // ── Agent Runtime Streaming ───────────────────────────────────────────────────
  await agentStreamingRoutes(app);

  // ── Multi-Workspace Dashboard ─────────────────────────────────────────────────
  await multiWorkspaceRoutes(app);

  // ── Agent Version Pinning ─────────────────────────────────────────────────────
  await agentVersioningRoutes(app);

  // ── Cross-Instance Federation ─────────────────────────────────────────────────
  await federationRoutes(app);

  // ── Health ────────────────────────────────────────────────────────────────────

  // v6.7.3: read version from root package.json — single source of truth.
  // Resolves at registration time so the file is read once, not per request.
  let pkgVersion = 'unknown';
  try {
    const { readFileSync } = await import('node:fs');
    const { join: pathJoin } = await import('node:path');
    // Walk up from this module to find the workspace root package.json
    const candidate = pathJoin(process.cwd(), 'package.json');
    pkgVersion = String(JSON.parse(readFileSync(candidate, 'utf8')).version ?? 'unknown');
  } catch { /* fall back to 'unknown' */ }

  /** v5 health check — includes workspace context. */
  app.get('/api/v5/health', async (_req, reply) => {
    return reply.send({
      status: 'ok',
      version: pkgVersion,
      api: 'v5',
      workspaceId: adapter.workspaceId,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Service-level health (per-service circuit breaker status) ─────────────
  registerHealthServicesRoutes(app);

  // ── Sprint Orchestration (create, advance, item updates, execute) ──────────
  await sprintOrchestrationRoutes(app, opts.projectRoot ? { projectRoot: opts.projectRoot } : undefined);

  // ── Settings persistence ───────────────────────────────────────────────────
  await settingsRoutes(app);

  // ── Agent listing (GET /api/v5/agents — reads .agentforge/agents/*.yaml) ───
  await agentRoutes(app, { adapter, projectRoot: opts.projectRoot ?? process.cwd() });

  // ── Agent CRUD (create, edit, delete, fork, promote) ──────────────────────
  await agentCrudRoutes(app, opts.projectRoot ? { projectRoot: opts.projectRoot } : {});

  // ── Agent Chat Interface (P0-3) ────────────────────────────────────────────
  await chatRoutes(app);

  // ── Agent Runner (manual dispatch from dashboard) ─────────────────────────
  await runRoutes(app, { adapter });
  // Note: searchRoutes is registered by createServerV5 (server.ts) unconditionally
  // for both adapter and no-adapter paths. Do NOT register it here to avoid
  // FST_ERR_DUPLICATED_ROUTE when adapter+registry are provided.
}
