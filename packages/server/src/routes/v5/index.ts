import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import type { WorkspaceRegistry } from '@agentforge/db';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeJobSupervisor, type RuntimeEventEnvelope } from '@agentforge/core';
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
import { registerHealthDependenciesRoutes } from './health-dependencies.js';
// sprintOrchestrationRoutes removed — mutation routes for the old manual
// workflow were deleted as part of the sprint→cycle plan.json migration.
import { settingsRoutes } from './settings.js';
import { agentCrudRoutes } from './agent-crud.js';
import { agentRoutes } from './agents.js';
import { chatRoutes } from './chat.js';
import { runRoutes } from './run.js';
import { jobsRoutes } from './jobs.js';
import { globalStream } from './stream.js';
import { insightsRoutes } from './insights.js';
import { auditRoutes } from './audit.js';
import { schedulesRoutes } from './schedules.js';
import { webhooksRoutes } from './webhooks.js';
import { notificationsRoutes } from './notifications.js';
import { apiKeysRoutes } from './api-keys.js';
import { membersRoutes } from './members.js';
import { countersRoutes } from './counters.js';
import { autonomousBranchesRoutes } from './autonomous-branches.js';
import { dmsRoutes } from './dms.js';
import { inboxRoutes } from './inbox.js';
import { billingRoutes } from './billing.js';
import { kbsRoutes } from './kbs.js';

export interface V5RouteOptions {
  adapter: WorkspaceAdapter;
  registry: WorkspaceRegistry;
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Session transcript loader
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  role: string;
  content: string;
  ts: string;
}

/**
 * Load a session transcript from disk, if it exists.
 *
 * Looks in two places (in order):
 *   1. `<projectRoot>/.agentforge/sessions/<id>/transcript.json` — structured transcript dir
 *   2. `<projectRoot>/.agentforge/sessions/<id>*.json` — flat file matching id prefix
 *
 * Returns null when:
 *   - The file is missing (old sessions without transcript)
 *   - The file is malformed JSON
 *   - The file content doesn't contain recognizable transcript data
 */
export function loadSessionTranscript(
  sessionId: string,
  projectRoot: string,
): TranscriptEntry[] | null {
  const sessionsDir = join(projectRoot, '.agentforge', 'sessions');

  // 1. Try structured transcript at sessions/<id>/transcript.json
  const structuredPath = join(sessionsDir, sessionId, 'transcript.json');
  if (existsSync(structuredPath)) {
    try {
      const raw = readFileSync(structuredPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return (parsed as unknown[]).map((entry, idx): TranscriptEntry => {
          const e = entry as Record<string, unknown>;
          return {
            role: typeof e['role'] === 'string' ? e['role'] : 'unknown',
            content: typeof e['content'] === 'string' ? e['content'] : JSON.stringify(e),
            ts: typeof e['ts'] === 'string' ? e['ts'] : new Date(Date.now() + idx).toISOString(),
          };
        });
      }
    } catch {
      return null;
    }
  }

  // 2. Try flat file matching the session ID prefix
  if (!existsSync(sessionsDir)) return null;

  let matchingFile: string | null = null;
  try {
    const files = readdirSync(sessionsDir);
    matchingFile = files.find(f => f.startsWith(sessionId) && f.endsWith('.json')) ?? null;
    // Also check exact name match (like session-20260327T130000-cto-v48.json)
    if (!matchingFile) {
      matchingFile = files.find(f => f === `${sessionId}.json`) ?? null;
    }
  } catch {
    return null;
  }

  if (!matchingFile) return null;

  try {
    const raw = readFileSync(join(sessionsDir, matchingFile), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const data = parsed as Record<string, unknown>;

    // If it's an array with role/content entries, use directly
    if (Array.isArray(parsed)) {
      return (parsed as unknown[]).map((entry, idx): TranscriptEntry => {
        const e = entry as Record<string, unknown>;
        return {
          role: typeof e['role'] === 'string' ? e['role'] : 'unknown',
          content: typeof e['content'] === 'string' ? e['content'] : JSON.stringify(e),
          ts: typeof e['ts'] === 'string' ? e['ts'] : new Date(Date.now() + idx).toISOString(),
        };
      });
    }

    // Convert flat session file format to transcript entries
    const entries: TranscriptEntry[] = [];
    const startedAt = typeof data['startedAt'] === 'string'
      ? data['startedAt']
      : new Date().toISOString();

    // task / objective → user message
    const task = data['task'] ?? data['objective'];
    if (typeof task === 'string' && task.length > 0) {
      entries.push({ role: 'user', content: task, ts: startedAt });
    }

    // response / instruction → assistant message
    const response = data['response'] ?? data['instruction'];
    if (typeof response === 'string' && response.length > 0) {
      const completedAt = typeof data['completedAt'] === 'string'
        ? data['completedAt']
        : startedAt;
      entries.push({ role: 'assistant', content: response, ts: completedAt });
    }

    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
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
  const runtimeJobSupervisor = new RuntimeJobSupervisor({
    adapter,
    onEvent: bridgeRuntimeEventToGlobalStream,
  });

  // ── Approvals Gateway ─────────────────────────────────────────────────────────
  // When a WorkspaceAdapter is available, approvals are persisted in the workspace
  // DB (WORKSPACE_DDL schema). This collocates all workspace data and ensures the
  // approvals table is visible to future schema migration tooling.
  await approvalsRoutes(app, { adapter: opts.adapter });

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

  const sessionProjectRoot = opts.projectRoot ?? process.cwd();

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

    const sessions = adapter.listSessions({
      limit,
      offset,
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });
    const total = adapter.countSessions({
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });

    // Attach transcript to each session (null if file missing or malformed)
    const data = sessions.map(session => {
      const transcript = loadSessionTranscript(session.id, sessionProjectRoot);
      if (transcript !== null) {
        return { ...session, transcript };
      }
      return session;
    });

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

    // Attach transcript if available on disk
    const transcript = loadSessionTranscript(id, sessionProjectRoot);
    const data = transcript !== null ? { ...session, transcript } : session;

    return reply.send({ data, meta: { timestamp: new Date().toISOString() } });
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
  await mergeQueueRoutes(app, { adapter });

  // ── Knowledge Graph ───────────────────────────────────────────────────────────
  await knowledgeRoutes(app, { adapter, projectRoot: opts.projectRoot });

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

  // ── External dependency health checks ──────────────────────────────────
  registerHealthDependenciesRoutes(app);

  // Sprint Orchestration routes removed — see above comment.

  // ── Settings persistence ───────────────────────────────────────────────────
  await settingsRoutes(app);

  // ── Agent listing (GET /api/v5/agents — reads .agentforge/agents/*.yaml) ───
  await agentRoutes(app, { adapter, projectRoot: opts.projectRoot ?? process.cwd() });

  // ── Agent CRUD (create, edit, delete, fork, promote) ──────────────────────
  await agentCrudRoutes(app, opts.projectRoot ? { projectRoot: opts.projectRoot } : {});

  // ── Agent Chat Interface (P0-3) ────────────────────────────────────────────
  await chatRoutes(app);

  // ── Agent Runner (manual dispatch from dashboard) ─────────────────────────
  await runRoutes(app, { adapter, supervisor: runtimeJobSupervisor });

  // ── Runtime Jobs ──────────────────────────────────────────────────────────
  await jobsRoutes(app, { adapter, supervisor: runtimeJobSupervisor });
  // Note: searchRoutes is registered by createServerV5 (server.ts) unconditionally
  // for both adapter and no-adapter paths. Do NOT register it here to avoid
  // FST_ERR_DUPLICATED_ROUTE when adapter+registry are provided.

  // ── V2 Dashboard Endpoints ────────────────────────────────────────────────
  await insightsRoutes(app, { adapter: opts.adapter });
  await auditRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});
  await schedulesRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});
  await webhooksRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});
  await notificationsRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});
  await apiKeysRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});
  await membersRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Counters (StatusLine widget) ──────────────────────────────────────────
  await countersRoutes(app, { adapter: opts.adapter });

  // ── Autonomous Branch Management (Fix 1, v2 audit) ─────────────────────
  await autonomousBranchesRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Agent comms v1: DMs + central inbox (spec v2-agent-comm) ────────────
  await dmsRoutes(app, {
    adapter: opts.adapter,
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
  });
  await inboxRoutes(app, {
    adapter: opts.adapter,
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
  });

  // ── Billing scaffolding (plan + invoice stubs; Stripe integration Phase 2) ─
  await billingRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Knowledge Bases (Subsystem C v1) ──────────────────────────────────────
  await kbsRoutes(app, {
    adapter: opts.adapter,
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
  });
}

function bridgeRuntimeEventToGlobalStream(event: RuntimeEventEnvelope): void {
  const data: Record<string, unknown> = {
    ...event.payload,
    workspaceId: event.workspaceId,
    traceId: event.traceId,
    jobId: event.jobId,
    sessionId: event.sessionId,
    agentId: event.agentId,
    sequence: event.sequence,
  };

  if (event.type === 'job_completed' || event.type === 'job_failed' || event.type === 'job_cancelled') {
    const status = event.type === 'job_completed'
      ? 'completed'
      : event.type === 'job_cancelled'
        ? 'cancelled'
        : 'failed';

    globalStream.emit({
      type: 'workflow_event',
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      jobId: event.jobId,
      traceId: event.traceId,
      category: event.category,
      message: event.message,
      payload: { ...data, status },
    });

    const costUsd = typeof data.costUsd === 'number' ? data.costUsd : 0;
    if (event.type === 'job_completed' && costUsd > 0) {
      globalStream.emit({
        type: 'cost_event',
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        jobId: event.jobId,
        traceId: event.traceId,
        category: event.category,
        message: `[${event.agentId}] $${costUsd.toFixed(4)} (${String(data.model ?? 'unknown')})`,
        payload: data,
      });
    }
    return;
  }

  globalStream.emit({
    type: 'agent_activity',
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    jobId: event.jobId,
    traceId: event.traceId,
    category: event.category,
    message: event.message,
    payload: data,
  });
}
