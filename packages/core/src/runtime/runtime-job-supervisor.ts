import type { RuntimeJobRow, WorkspaceAdapter } from '@agentforge/db';
import type { RunResult } from '../agent-runtime/types.js';
import { generateId, nowIso } from '@agentforge/shared';
import type { RuntimeEventEnvelope, RuntimeJobStatus, RuntimeMode } from './types.js';

export interface RuntimeJobSupervisorOptions {
  adapter: WorkspaceAdapter;
  onEvent?: (event: RuntimeEventEnvelope) => void;
}

export interface RuntimeJobExecutionContext {
  job: RuntimeJobRow;
  signal: AbortSignal;
  emit: (event: RuntimeEventInput) => RuntimeEventEnvelope;
}

export interface RuntimeEventInput {
  type: string;
  category?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface CreateRuntimeJobInput {
  agentId: string;
  task: string;
  sessionId?: string;
  traceId?: string;
  model?: string;
  runtimeMode?: RuntimeMode;
}

export type RuntimeJobExecutor = (context: RuntimeJobExecutionContext) => Promise<RunResult>;

export class RuntimeJobSupervisor {
  private readonly activeJobs = new Map<string, AbortController>();

  constructor(private readonly options: RuntimeJobSupervisorOptions) {}

  createJob(input: CreateRuntimeJobInput): RuntimeJobRow {
    const sessionId = input.sessionId ?? `run-${generateId()}`;
    const traceId = input.traceId ?? `trace-${sessionId}`;
    const job = this.options.adapter.createRuntimeJob({
      id: `job-${generateId()}`,
      sessionId,
      traceId,
      agentId: input.agentId,
      task: input.task,
      ...(input.model ? { model: input.model } : {}),
      ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
    });

    this.emit(job, {
      type: 'job_created',
      message: `[${input.agentId}] job created`,
      data: { status: job.status },
    });

    return job;
  }

  async startJob(jobId: string, executor: RuntimeJobExecutor): Promise<RunResult | undefined> {
    const started = this.options.adapter.startRuntimeJob(jobId);
    if (!started) return undefined;

    const controller = new AbortController();
    this.activeJobs.set(jobId, controller);

    this.emit(started, {
      type: 'job_started',
      message: `[${started.agent_id}] job started`,
      data: { status: 'running' },
    });

    try {
      const result = await executor({
        job: started,
        signal: controller.signal,
        emit: (event) => this.emit(started, event),
      });

      const latest = this.options.adapter.getRuntimeJob(jobId);
      if (latest?.status === 'cancelled' || latest?.cancel_requested) {
        this.markCancelled(latest, 'Run cancelled');
        return result;
      }

      if (result.status === 'failed') {
        const failed = this.options.adapter.completeRuntimeJob(jobId, {
          status: 'failed',
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          error: result.error ?? 'Run failed',
          result,
          completedAt: result.completedAt,
          ...(result.providerKind ? { providerKind: result.providerKind } : {}),
        });
        if (failed) this.emitJobTerminal(failed, result);
        return result;
      }

      const completed = this.options.adapter.completeRuntimeJob(jobId, {
        status: 'completed',
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        result,
        completedAt: result.completedAt,
        ...(result.providerKind ? { providerKind: result.providerKind } : {}),
      });
      if (completed) this.emitJobTerminal(completed, result);
      return result;
    } catch (error) {
      const latest = this.options.adapter.getRuntimeJob(jobId);
      if (latest?.status === 'cancelled' || latest?.cancel_requested || controller.signal.aborted) {
        this.markCancelled(latest ?? started, errorMessage(error));
        return undefined;
      }

      const failed = this.options.adapter.completeRuntimeJob(jobId, {
        status: 'failed',
        error: errorMessage(error),
        result: { error: errorMessage(error) },
      });
      if (failed) {
        this.emit(failed, {
          type: 'job_failed',
          message: `[${failed.agent_id}] job failed: ${errorMessage(error).slice(0, 200)}`,
          data: { status: 'failed', error: errorMessage(error) },
        });
      }
      return undefined;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  cancelJob(jobId: string): RuntimeJobRow | undefined {
    const current = this.options.adapter.getRuntimeJob(jobId);
    if (!current) return undefined;
    if (isTerminalStatus(current.status)) return current;

    this.options.adapter.requestRuntimeJobCancel(jobId);
    this.activeJobs.get(jobId)?.abort();
    const cancelled = this.options.adapter.cancelRuntimeJob(jobId, nowIso(), 'Cancellation requested');
    if (cancelled) {
      this.emit(cancelled, {
        type: 'job_cancelled',
        message: `[${cancelled.agent_id}] job cancelled`,
        data: { status: 'cancelled' },
      });
    }
    return cancelled;
  }

  getJob(jobId: string): RuntimeJobRow | undefined {
    return this.options.adapter.getRuntimeJob(jobId);
  }

  listJobs(filters: Parameters<WorkspaceAdapter['listRuntimeJobs']>[0] = {}): RuntimeJobRow[] {
    return this.options.adapter.listRuntimeJobs(filters);
  }

  countJobs(filters: Parameters<WorkspaceAdapter['countRuntimeJobs']>[0] = {}): number {
    return this.options.adapter.countRuntimeJobs(filters);
  }

  listEvents(filters: Parameters<WorkspaceAdapter['listRuntimeEvents']>[0] = {}) {
    return this.options.adapter.listRuntimeEvents(filters);
  }

  emitForJob(jobId: string, event: RuntimeEventInput): RuntimeEventEnvelope | undefined {
    const job = this.options.adapter.getRuntimeJob(jobId);
    if (!job) return undefined;
    return this.emit(job, event);
  }

  private markCancelled(job: RuntimeJobRow, error: string): void {
    if (job.status === 'cancelled') return;
    const cancelled = this.options.adapter.cancelRuntimeJob(job.id, nowIso(), error);
    if (cancelled) {
      this.emit(cancelled, {
        type: 'job_cancelled',
        message: `[${cancelled.agent_id}] job cancelled`,
        data: { status: 'cancelled', error },
      });
    }
  }

  private emitJobTerminal(job: RuntimeJobRow, result: RunResult): void {
    this.emit(job, {
      type: result.status === 'completed' ? 'job_completed' : 'job_failed',
      message: `[${job.agent_id}] job ${result.status}`,
      data: {
        status: result.status,
        model: result.model,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ...(result.providerKind ? { providerKind: result.providerKind } : {}),
        ...(result.runtimeModeResolved ? { runtimeModeResolved: result.runtimeModeResolved } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    });
  }

  private emit(job: RuntimeJobRow, input: RuntimeEventInput): RuntimeEventEnvelope {
    const timestamp = nowIso();
    const row = this.options.adapter.recordRuntimeEvent({
      id: generateId(),
      jobId: job.id,
      sessionId: job.session_id,
      traceId: job.trace_id,
      agentId: job.agent_id,
      type: input.type,
      category: input.category ?? 'run',
      message: input.message,
      data: {
        workspaceId: this.options.adapter.workspaceId,
        traceId: job.trace_id,
        jobId: job.id,
        sessionId: job.session_id,
        agentId: job.agent_id,
        ...(input.data ?? {}),
      },
      createdAt: timestamp,
    });

    const payload = parseEventData(row.data_json);
    const envelope: RuntimeEventEnvelope = {
      id: row.id,
      sequence: row.sequence,
      workspaceId: this.options.adapter.workspaceId,
      jobId: row.job_id,
      sessionId: row.session_id,
      traceId: row.trace_id,
      agentId: row.agent_id,
      type: row.type,
      category: row.category,
      message: row.message,
      payload,
      data: payload,
      timestamp: row.created_at,
    };

    this.options.onEvent?.(envelope);
    return envelope;
  }
}

function isTerminalStatus(status: RuntimeJobStatus | string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseEventData(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
