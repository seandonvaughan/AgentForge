import type { FastifyInstance } from 'fastify';
import type { RuntimeEventRow, RuntimeJobRow, WorkspaceAdapter } from '@agentforge/db';
import { RuntimeJobSupervisor } from '@agentforge/core';
import { nowIso } from '@agentforge/shared';
import {
  readAllLedgerJobs,
  findLedgerJobById,
  cyclesBaseDirFor,
  type LedgerJobRow,
} from '../../lib/cycle-jobs-ledger.js';

export async function jobsRoutes(
  app: FastifyInstance,
  opts: {
    adapter: WorkspaceAdapter;
    supervisor?: RuntimeJobSupervisor;
    /** Absolute path to the project root.  Defaults to process.cwd(). */
    projectRoot?: string;
  },
): Promise<void> {
  const supervisor = opts.supervisor ?? new RuntimeJobSupervisor({ adapter: opts.adapter });
  const projectRoot = opts.projectRoot ?? process.cwd();
  const cyclesBase = cyclesBaseDirFor(projectRoot);

  // ── GET /api/v5/jobs ──────────────────────────────────────────────────────

  app.get('/api/v5/jobs', async (req, reply) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      agentId?: string;
      status?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);

    // 1. SQL rows (original path)
    const sqlFilters = {
      limit: 10_000, // fetch all so we can union before slicing
      offset: 0,
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    };
    const sqlJobs = supervisor.listJobs(sqlFilters);

    // 2. Ledger rows from execute.json files
    let ledgerJobs = readAllLedgerJobs(cyclesBase);

    // Apply agentId filter if supplied — use String.includes/=== (no regex)
    if (q.agentId !== undefined) {
      const agentFilter = q.agentId;
      ledgerJobs = ledgerJobs.filter(r => r.agentId === agentFilter);
    }

    // Apply status filter — ledger uses 'succeeded'|'failed'; SQL uses its own values
    if (q.status !== undefined) {
      const statusFilter = q.status;
      ledgerJobs = ledgerJobs.filter(r => r.status === statusFilter);
    }

    // De-duplicate: if a SQL row has the same id as a ledger row, SQL wins
    const sqlIdSet = new Set(sqlJobs.map(j => j.id));
    const uniqueLedger = ledgerJobs.filter(r => !sqlIdSet.has(r.id));

    // Union and sort by startedAt descending (newest first)
    const allJobs: Array<{ _source: 'sql'; row: RuntimeJobRow } | { _source: 'ledger'; row: LedgerJobRow }> = [
      ...sqlJobs.map(r => ({ _source: 'sql' as const, row: r })),
      ...uniqueLedger.map(r => ({ _source: 'ledger' as const, row: r })),
    ];

    allJobs.sort((a, b) => {
      const tsA = a._source === 'sql' ? (a.row.started_at ?? '') : a.row.startedAt;
      const tsB = b._source === 'sql' ? (b.row.started_at ?? '') : b.row.startedAt;
      // Descending
      if (tsA < tsB) return 1;
      if (tsA > tsB) return -1;
      return 0;
    });

    const total = allJobs.length;
    const page = allJobs.slice(offset, offset + limit);

    const data = page.map(item =>
      item._source === 'sql' ? serializeJob(item.row) : serializeLedgerJob(item.row),
    );

    return reply.send({
      data,
      meta: { total, limit, offset, timestamp: nowIso() },
    });
  });

  // ── GET /api/v5/jobs/:jobId ───────────────────────────────────────────────

  app.get<{ Params: { jobId: string } }>('/api/v5/jobs/:jobId', async (req, reply) => {
    // SQL first
    const sqlJob = supervisor.getJob(req.params.jobId);
    if (sqlJob) {
      return reply.send({ data: serializeJob(sqlJob), meta: { timestamp: nowIso() } });
    }

    // Ledger fallback
    const ledgerJob = findLedgerJobById(cyclesBase, req.params.jobId);
    if (ledgerJob) {
      return reply.send({ data: serializeLedgerJob(ledgerJob), meta: { timestamp: nowIso() } });
    }

    return reply.status(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
  });

  // ── GET /api/v5/jobs/:jobId/events ────────────────────────────────────────

  app.get<{ Params: { jobId: string } }>('/api/v5/jobs/:jobId/events', async (req, reply) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      afterSequence?: string;
      type?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '100', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);

    // SQL path: real event rows
    const sqlJob = supervisor.getJob(req.params.jobId);
    if (sqlJob) {
      const afterSequence = q.afterSequence !== undefined ? parseInt(q.afterSequence, 10) : undefined;
      const eventFilters = {
        jobId: sqlJob.id,
        limit,
        offset,
        ...(q.type !== undefined ? { type: q.type } : {}),
      };
      const events = supervisor.listEvents(
        Number.isFinite(afterSequence)
          ? { ...eventFilters, afterSequence: afterSequence as number }
          : eventFilters,
      );
      return reply.send({
        data: events.map(serializeEvent),
        meta: { total: events.length, limit, offset, timestamp: nowIso() },
      });
    }

    // Ledger path: synthesize events from the attempts count
    const ledgerJob = findLedgerJobById(cyclesBase, req.params.jobId);
    if (!ledgerJob) {
      return reply.status(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }

    const syntheticEvents = buildSyntheticEvents(ledgerJob);
    const filtered = q.type !== undefined
      ? syntheticEvents.filter(e => e.type === q.type)
      : syntheticEvents;
    const page = filtered.slice(offset, offset + limit);

    return reply.send({
      data: page,
      meta: { total: filtered.length, limit, offset, timestamp: nowIso() },
    });
  });

  // ── POST /api/v5/jobs/:jobId/cancel ───────────────────────────────────────

  app.post<{ Params: { jobId: string } }>('/api/v5/jobs/:jobId/cancel', async (req, reply) => {
    const job = supervisor.cancelJob(req.params.jobId);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    return reply.send({ data: serializeJob(job), meta: { timestamp: nowIso() } });
  });
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function serializeJob(job: RuntimeJobRow): Record<string, unknown> {
  return {
    jobId: job.id,
    sessionId: job.session_id,
    traceId: job.trace_id,
    agentId: job.agent_id,
    task: job.task,
    status: job.status,
    model: job.model,
    runtimeMode: job.runtime_mode,
    providerKind: job.provider_kind,
    inputTokens: job.input_tokens,
    outputTokens: job.output_tokens,
    costUsd: job.cost_usd,
    error: job.error,
    result: parseJson(job.result_json),
    cancelRequested: Boolean(job.cancel_requested),
    startedAt: job.started_at,
    completedAt: job.completed_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

export function serializeLedgerJob(job: LedgerJobRow): Record<string, unknown> {
  return {
    jobId: job.id,
    sessionId: null,
    traceId: null,
    agentId: job.agentId,
    task: job.id,  // itemId used as task identifier
    status: job.status,
    model: null,
    runtimeMode: null,
    providerKind: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: job.costUsd,
    error: null,
    result: { response: job.response },
    cancelRequested: false,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.startedAt,
    updatedAt: job.completedAt,
    // Extra ledger-specific fields
    cycleId: job.cycleId,
    attempts: job.attempts,
    source: 'ledger',
  };
}

export function serializeEvent(event: RuntimeEventRow): Record<string, unknown> {
  const payload = parseJson(event.data_json);
  return {
    id: event.id,
    sequence: event.sequence,
    jobId: event.job_id,
    sessionId: event.session_id,
    traceId: event.trace_id,
    agentId: event.agent_id,
    type: event.type,
    category: event.category,
    message: event.message,
    payload,
    data: payload,
    timestamp: event.created_at,
  };
}

// ---------------------------------------------------------------------------
// Synthetic events for ledger-sourced jobs
// ---------------------------------------------------------------------------

/**
 * Derive a minimal event stream from a LedgerJobRow.
 *
 * One `job_started` event at startedAt, then one `attempt` event per attempt,
 * then one `job_completed` or `job_failed` event at completedAt.
 */
function buildSyntheticEvents(job: LedgerJobRow): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  events.push({
    id: `${job.id}-started`,
    sequence: 1,
    jobId: job.id,
    sessionId: null,
    traceId: null,
    agentId: job.agentId,
    type: 'job_started',
    category: 'lifecycle',
    message: `Job ${job.id} started`,
    payload: { cycleId: job.cycleId },
    data: { cycleId: job.cycleId },
    timestamp: job.startedAt,
    source: 'ledger',
  });

  // One synthetic event per attempt
  for (let i = 0; i < job.attempts; i++) {
    events.push({
      id: `${job.id}-attempt-${i + 1}`,
      sequence: i + 2,
      jobId: job.id,
      sessionId: null,
      traceId: null,
      agentId: job.agentId,
      type: 'attempt',
      category: 'execution',
      message: `Attempt ${i + 1} of ${job.attempts}`,
      payload: { attempt: i + 1, total: job.attempts },
      data: { attempt: i + 1, total: job.attempts },
      timestamp: job.startedAt,
      source: 'ledger',
    });
  }

  const finalType = job.status === 'failed' ? 'job_failed' : 'job_completed';
  events.push({
    id: `${job.id}-${finalType}`,
    sequence: job.attempts + 2,
    jobId: job.id,
    sessionId: null,
    traceId: null,
    agentId: job.agentId,
    type: finalType,
    category: 'lifecycle',
    message: `Job ${job.id} ${job.status}`,
    payload: { costUsd: job.costUsd, response: job.response },
    data: { costUsd: job.costUsd, response: job.response },
    timestamp: job.completedAt,
    source: 'ledger',
  });

  return events;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
