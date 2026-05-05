import type { WorkspaceAdapter } from '@agentforge/db';
import type { AgentRuntimeConfig, RunOptions, RunResult } from '../agent-runtime/types.js';
import { MODEL_IDS } from '../agent-runtime/types.js';
import { ProviderResolver } from './provider-resolver.js';
import { RuntimeSession } from './runtime-session.js';
import { AnthropicSdkTransport } from './transports/anthropic-sdk-transport.js';
import { ClaudeCodeCompatTransport } from './transports/claude-code-compat-transport.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from './types.js';

export interface ExecutionServiceOptions {
  transports?: ExecutionTransport[];
}

export class ExecutionService {
  private readonly resolver: ProviderResolver;

  constructor(options: ExecutionServiceOptions = {}) {
    const transports = options.transports ?? [
      new AnthropicSdkTransport(),
      new ClaudeCodeCompatTransport(),
    ];
    this.resolver = new ProviderResolver(transports);
  }

  async run(
    config: AgentRuntimeConfig,
    opts: RunOptions,
    adapter?: WorkspaceAdapter,
    apiKey?: string,
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const modelId = MODEL_IDS[config.model];
    const request = this.buildRequest(config, opts, modelId, apiKey);
    const session = new RuntimeSession({
      agentId: config.agentId,
      task: opts.task,
      model: modelId,
      startedAt,
      ...(adapter ? { adapter } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    });

    session.start();
    const requestedMode = opts.runtimeMode ?? config.runtimeMode ?? 'auto';

    try {
      const { transport, runtimeModeResolved } = await this.resolver.resolve(requestedMode, request);
      try {
        const execution = await transport.execute(request);
        return session.completeSuccess(execution, runtimeModeResolved);
      } catch (error) {
        return session.completeFailure(modelId, runtimeModeResolved, error, transport.kind);
      }
    } catch (error) {
      return session.completeFailure(modelId, requestedMode, error);
    }
  }

  async runStreaming(
    config: AgentRuntimeConfig,
    opts: RunOptions & ExecutionStreamOptions,
    adapter?: WorkspaceAdapter,
    apiKey?: string,
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const modelId = MODEL_IDS[config.model];
    const request = this.buildRequest(config, opts, modelId, apiKey);
    const session = new RuntimeSession({
      agentId: config.agentId,
      task: opts.task,
      model: modelId,
      startedAt,
      ...(adapter ? { adapter } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    });

    session.start();
    const requestedMode = opts.runtimeMode ?? config.runtimeMode ?? 'auto';

    try {
      const { transport, runtimeModeResolved } = await this.resolver.resolve(requestedMode, request);
      try {
        const execution = await this.executeWithStreamingFallback(transport, request, opts);
        const result = session.completeSuccess(execution, runtimeModeResolved);
        this.emitEvent(opts, { type: 'done', data: result });
        return result;
      } catch (error) {
        this.emitError(opts, error, transport.kind);
        const result = session.completeFailure(modelId, runtimeModeResolved, error, transport.kind);
        this.emitEvent(opts, { type: 'done', data: result });
        return result;
      }
    } catch (error) {
      this.emitError(opts, error);
      const result = session.completeFailure(modelId, requestedMode, error);
      this.emitEvent(opts, { type: 'done', data: result });
      return result;
    }
  }

  private async executeWithStreamingFallback(
    transport: ExecutionTransport,
    request: ExecutionRequest,
    opts: ExecutionStreamOptions,
  ): Promise<ExecutionResult> {
    if (!transport.executeStreaming) {
      const execution = await transport.execute(request);
      if (execution.response) {
        this.emitChunk(opts, execution.response, 0);
      }
      return execution;
    }

    let emittedChunks = 0;
    const streamOptions: ExecutionStreamOptions = {
      ...opts,
      onChunk: (text, index) => {
        emittedChunks += 1;
        opts.onChunk?.(text, index);
      },
      onEvent: (event) => {
        if (event.type === 'text_delta' || event.type === 'chunk') emittedChunks += 1;
        opts.onEvent?.(event);
      },
    };

    const execution = await transport.executeStreaming(request, streamOptions);
    if (emittedChunks === 0 && execution.response) {
      this.emitChunk(opts, execution.response, 0);
    }
    return execution;
  }

  private emitChunk(opts: ExecutionStreamOptions, text: string, index: number): void {
    opts.onChunk?.(text, index);
    this.emitEvent(opts, {
      type: 'text_delta',
      data: { text, content: text, index },
    });
  }

  private emitError(
    opts: ExecutionStreamOptions,
    error: unknown,
    providerKind?: ExecutionTransport['kind'],
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emitEvent(opts, {
      type: 'error',
      data: {
        error: message,
        ...(providerKind ? { providerKind } : {}),
      },
    });
  }

  private emitEvent(opts: ExecutionStreamOptions, event: ExecutionStreamEvent): void {
    opts.onEvent?.(event);
  }

  private buildRequest(
    config: AgentRuntimeConfig,
    opts: RunOptions,
    modelId: string,
    apiKey?: string,
  ): ExecutionRequest {
    const userContent = opts.context
      ? `<context>\n${opts.context}\n</context>\n\n${opts.task}`
      : opts.task;

    return {
      agent: {
        agentId: config.agentId,
        name: config.name,
        model: config.model,
        systemPrompt: config.systemPrompt,
        workspaceId: config.workspaceId,
      },
      task: opts.task,
      userContent,
      modelId,
      maxTokens: config.maxTokens ?? 8096,
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }
}
