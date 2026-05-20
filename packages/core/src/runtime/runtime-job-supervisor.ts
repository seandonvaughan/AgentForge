import type { RuntimeJobRow, WorkspaceAdapter } from '@agentforge/db';
import type { RunResult } from '../agent-runtime/types.js';
import { generateId, nowIso } from '@agentforge/shared';
import type { RuntimeEventEnvelope, RuntimeJobStatus, RuntimeMode } from './types.js';
import { getGlobalTraceCollector } from '../tracing/trace-collector.js';
import { TraceContext } from '../tracing/trace-context.js';
import type { Span } from '../tracing/span.js';

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

interface ActiveJobState {
  controller: AbortController;
  runSpan: Span;
}

export class RuntimeJobSupervisor {
  private readonly activeJobs = new Map<string, ActiveJobState>();

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

    const collector = getGlobalTraceCollector();
    const controller = new AbortController();
    const runSpan = collector.startRootSpanWithTraceId(started.trace_id, {
      name: 'runtime.job.run',
      kind: 'server',
      attributes: {
        'service.name': 'agentforge.runtime',
        'runtime.job.id': started.id,
        'runtime.job.agent_id': started.agent_id,
        'runtime.job.session_id': started.session_id,
        'runtime.job.model': started.model ?? 'unknown',
        'runtime.job.runtime_mode': started.runtime_mode ?? 'unknown',
      },
    });
    this.activeJobs.set(jobId, { controller, runSpan });

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
        runSpan.setStatus('error', 'Run cancelled');
        this.markCancelled(latest, 'Run cancelled');
        return result;
      }

      if (result.status === 'failed') {
        runSpan.setAttributes({
          'runtime.job.cost_usd': result.costUsd,
          'runtime.job.input_tokens': result.inputTokens,
          'runtime.job.output_tokens': result.outputTokens,
        });
        runSpan.setStatus('error', result.error ?? 'Run failed');
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

      runSpan.setAttributes({
        'runtime.job.cost_usd': result.costUsd,
        'runtime.job.input_tokens': result.inputTokens,
        'runtime.job.output_tokens': result.outputTokens,
      });
      runSpan.setStatus('ok');
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
        runSpan.setStatus('error', errorMessage(error));
        this.markCancelled(latest ?? started, errorMessage(error));
        return undefined;
      }

      if (error instanceof Error) {
        runSpan.recordException(error);
      } else {
        runSpan.setStatus('error', errorMessage(error));
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
      collector.endSpan(runSpan);
      this.activeJobs.delete(jobId);
    }
  }

  cancelJob(jobId: string): RuntimeJobRow | undefined {
    const current = this.options.adapter.getRuntimeJob(jobId);
    if (!current) return undefined;
    if (isTerminalStatus(current.status)) return current;

    this.options.adapter.requestRuntimeJobCancel(jobId);
    this.activeJobs.get(jobId)?.controller.abort();
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
        ...(result.effort ? { effort: result.effort } : {}),
        ...(result.capabilityTier ? { capabilityTier: result.capabilityTier } : {}),
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
    const collector = getGlobalTraceCollector();
    const eventSpan = this.createEventSpan(job, input);
    const context = eventSpan.context();
    const timestamp = nowIso();
    try {
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
          ...(input.data ?? {}),
          workspaceId: this.options.adapter.workspaceId,
          traceId: job.trace_id,
          spanId: eventSpan.spanId,
          ...(eventSpan.parentSpanId ? { parentSpanId: eventSpan.parentSpanId } : {}),
          traceparent: context.toHeader(),
          jobId: job.id,
          sessionId: job.session_id,
          agentId: job.agent_id,
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
        ...(typeof payload.spanId === 'string' ? { spanId: payload.spanId } : {}),
        ...(typeof payload.parentSpanId === 'string' ? { parentSpanId: payload.parentSpanId } : {}),
        ...(typeof payload.traceparent === 'string' ? { traceparent: payload.traceparent } : {}),
        agentId: row.agent_id,
        type: row.type,
        category: row.category,
        message: row.message,
        payload,
        data: payload,
        timestamp: row.created_at,
      };

      this.options.onEvent?.(envelope);
      eventSpan.setStatus('ok');
      return envelope;
    } catch (error) {
      if (error instanceof Error) eventSpan.recordException(error);
      else eventSpan.setStatus('error', String(error));
      throw error;
    } finally {
      collector.endSpan(eventSpan);
    }
  }

  private createEventSpan(job: RuntimeJobRow, input: RuntimeEventInput): Span {
    const active = this.activeJobs.get(job.id);
    const parentContext = active
      ? active.runSpan.context().toSpanContext()
      : new TraceContext(job.trace_id, `job-${job.id}`, true).toSpanContext();

    const span = getGlobalTraceCollector().startSpan({
      name: `runtime.event.${input.type}`,
      kind: 'internal',
      parentContext,
      attributes: {
        'service.name': 'agentforge.runtime',
        'runtime.job.id': job.id,
        'runtime.job.agent_id': job.agent_id,
        'runtime.event.type': input.type,
        'runtime.event.category': input.category ?? 'run',
      },
    });

    if (input.data) {
      const keys = Object.keys(input.data);
      span.setAttributes({
        'runtime.event.data_key_count': keys.length,
        'runtime.event.data_keys': keys.slice(0, 20).join(','),
      });
    }

    return span;
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
