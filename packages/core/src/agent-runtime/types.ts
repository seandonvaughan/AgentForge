import type { ModelTier } from '@agentforge/shared';
import type { AgentOutputSchema, CodexSandboxMode, ExecutionProviderKind, RuntimeMode } from '../runtime/types.js';

export interface AgentRuntimeConfig {
  agentId: string;
  name: string;
  model: ModelTier;
  systemPrompt: string;
  workspaceId: string;
  maxTokens?: number;       // default 8096
  temperature?: number;     // default 1.0 (Claude default)
  runtimeMode?: RuntimeMode;
  /** Reasoning effort level — passed as --effort to the claude subprocess. */
  effort?: string;
  outputSchema?: AgentOutputSchema;
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
  cwd?: string;
  outputSchema?: AgentOutputSchema;
  codexSandbox?: CodexSandboxMode;
  enableFallback?: boolean;
  /**
   * Per-request CLI subprocess timeout in milliseconds.
   * Overrides the transport default of 20 minutes (1_200_000 ms).
   * Use for heavy reasoning tasks such as scoring large backlogs or deep
   * architectural decisions that are known to exceed the default ceiling.
   */
  timeoutMs?: number;
}

export interface RunResult {
  sessionId: string;
  response: string;
  model: string;
  /** Internal AgentForge capability tier used for routing and cost semantics. */
  capabilityTier?: ModelTier;
  /** Provider reasoning effort used for the run, when supported. */
  effort?: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-creation tokens surfaced by the transport (Anthropic prompt-caching). */
  cacheCreationInputTokens?: number;
  /** Cache-read tokens surfaced by the transport (Anthropic prompt-caching). */
  cacheReadInputTokens?: number;
  costUsd: number;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed';
  providerKind?: ExecutionProviderKind;
  runtimeModeResolved?: RuntimeMode;
  /** Present when the transport validated a requested structured output schema. */
  schemaValidation?: { ok: boolean; error?: string };
  error?: string;
}

// Model pricing per 1M tokens (input / output)
export const MODEL_PRICING: Record<ModelTier, { input: number; output: number }> = {
  opus:   { input: 15.00, output: 75.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 0.80,  output: 4.00  },
};

export const MODEL_IDS: Record<ModelTier, string> = {
  opus:   'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
};
