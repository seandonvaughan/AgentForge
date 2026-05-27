// packages/core/src/autonomous/runtime-adapter.ts
//
// v6.4.1: Bridges AgentRuntime (RunOptions/RunResult shape, one runtime per
// agent) to ScoringPipeline's RuntimeForScoring interface (one service,
// agentId as parameter, narrower result shape).
//
// The adapter lazily constructs AgentRuntime instances on first use of each
// agentId, caching them for subsequent calls within a single cycle. Agent
// configs are loaded from .agentforge/agents/{id}.yaml via the existing
// loadAgentConfig helper.
//
// This lives in the autonomous module (not agent-runtime) because it's
// specifically the bridge between v6.4's autonomous loop and the underlying
// AgentRuntime. Other callers (dashboard, CLI routes) use AgentRuntime
// directly and don't need this adapter.

import { join } from 'node:path';
import { AgentRuntime, loadAgentConfig } from '../agent-runtime/index.js';
import type { AgentRuntimeConfig, RunResult } from '../agent-runtime/types.js';
import type { WorkspaceAdapter } from '@agentforge/db';
import type { RuntimeForScoring } from './scoring-pipeline.js';
import type { ModelTier } from '@agentforge/shared';
import type { RuntimeJobSupervisor } from '../runtime/runtime-job-supervisor.js';
import type {
  CodexSandboxMode,
  ExecutionProviderKind,
  ExecutionStreamEvent,
  RuntimeMode,
} from '../runtime/types.js';
import {
  extractBreakdownFromAgentRun,
  type CostBreakdown,
} from './cost-breakdown.js';

const TIER_RANK: Record<ModelTier, number> = { opus: 2, sonnet: 1, haiku: 0 };

interface RuntimeRunOptions {
  responseFormat?: string;
  allowedTools?: string[];
  timeoutMs?: number;
  cwd?: string;
  codexSandbox?: CodexSandboxMode;
  runtimeMode?: RuntimeMode;
  preferredProvider?: ExecutionProviderKind;
}

function capModelTier(requested: ModelTier, cap: ModelTier): { model: ModelTier; effort?: string } {
  const downgraded = TIER_RANK[requested] > TIER_RANK[cap];
  return downgraded
    ? { model: cap, effort: 'max' }
    : { model: requested };
}

/**
 * xhigh effort is only supported on Opus. For Sonnet/Haiku, max is the
 * highest available level — coerce xhigh down to max for non-Opus tiers.
 */
function resolveEffort(requestedEffort: string | undefined, model: ModelTier): string | undefined {
  if (!requestedEffort) return undefined;
  if (requestedEffort === 'xhigh' && model !== 'opus') return 'max';
  return requestedEffort;
}

export class RuntimeAdapterError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RuntimeAdapterError';
  }
}

export interface RuntimeAdapterOptions {
  /** Project root (the directory containing .agentforge/). */
  cwd: string;
  /** Optional workspace adapter for session/cost persistence. */
  workspaceAdapter?: WorkspaceAdapter;
  /**
   * Optional supervisor for durable job tracking.
   *
   * When provided, every `run()` call creates a `runtime_jobs` row and emits
   * `runtime_events` so the /jobs dashboard page shows live data that persists
   * across server restarts. Without this the autonomous cycle leaves
   * runtime_jobs and runtime_events empty (the observability gap described in
   * the v15.0.0 sprint item).
   */
  supervisor?: RuntimeJobSupervisor;
  /**
   * Inline agent configs keyed by agentId. If provided, these take precedence
   * over loading from disk. Useful for tests and for injecting synthesized
   * agent configs that don't have a .yaml file yet.
   */
  inlineAgents?: Record<string, AgentRuntimeConfig>;
  /**
   * When set, any agent assigned a tier above this value is downgraded to it.
   * Agents at or below the cap are unaffected. Enables Opus-outage fallback
   * and cost-reduced runs without touching individual agent YAML files.
   */
  modelCap?: ModelTier;
  /**
   * When set, every agent in the cycle runs at this effort level regardless
   * of its YAML configuration. Overrides any per-agent effort setting.
   */
  effortCap?: string;
  /**
   * When true (default), pass --fallback-model to the claude CLI subprocess.
   * Ladder: opus → sonnet, sonnet → haiku.
   * Propagated to RunOptions so each agent invocation emits the flag.
   */
  enableFallback?: boolean;
}

/**
 * Adapts AgentRuntime to the RuntimeForScoring interface expected by
 * ScoringPipeline. Also usable anywhere a "runtime service" (keyed by
 * agentId) is needed instead of a single-agent runtime.
 */
export class RuntimeAdapter implements RuntimeForScoring {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly agentforgeDir: string;

  constructor(private readonly options: RuntimeAdapterOptions) {
    this.agentforgeDir = join(options.cwd, '.agentforge');
  }

  /**
   * Run an agent with the given task.
   * @param agentId The agent ID to run.
   * @param task The task prompt.
   * @param options Optional configuration:
   *   - allowedTools: List of Claude Code tool names to enable.
   *   - timeoutMs: Per-request CLI subprocess timeout in milliseconds. Overrides
   *     the transport default of 20 minutes (1_200_000 ms). Use for heavy
   *     reasoning tasks (e.g. gate phase, scoring large backlogs) that are known
   *     to exceed the default ceiling.
   *   - cwd: Working directory for the agent execution (used for worktree isolation).
   *   - responseFormat: Optional response format specification.
   */
  async run(
    agentId: string,
    task: string,
    options?: RuntimeRunOptions,
  ): Promise<{
    output: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    costUsd: number;
    durationMs: number;
    model: string;
    effort?: string;
    capabilityTier?: ModelTier;
    breakdown: CostBreakdown;
  }> {
    // When a supervisor is wired, every agent run creates a durable runtime_job
    // row + runtime_events so the /jobs page has persistent history across
    // server restarts. This closes the observability gap where the execute phase
    // left runtime_jobs / runtime_events empty (0 rows).
    if (this.options.supervisor) {
      return this._runWithSupervisor(agentId, task, options);
    }

    const runtime = await this.getOrCreateRuntime(agentId);
    const startedAt = Date.now();
    const runOpts: {
      task: string;
      allowedTools?: string[];
      enableFallback?: boolean;
      timeoutMs?: number;
      cwd?: string;
      codexSandbox?: CodexSandboxMode;
      runtimeMode?: RuntimeMode;
      preferredProvider?: ExecutionProviderKind;
    } = { task };
    if (options?.allowedTools) runOpts.allowedTools = options.allowedTools;
    if (options?.timeoutMs !== undefined) runOpts.timeoutMs = options.timeoutMs;
    if (options?.cwd !== undefined) runOpts.cwd = options.cwd;
    if (options?.codexSandbox !== undefined) runOpts.codexSandbox = options.codexSandbox;
    if (options?.runtimeMode !== undefined) runOpts.runtimeMode = options.runtimeMode;
    if (options?.preferredProvider !== undefined) runOpts.preferredProvider = options.preferredProvider;
    // Thread enableFallback from adapter options into each run call.
    if (this.options.enableFallback !== undefined) {
      runOpts.enableFallback = this.options.enableFallback;
    }
    const result: RunResult = await runtime.run(runOpts);
    const durationMs = Date.now() - startedAt;

    if (result.status === 'failed') {
      throw new RuntimeAdapterError(
        `Agent ${agentId} run failed: ${result.error ?? 'unknown error'}`,
      );
    }

    const usage = {
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      ...(result.cacheCreationInputTokens !== undefined
        ? { cache_creation_input_tokens: result.cacheCreationInputTokens }
        : {}),
      ...(result.cacheReadInputTokens !== undefined
        ? { cache_read_input_tokens: result.cacheReadInputTokens }
        : {}),
    };
    const breakdownRun = {
      model: result.model,
      usage,
      ...(result.capabilityTier ? { capabilityTier: result.capabilityTier } : {}),
    };
    const breakdown = extractBreakdownFromAgentRun(breakdownRun);
    return {
      output: result.response,
      usage,
      costUsd: result.costUsd,
      durationMs,
      model: result.model,
      ...(result.effort ? { effort: result.effort } : {}),
      ...(result.capabilityTier ? { capabilityTier: result.capabilityTier } : {}),
      breakdown,
    };
  }

  /**
   * Supervisor-wrapped run path. Creates a runtime_job row before starting,
   * then delegates to AgentRuntime.run() inside the supervisor's executor so
   * the job's status, tokens, cost, and events are all persisted to SQLite.
   */
  private async _runWithSupervisor(
    agentId: string,
    task: string,
    options?: RuntimeRunOptions,
  ): Promise<{
    output: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    costUsd: number;
    durationMs: number;
    model: string;
    effort?: string;
    capabilityTier?: ModelTier;
    breakdown: CostBreakdown;
  }> {
    const supervisor = this.options.supervisor!;
    const runtime = await this.getOrCreateRuntime(agentId);
    const jobStartedAt = Date.now();

    const job = supervisor.createJob({
      agentId,
      task,
      ...(options?.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    });

    const runResult = await supervisor.startJob(job.id, ({ signal, emit }) => {
      const runOpts: {
        task: string;
        allowedTools?: string[];
        enableFallback?: boolean;
        timeoutMs?: number;
        cwd?: string;
        codexSandbox?: CodexSandboxMode;
        runtimeMode?: RuntimeMode;
        preferredProvider?: ExecutionProviderKind;
        signal: AbortSignal;
        onEvent: (event: ExecutionStreamEvent) => void;
      } = {
        task,
        signal,
        onEvent: (event) => {
          emit({
            type: event.type,
            message: `[${agentId}] ${event.type}`,
            data: streamEventData(event),
          });
        },
      };
      if (options?.allowedTools) runOpts.allowedTools = options.allowedTools;
      if (options?.timeoutMs !== undefined) runOpts.timeoutMs = options.timeoutMs;
      if (options?.cwd !== undefined) runOpts.cwd = options.cwd;
      if (options?.codexSandbox !== undefined) runOpts.codexSandbox = options.codexSandbox;
      if (options?.runtimeMode !== undefined) runOpts.runtimeMode = options.runtimeMode;
      if (options?.preferredProvider !== undefined) runOpts.preferredProvider = options.preferredProvider;
      if (this.options.enableFallback !== undefined) {
        runOpts.enableFallback = this.options.enableFallback;
      }
      return runtime.runStreaming(runOpts);
    });

    if (!runResult) {
      const latestJob = supervisor.getJob(job.id);
      throw new RuntimeAdapterError(
        latestJob?.error ?? `Agent ${agentId} run did not complete`,
      );
    }
    if (runResult.status === 'failed') {
      throw new RuntimeAdapterError(
        runResult.error ?? `Agent ${agentId} run failed: unknown error`,
      );
    }

    const durationMs = Date.now() - jobStartedAt;
    const supervisorUsage = {
      input_tokens: runResult.inputTokens,
      output_tokens: runResult.outputTokens,
      ...(runResult.cacheCreationInputTokens !== undefined
        ? { cache_creation_input_tokens: runResult.cacheCreationInputTokens }
        : {}),
      ...(runResult.cacheReadInputTokens !== undefined
        ? { cache_read_input_tokens: runResult.cacheReadInputTokens }
        : {}),
    };
    const supervisorBreakdownRun = {
      model: runResult.model,
      usage: supervisorUsage,
      ...(runResult.capabilityTier ? { capabilityTier: runResult.capabilityTier } : {}),
    };
    const supervisorBreakdown = extractBreakdownFromAgentRun(supervisorBreakdownRun);
    return {
      output: runResult.response,
      usage: supervisorUsage,
      costUsd: runResult.costUsd,
      durationMs,
      model: runResult.model,
      ...(runResult.effort ? { effort: runResult.effort } : {}),
      ...(runResult.capabilityTier ? { capabilityTier: runResult.capabilityTier } : {}),
      breakdown: supervisorBreakdown,
    };
  }

  /**
   * Pre-warm the adapter by registering an inline agent config. Avoids a
   * disk lookup on first use of that agent.
   */
  registerInlineAgent(agentId: string, config: AgentRuntimeConfig): void {
    if (this.runtimes.has(agentId)) return;
    const effectiveConfig = this.applyCaps(config);
    const runtime = new AgentRuntime(effectiveConfig, this.options.workspaceAdapter);
    this.runtimes.set(agentId, runtime);
  }

  /**
   * Apply modelCap and effortCap to an agent config. modelCap-driven
   * downgrades force effort:'max'; effortCap (if set) overrides any explicit
   * effort. xhigh is coerced to max for non-Opus models because the CLI
   * only supports xhigh on Opus.
   */
  private applyCaps(config: AgentRuntimeConfig): AgentRuntimeConfig {
    let merged: AgentRuntimeConfig = config;
    if (this.options.modelCap) {
      merged = { ...merged, ...capModelTier(merged.model, this.options.modelCap) };
    }
    if (this.options.effortCap) {
      const effort = resolveEffort(this.options.effortCap, merged.model);
      if (effort) merged = { ...merged, effort };
    } else if (merged.effort) {
      // Honour per-agent effort but enforce the xhigh-Opus-only rule.
      const effort = resolveEffort(merged.effort, merged.model);
      if (effort && effort !== merged.effort) merged = { ...merged, effort };
    }
    return merged;
  }

  /** Clear the runtime cache. Useful between cycles if agent configs changed. */
  clearCache(): void {
    this.runtimes.clear();
  }

  private async getOrCreateRuntime(agentId: string): Promise<AgentRuntime> {
    const cached = this.runtimes.get(agentId);
    if (cached) return cached;

    // Check inline configs first. Apply caps so that modelCap/effortCap are
    // honoured even when configs come from the constructor inlineAgents map
    // (consistent with registerInlineAgent which also calls applyCaps).
    const inlineConfig = this.options.inlineAgents?.[agentId];
    if (inlineConfig) {
      const effectiveConfig = this.applyCaps(inlineConfig);
      const runtime = new AgentRuntime(effectiveConfig, this.options.workspaceAdapter);
      this.runtimes.set(agentId, runtime);
      return runtime;
    }

    // Load from .agentforge/agents/{agentId}.yaml. Pass the workspace adapter
    // so `injectFreshContext` can splice any pending DMs into the prompt —
    // see ADR 0001 + Phase 2 of the agent-comm spec.
    let config = await loadAgentConfig(agentId, this.agentforgeDir, {
      ...(this.options.workspaceAdapter ? { adapter: this.options.workspaceAdapter } : {}),
    });

    // Fallback resolution: the scoring agent invents agent names per cycle
    // ("CodeAgent", "feature-dev-agent", "DocsAgent", "general-purpose"...).
    // Rather than fail the entire execute phase, route unknown ids to a
    // sensible default based on simple keyword classification. This is the
    // difference between a cycle that can ship code and one that gates on
    // an empty diff because no agent ever ran.
    if (!config) {
      const lower = agentId.toLowerCase();

      // Alias map: common LLM-invented names → actual agent YAML IDs.
      // The scoring prompt constrains names, but LLMs sometimes improvise.
      const aliasMap: Record<string, string> = {
        frontendendgineer: 'frontend-dev',
        frontendengineer: 'frontend-dev',
        frontenddev: 'frontend-dev',
        frontenddeveloper: 'frontend-dev',
        uiengineer: 'ui-engineer',
        uideveloper: 'ui-engineer',
        backendarchitect: 'architect',
        backendengineer: 'coder',
        backenddeveloper: 'coder',
        softwareengineer: 'coder',
        fullstackengineer: 'coder',
        fullstackdeveloper: 'coder',
        qaengineer: 'backend-qa',
        qatester: 'backend-qa',
        testingengineer: 'test-runner',
        testengineer: 'test-runner',
        securityengineer: 'security-auditor',
        devopsengineer: 'devops-engineer',
        infraengineer: 'devops-engineer',
        databaseengineer: 'dba',
        apiengineer: 'api-specialist',
        docswriter: 'documentation-writer',
        technicalwriter: 'documentation-writer',
      };

      // Try alias (strip hyphens/underscores/spaces for fuzzy match)
      const normalized = lower.replace(/[-_\s]/g, '');
      let fallbackId = aliasMap[normalized];

      // Keyword classification as final fallback
      if (!fallbackId) {
        fallbackId = /doc|writer|tech-writer/.test(lower)
          ? 'documentation-writer'
          : /test|qa/.test(lower)
          ? 'backend-qa'
          : /review/.test(lower)
          ? 'code-reviewer'
          : /frontend|ui|svelte|css/.test(lower)
          ? 'frontend-dev'
          : /architect|design/.test(lower)
          ? 'architect'
          : /debug|fix/.test(lower)
          ? 'debugger'
          : /api|endpoint|route/.test(lower)
          ? 'api-specialist'
          : /database|db|sql/.test(lower)
          ? 'dba'
          : /devops|infra|ci|deploy/.test(lower)
          ? 'devops-engineer'
          : /security|vuln/.test(lower)
          ? 'security-auditor'
          : 'coder';
      }

      const fallback = await loadAgentConfig(fallbackId, this.agentforgeDir, {
        ...(this.options.workspaceAdapter ? { adapter: this.options.workspaceAdapter } : {}),
      });
      if (fallback) {
        // eslint-disable-next-line no-console
        console.warn(`[runtime-adapter] unknown agent "${agentId}" → falling back to "${fallbackId}"`);
        config = fallback;
      }
    }

    if (!config) {
      throw new RuntimeAdapterError(
        `Agent config not found: ${join(this.agentforgeDir, 'agents', agentId + '.yaml')}`,
      );
    }

    const effectiveConfig = this.applyCaps(config);
    const runtime = new AgentRuntime(effectiveConfig, this.options.workspaceAdapter);
    this.runtimes.set(agentId, runtime);
    return runtime;
  }
}

function streamEventData(event: ExecutionStreamEvent): Record<string, unknown> {
  if (typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)) {
    return event.data as Record<string, unknown>;
  }
  return { value: event.data };
}
