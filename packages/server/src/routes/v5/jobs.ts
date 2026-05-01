import type { FastifyInstance } from 'fastify';
import type { RuntimeEventRow, RuntimeJobRow, WorkspaceAdapter } from '@agentforge/db';
import { RuntimeJobSupervisor } from '@agentforge/core';
import { nowIso } from '@agentforge/shared';

export async function jobsRoutes(
  app: FastifyInstance,
  opts: { adapter: WorkspaceAdapter; supervisor?: RuntimeJobSupervisor },
): Promise<void> {
  const supervisor = opts.supervisor ?? new RuntimeJobSupervisor({ adapter: opts.adapter });

  app.get('/api/v5/jobs', async (req, reply) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      agentId?: string;
      status?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);
    const filters = {
      limit,
      offset,
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    };

    const jobs = supervisor.listJobs(filters);
    const total = supervisor.countJobs({
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });

    return reply.send({
      data: jobs.map(serializeJob),
      meta: { total, limit, offset, timestamp: nowIso() },
    });
  });

  app.get<{ Params: { jobId: string } }>('/api/v5/jobs/:jobId', async (req, reply) => {
    const job = supervisor.getJob(req.params.jobId);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    return reply.send({ data: serializeJob(job), meta: { timestamp: nowIso() } });
  });

  app.get<{ Params: { jobId: string } }>('/api/v5/jobs/:jobId/events', async (req, reply) => {
    const job = supervisor.getJob(req.params.jobId);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }

    const q = req.query as {
      limit?: string;
      offset?: string;
      afterSequence?: string;
      type?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '100', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);
    const afterSequence = q.afterSequence !== undefined ? parseInt(q.afterSequence, 10) : undefined;

    const eventFilters = {
      jobId: job.id,
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
  });

  app.post<{ Params: { jobId: string } }>('/api/v5/jobs/:jobId/cancel', async (req, reply) => {
    const job = supervisor.cancelJob(req.params.jobId);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    return reply.send({ data: serializeJob(job), meta: { timestamp: nowIso() } });
  });
}

export function serializeJob(job: RuntimeJobRow): Record<string, unknown> {
  return {
    jobId: job.id,
    sessionId: job.session_id,
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

export function serializeEvent(event: RuntimeEventRow): Record<string, unknown> {
  return {
    id: event.id,
    sequence: event.sequence,
    jobId: event.job_id,
    sessionId: event.session_id,
    agentId: event.agent_id,
    type: event.type,
    category: event.category,
    message: event.message,
    data: parseJson(event.data_json),
    timestamp: event.created_at,
  };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
