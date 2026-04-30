import type { ModelTier } from '@agentforge/shared';

export type RuntimeMode = 'auto' | 'sdk' | 'claude-code-compat';
export type ExecutionProviderKind = 'anthropic-sdk' | 'claude-code-compat';

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

export interface ExecutionTransport {
  readonly kind: ExecutionProviderKind;
  isAvailable(request: ExecutionRequest): Promise<boolean> | boolean;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  executeStreaming?(
    request: ExecutionRequest,
    options?: ExecutionStreamOptions,
  ): Promise<ExecutionResult>;
}
