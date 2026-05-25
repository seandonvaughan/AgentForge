import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import type { WorkspaceRegistry } from '@agentforge/db';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  readAllLedgerJobs,
  cyclesBaseDirFor,
} from '../../lib/cycle-jobs-ledger.js';
import {
  RuntimeJobSupervisor,
  type MessageBusV2,
  type RuntimeEventEnvelope,
  type MessageEnvelopeV2,
  type AgentDmSentPayload,
  type InboxMessageCreatedPayload,
  type SelfModificationCanaryLifecyclePayload,
} from '@agentforge/core';
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
import { codexReadinessRoutes } from './codex-readiness.js';
import { registerFlywheelContinuousImprovementRoutes } from './flywheel-continuous-improvement.js';
// sprintOrchestrationRoutes removed — mutation routes for the old manual
// workflow were deleted as part of the sprint→cycle plan.json migration.
import { settingsRoutes } from './settings.js';
import { teamControlRoutes } from './team-control.js';
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
import { workspacesActiveRoutes } from './workspaces-active.js';
import { runStreamRoutes } from './run-stream.js';
import { cyclePrsRoutes } from './cycle-prs.js';
import { cycleCostBreakdownRoutes } from './cycle-cost-breakdown.js';
import { qualityRoutes } from './quality.js';
// === wave5:T4 ===
import { durabilityRoutes } from './durability.js';
// === /wave5:T4 ===
// === wave5:T7 ===
import { registerFlywheelProposalsRoutes } from './flywheel.js';
// === /wave5:T7 ===

export interface V5RouteOptions {
  adapter: WorkspaceAdapter;
  registry: WorkspaceRegistry;
  projectRoot?: string;
  /**
   * Optional bus. When provided, comms routes (`/api/v5/dms`,
   * `/api/v5/inbox`) publish bus topics and the v5 stream forwards them as
   * SSE events for live dashboard updates.
   */
  bus?: MessageBusV2;
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
      q?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);

    // SQL sessions (primary source)
    const sqlSessions = adapter.listSessions({
      limit: 10_000,
      offset: 0,
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.q !== undefined ? { search: q.q } : {}),
    });

    // Ledger sessions derived from execute.json — union when SQL is sparse
    const cyclesBase = cyclesBaseDirFor(sessionProjectRoot);
    let ledgerJobs = readAllLedgerJobs(cyclesBase);

    // Apply filters (same semantics as SQL path)
    if (q.agentId !== undefined) {
      const agentFilter = q.agentId;
      ledgerJobs = ledgerJobs.filter(r => r.agentId === agentFilter);
    }
    if (q.status !== undefined) {
      const statusFilter = q.status;
      ledgerJobs = ledgerJobs.filter(r => r.status === statusFilter);
    }
    if (q.q !== undefined && q.q.trim()) {
      const searchTerm = q.q.trim().toLowerCase();
      ledgerJobs = ledgerJobs.filter(r => {
        const searchText = `${r.id} ${r.agentId} ${r.status} ${r.cycleId}`.toLowerCase();
        return searchText.includes(searchTerm);
      });
    }

    // De-duplicate: SQL rows take precedence (match by id)
    const sqlIdSet = new Set(sqlSessions.map(s => s.id));
    const uniqueLedger = ledgerJobs.filter(r => !sqlIdSet.has(r.id));

    // Convert ledger rows to session-shaped objects
    const ledgerAsSessions = uniqueLedger.map(r => ({
      id: r.id,
      agentId: r.agentId,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      costUsd: r.costUsd,
      cycleId: r.cycleId,
      attempts: r.attempts,
      source: 'ledger' as const,
    }));

    // Attach transcript to SQL sessions
    const sqlWithTranscript = sqlSessions.map(session => {
      const transcript = loadSessionTranscript(session.id, sessionProjectRoot);
      if (transcript !== null) {
        return { ...session, transcript };
      }
      return session;
    });

    // Union: SQL first (already filtered), then unique ledger rows
    const allSessions = [...sqlWithTranscript, ...ledgerAsSessions];

    const total = allSessions.length;
    const data = allSessions.slice(offset, offset + limit);

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
  await costsRoutes(app, opts.projectRoot !== undefined ? { adapter, projectRoot: opts.projectRoot } : { adapter });

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

  // v6.7.3: read version from the AgentForge server package.json.
  // Resolves at registration time so the file is read once, not per request.
  // Uses import.meta.url to locate the package regardless of project root so
  // this reports the AgentForge version, not the external project's version.
  let pkgVersion = 'unknown';
  try {
    const { readFileSync } = await import('node:fs');
    const { join: pathJoin, dirname: pathDirname } = await import('node:path');
    const { fileURLToPath: pathFileURLToPath } = await import('node:url');
    // Walk up from packages/server/dist/routes/v5/ to packages/server/
    const serverDir = pathDirname(pathDirname(pathDirname(pathFileURLToPath(import.meta.url))));
    const candidate = pathJoin(serverDir, 'package.json');
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

  // ── Codex runtime readiness ────────────────────────────────────────────
  await codexReadinessRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Flywheel: continuous-improvement per-cycle preventability metrics ──
  registerFlywheelContinuousImprovementRoutes(
    app,
    opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot as string } : {},
  );

  // Sprint Orchestration routes removed — see above comment.

  // ── Settings persistence ───────────────────────────────────────────────────
  await settingsRoutes(app);

  // ── AgentForge team forge/rebuild control ──────────────────────────────────
  await teamControlRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

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
  await countersRoutes(app, opts.projectRoot !== undefined
    ? { adapter: opts.adapter, projectRoot: opts.projectRoot }
    : { adapter: opts.adapter });

  // ── Autonomous Branch Management (Fix 1, v2 audit) ─────────────────────
  await autonomousBranchesRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Agent comms (v1 base + v2 Phase 2 — bus topics, replies, @team-*) ───
  await dmsRoutes(app, {
    adapter: opts.adapter,
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.bus ? { bus: opts.bus } : {}),
  });
  await inboxRoutes(app, {
    adapter: opts.adapter,
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.bus ? { bus: opts.bus } : {}),
  });

  // ── Bus → SSE bridge for comms topics ───────────────────────────────────
  // When a bus is wired, forward `agent.dm.sent` and `inbox.message.created`
  // envelopes to `globalStream` so the dashboard (/inbox, /inbox/[id]) gets
  // live updates without falling back to polling.
  if (opts.bus) {
    opts.bus.subscribe<AgentDmSentPayload>('agent.dm.sent', (envelope) => {
      bridgeDmToGlobalStream(envelope);
    });
    opts.bus.subscribe<InboxMessageCreatedPayload>('inbox.message.created', (envelope) => {
      bridgeInboxToGlobalStream(envelope);
    });
    opts.bus.subscribe<SelfModificationCanaryLifecyclePayload>('self-modification.canary.staged', (envelope) => {
      bridgeSelfModificationCanaryToGlobalStream(envelope);
    });
    opts.bus.subscribe<SelfModificationCanaryLifecyclePayload>('self-modification.canary.promoted', (envelope) => {
      bridgeSelfModificationCanaryToGlobalStream(envelope);
    });
    opts.bus.subscribe<SelfModificationCanaryLifecyclePayload>('self-modification.canary.rolled_back', (envelope) => {
      bridgeSelfModificationCanaryToGlobalStream(envelope);
    });
  }

  // ── Billing scaffolding (plan + invoice stubs; Stripe integration Phase 2) ─
  await billingRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Knowledge Bases (Subsystem C v1) ──────────────────────────────────────
  await kbsRoutes(app, {
    adapter: opts.adapter,
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
  });

  // ── Active Worktrees (T4.7) ───────────────────────────────────────────────
  await workspacesActiveRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Per-run SSE stream (T5.2 — AnthropicSdkTransport cloud streaming) ────
  await runStreamRoutes(app);

  // ── Cycle PR ledger (MergeQueue enriched with CI status) ─────────────────
  await cyclePrsRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Cycle cost breakdown (per-token breakdown from cycle.json) ────────────
  await cycleCostBreakdownRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // ── Quality metrics (step-scores, aggregates, skill-effectiveness) ────────
  await qualityRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});

  // === wave5:T4 ===
  // ── Durability — checkpoint list + resume UX ─────────────────────────────
  await durabilityRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});
  // === /wave5:T4 ===
  // === wave5:T7 ===
  // ── Flywheel proposals (skill refinement / creation proposals) ────────────
  registerFlywheelProposalsRoutes(app, opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {});
  // === /wave5:T7 ===
}

/** Exported for unit-test access. Forwards a bus DM envelope as an SSE event. */
export function bridgeDmToGlobalStream(envelope: MessageEnvelopeV2<AgentDmSentPayload>): void {
  const p = envelope.payload;
  globalStream.emit({
    type: 'comms_event',
    category: 'comms',
    message: `DM ${p.fromAgent} → ${p.toAgent}`,
    payload: {
      kind: 'dm',
      id: p.id,
      fromAgent: p.fromAgent,
      toAgent: p.toAgent,
      body: p.body,
      replyToId: p.replyToId,
      sentAt: p.sentAt,
    },
  });
}

/** Exported for unit-test access. Forwards a bus inbox envelope as an SSE event. */
export function bridgeInboxToGlobalStream(envelope: MessageEnvelopeV2<InboxMessageCreatedPayload>): void {
  const p = envelope.payload;
  globalStream.emit({
    type: 'comms_event',
    category: 'comms',
    message: `Inbox: ${p.sourceType ?? 'system'} → ${p.recipients.join(', ')}`,
    payload: {
      kind: 'inbox',
      id: p.id,
      body: p.body,
      messageKind: p.kind,
      sourceId: p.sourceId,
      sourceType: p.sourceType,
      threadId: p.threadId,
      createdAt: p.createdAt,
      recipients: p.recipients,
    },
  });
}

/** Exported for unit-test access. Forwards self-mod canary lifecycle events as SSE workflow events. */
export function bridgeSelfModificationCanaryToGlobalStream(
  envelope: MessageEnvelopeV2<SelfModificationCanaryLifecyclePayload>,
): void {
  const p = envelope.payload;
  const action = envelope.topic.endsWith(".staged")
    ? "staged"
    : envelope.topic.endsWith(".promoted")
      ? "promoted"
      : "rolled back";
  globalStream.emit({
    type: "workflow_event",
    workspaceId: envelope.workspaceId,
    category: "deployment",
    message: `Self-mod canary ${action}: ${p.agentName}`,
    payload: {
      topic: envelope.topic,
      ...p,
    },
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
