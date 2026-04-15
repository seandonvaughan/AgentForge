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

export interface ExecutionEvent {
  type: 'chunk' | 'done' | 'error';
  data: unknown;
}

export interface ExecutionTransport {
  readonly kind: ExecutionProviderKind;
  isAvailable(request: ExecutionRequest): Promise<boolean> | boolean;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
