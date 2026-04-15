import type { WorkspaceAdapter } from '@agentforge/db';
import type { RunResult } from '../agent-runtime/types.js';
import type {
  ExecutionProviderKind,
  ExecutionResult,
  ExecutionUsage,
  RuntimeMode,
} from './types.js';

interface RuntimeSessionOptions {
  adapter?: WorkspaceAdapter;
  agentId: string;
  task: string;
  model: string;
  sessionId?: string;
  parentSessionId?: string;
  startedAt: string;
}

export class RuntimeSession {
  readonly startedAt: string;
  private sessionId?: string;

  constructor(private readonly options: RuntimeSessionOptions) {
    this.startedAt = options.startedAt;
    this.sessionId = options.sessionId;
  }

  start(): string | undefined {
    if (!this.options.adapter) return this.sessionId;

    const sessionRow = this.options.adapter.createSession({
      ...(this.sessionId ? { id: this.sessionId } : {}),
      agentId: this.options.agentId,
      task: this.options.task,
      model: this.options.model,
      ...(this.options.parentSessionId ? { parentSessionId: this.options.parentSessionId } : {}),
    });

    this.sessionId = sessionRow.id;
    return this.sessionId;
  }

  completeSuccess(
    execution: ExecutionResult,
    runtimeModeResolved: RuntimeMode,
  ): RunResult {
    const completedAt = new Date().toISOString();
    const inputTokens = this.sumInputTokens(execution.usage);
    const outputTokens = execution.usage.outputTokens ?? 0;
    const sessionId = this.sessionId ?? execution.remoteSessionId ?? '';

    if (this.options.adapter && sessionId) {
      this.options.adapter.completeSession(sessionId, 'completed', execution.costUsd, {
        model: execution.model,
        inputTokens,
        outputTokens,
      });
      this.options.adapter.recordCost({
        sessionId,
        agentId: this.options.agentId,
        model: execution.model,
        inputTokens,
        outputTokens,
        costUsd: execution.costUsd,
      });
      this.options.adapter.recordSessionOutcome(
        this.options.agentId,
        'completed',
        execution.costUsd,
        execution.durationMs,
      );
      this.options.adapter.recordDecisionEvent({
        sessionId,
        agentId: this.options.agentId,
        decisionType: 'runtime_transport',
        summary: `Selected ${execution.providerKind} transport`,
        rationale: `Runtime mode resolved to ${runtimeModeResolved}`,
        payload: {
          providerKind: execution.providerKind,
          runtimeModeResolved,
          model: execution.model,
        },
      });
      this.options.adapter.recordTaskOutcome({
        sessionId,
        agentId: this.options.agentId,
        task: this.options.task,
        outcome: 'success',
        qualityScore: 1,
        model: execution.model,
        durationMs: execution.durationMs,
        summary: execution.response.slice(0, 500),
        payload: {
          providerKind: execution.providerKind,
          runtimeModeResolved,
          usage: execution.usage,
        },
      });
    }

    return {
      sessionId,
      response: execution.response,
      model: execution.model,
      inputTokens,
      outputTokens,
      costUsd: execution.costUsd,
      startedAt: this.startedAt,
      completedAt,
      status: 'completed',
      providerKind: execution.providerKind,
      runtimeModeResolved,
    };
  }

  completeFailure(
    model: string,
    runtimeModeResolved: RuntimeMode,
    error: unknown,
    providerKind?: ExecutionProviderKind,
  ): RunResult {
    const completedAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (this.options.adapter && this.sessionId) {
      this.options.adapter.completeSession(this.sessionId, 'failed', 0);
      this.options.adapter.recordSessionOutcome(
        this.options.agentId,
        'failed',
        0,
        Date.parse(completedAt) - Date.parse(this.startedAt),
      );
      this.options.adapter.recordDecisionEvent({
        sessionId: this.sessionId,
        agentId: this.options.agentId,
        decisionType: 'runtime_transport',
        summary: `Runtime failed in ${providerKind ?? 'unknown'} transport`,
        rationale: `Runtime mode resolved to ${runtimeModeResolved}`,
        payload: {
          providerKind: providerKind ?? null,
          runtimeModeResolved,
          model,
          error: errorMessage,
        },
      });
      this.options.adapter.recordTaskOutcome({
        sessionId: this.sessionId,
        agentId: this.options.agentId,
        task: this.options.task,
        outcome: 'failure',
        success: false,
        model,
        durationMs: Date.parse(completedAt) - Date.parse(this.startedAt),
        summary: errorMessage.slice(0, 500),
        payload: {
          providerKind: providerKind ?? null,
          runtimeModeResolved,
          error: errorMessage,
        },
      });
    }

    return {
      sessionId: this.sessionId ?? '',
      response: '',
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: this.startedAt,
      completedAt,
      status: 'failed',
      error: errorMessage,
      providerKind,
      runtimeModeResolved,
    };
  }

  private sumInputTokens(usage: ExecutionUsage): number {
    return (
      (usage.inputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0)
    );
  }
}
