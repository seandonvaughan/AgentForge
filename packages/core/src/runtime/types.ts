import type { ModelTier } from '@agentforge/shared';

export type RuntimeMode = 'auto' | 'sdk' | 'claude-code-compat';
export type ExecutionProviderKind = 'anthropic-sdk' | 'claude-code-compat';
export type RuntimeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ExecutionAgentConfig {
  agentId: string;
  name: string;
  model: ModelTier;
  systemPrompt: string;
  workspaceId: string;
}

export interface ExecutionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ExecutionRequest {
  agent: ExecutionAgentConfig;
  task: string;
  userContent: string;
  modelId: string;
  parentSessionId?: string;
  allowedTools?: string[];
  maxTokens?: number;
  temperature?: number;
  budgetUsd?: number;
  apiKey?: string;
  /** Reasoning effort level passed as --effort to the claude subprocess. */
  effort?: string;
  /**
   * When true, pass --fallback-model to the claude CLI subprocess.
   * Ladder: opus → claude-sonnet-4-6, sonnet → claude-haiku-4-5-20251001.
   * Defaults to true when not explicitly set to false.
   */
  enableFallback?: boolean;
  /**
   * Per-request CLI subprocess timeout in milliseconds.
   * Overrides the transport default of 20 minutes (1_200_000 ms).
   * Use for heavy reasoning tasks (e.g. scoring large backlogs, deep
   * architectural decisions) that are known to exceed the default ceiling.
   */
  timeoutMs?: number;
}

export interface ExecutionResult {
  providerKind: ExecutionProviderKind;
  response: string;
  model: string;
  usage: ExecutionUsage;
  costUsd: number;
  durationMs: number;
  remoteSessionId?: string;
  stopReason?: string;
  raw?: unknown;
}

export interface ExecutionStreamEvent {
  type:
    | 'start'
    | 'metadata'
    | 'text_delta'
    | 'usage_delta'
    | 'done'
    | 'error'
    | (string & {});
  data: unknown;
}

export interface ExecutionStreamOptions {
  onChunk?: (text: string, index: number) => void;
  onEvent?: (event: ExecutionStreamEvent) => void;
  signal?: AbortSignal;
}

export type ExecutionEvent = ExecutionStreamEvent;

export interface RuntimeEventEnvelope {
  id: string;
  workspaceId: string;
  jobId: string;
  sessionId: string;
  traceId: string;
  agentId: string;
  type: string;
  category: string;
  message: string;
  payload: Record<string, unknown>;
  /** @deprecated Use payload. Kept for dashboard/SSE compatibility through 10.5.x. */
  data?: Record<string, unknown>;
  timestamp: string;
  sequence?: number;
}

export interface ExecutionTransport {
  readonly kind: ExecutionProviderKind;
  isAvailable(request: ExecutionRequest): Promise<boolean> | boolean;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  executeStreaming?(
    request: ExecutionRequest,
    options?: ExecutionStreamOptions,
  ): Promise<ExecutionResult>;
}
