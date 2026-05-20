import type { ModelTier } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Output schema types (T3 — outputFormat plumbing)
// TODO: deduplicate once T1 lands these in @agentforge/shared
// ---------------------------------------------------------------------------

export type AgentOutputSchema = {
  name: string;
  description?: string;
  schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Defaults to true when omitted. */
  strict?: boolean;
};

export type RuntimeMode =
  | 'auto'
  | 'sdk'
  | 'cli'
  | 'anthropic-sdk'
  | 'claude-cli'
  | 'claude-code-compat'
  | 'codex-cli'
  | 'openai-sdk';

export type ExecutionProviderKind =
  | 'anthropic-sdk'
  | 'claude-code-compat'
  | 'codex-cli'
  | 'openai-sdk';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface ProviderModelProfile {
  modelId: string;
  effort?: string;
}

export type ProviderModelProfiles = Partial<Record<ExecutionProviderKind, ProviderModelProfile>>;
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
  providerModelProfiles?: ProviderModelProfiles;
  cwd?: string;
  codexSandbox?: CodexSandboxMode;
  /** Enable live web search in Codex CLI for runs that explicitly need current external context. */
  codexSearch?: boolean;
  /** Extra directories Codex may write to alongside the primary workspace. */
  codexAddDirs?: string[];
  /** Run Codex without persisting session rollout files. */
  codexEphemeral?: boolean;
  /** Codex config profile from CODEX_HOME/config.toml. */
  codexProfile?: string;
  /** Codex profile-v2 layer from CODEX_HOME/<name>.config.toml. */
  codexProfileV2?: string;
  /** Allow Codex CLI execution outside a Git repository. */
  codexSkipGitRepoCheck?: boolean;
  /** Resume a previous Codex exec session instead of starting a fresh one. */
  codexResumeSessionId?: string;
  /** Resume the most recent Codex exec session. Ignored when codexResumeSessionId is set. */
  codexResumeLast?: boolean;
  /** Optional structured output schema. SDK transport threads into outputFormat; CLI transport appends schema hint to system prompt. */
  outputSchema?: AgentOutputSchema;
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
  /**
   * Hint for prompt-cache TTL selection in the SDK transport.
   *
   * - `'forge'`  → stable agent system prompts baked during a forge run;
   *                uses `ttl: "1h"` on cache breakpoints.
   * - `'cycle'`  → per-cycle execution context; uses the Anthropic ephemeral
   *                default (5 min, TTL key omitted from the wire format).
   *
   * When omitted the transport treats the request as cycle-phase.
   */
  phaseHint?: 'forge' | 'cycle';
}

export interface ExecutionResult {
  providerKind: ExecutionProviderKind;
  response: string;
  model: string;
  effort?: string;
  usage: ExecutionUsage;
  costUsd: number;
  durationMs: number;
  remoteSessionId?: string;
  stopReason?: string;
  raw?: unknown;
  /** Present when the request carried an outputSchema. ok=true means response parsed and validated; ok=false includes a human-readable error. */
  schemaValidation?: { ok: boolean; error?: string };
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
  spanId?: string;
  parentSpanId?: string;
  traceparent?: string;
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
