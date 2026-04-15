import type { ModelTier } from '@agentforge/shared';
import type { ExecutionProviderKind, RuntimeMode } from '../runtime/types.js';

export interface AgentRuntimeConfig {
  agentId: string;
  name: string;
  model: ModelTier;
  systemPrompt: string;
  workspaceId: string;
  maxTokens?: number;       // default 8096
  temperature?: number;     // default 1.0 (Claude default)
  runtimeMode?: RuntimeMode;
}

export interface RunOptions {
  task: string;
  sessionId?: string;
  parentSessionId?: string;
  context?: string;          // additional context injected before user message
  budgetUsd?: number;        // hard stop if cost would exceed this
  runtimeMode?: RuntimeMode;
  /**
   * Optional list of Claude Code tool names to enable on this run
   * (e.g. ['Read','Write','Edit','Bash','Glob','Grep']). When set, the
   * AgentRuntime appends `--allowed-tools <list>` to the `claude -p`
   * subprocess args. Omit to leave the CLI's default behavior in place
   * (no tools enabled for non-interactive `claude -p`).
   */
  allowedTools?: string[];
}

export interface RunResult {
  sessionId: string;
  response: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed';
  providerKind?: ExecutionProviderKind;
  runtimeModeResolved?: RuntimeMode;
  error?: string;
}

// Model pricing per 1M tokens (input / output)
export const MODEL_PRICING: Record<ModelTier, { input: number; output: number }> = {
  opus:   { input: 15.00, output: 75.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 0.80,  output: 4.00  },
};

export const MODEL_IDS: Record<ModelTier, string> = {
  opus:   'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
};
