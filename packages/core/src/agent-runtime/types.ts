import type { ModelTier } from '@agentforge/shared';
import type { AgentOutputSchema, CodexSandboxMode, ExecutionProviderKind, RuntimeMode } from '../runtime/types.js';
import type { ResolvedAgentSkill } from './skill-resolver.js';

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
  /** Canonical skill ids requested for this agent after legacy mapping, if any. */
  skillIds?: string[];
  /** Catalog metadata for requested skill ids that resolved successfully. */
  resolvedSkills?: ResolvedAgentSkill[];
  /** Canonical skill ids requested by the agent but absent from the catalog. */
  missingSkillIds?: string[];
  /** Union of required tools declared by resolved skills. */
  requiredTools?: string[];
}

export interface RunOptions {
  task: string;
  sessionId?: string;
  parentSessionId?: string;
  context?: string;          // additional context injected before user message
  budgetUsd?: number;        // hard stop if cost would exceed this
  runtimeMode?: RuntimeMode;
  /** Optional provider-neutral tool/capability hints for CLI runtimes. */
  allowedTools?: string[];
  cwd?: string;
  outputSchema?: AgentOutputSchema;
  codexSandbox?: CodexSandboxMode;
  codexSearch?: boolean;
  codexAddDirs?: string[];
  codexEphemeral?: boolean;
  codexProfile?: string;
  codexProfileV2?: string;
  codexSkipGitRepoCheck?: boolean;
  codexResumeSessionId?: string;
  codexResumeLast?: boolean;
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
