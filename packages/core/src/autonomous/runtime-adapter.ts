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

const TIER_RANK: Record<ModelTier, number> = { opus: 2, sonnet: 1, haiku: 0 };

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

  async run(
    agentId: string,
    task: string,
    options?: { responseFormat?: string; allowedTools?: string[] },
  ): Promise<{
    output: string;
    usage: { input_tokens: number; output_tokens: number };
    costUsd: number;
    durationMs: number;
    model: string;
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
    const runOpts: { task: string; allowedTools?: string[]; enableFallback?: boolean } = { task };
    if (options?.allowedTools) runOpts.allowedTools = options.allowedTools;
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

    return {
      output: result.response,
      usage: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      },
      costUsd: result.costUsd,
      durationMs,
      model: result.model,
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
    options?: { responseFormat?: string; allowedTools?: string[] },
  ): Promise<{
    output: string;
    usage: { input_tokens: number; output_tokens: number };
    costUsd: number;
    durationMs: number;
    model: string;
  }> {
    const supervisor = this.options.supervisor!;
    const runtime = await this.getOrCreateRuntime(agentId);
    const jobStartedAt = Date.now();

    const job = supervisor.createJob({ agentId, task });

    const runResult = await supervisor.startJob(job.id, () => {
      const runOpts: { task: string; allowedTools?: string[]; enableFallback?: boolean } = { task };
      if (options?.allowedTools) runOpts.allowedTools = options.allowedTools;
      if (this.options.enableFallback !== undefined) {
        runOpts.enableFallback = this.options.enableFallback;
      }
      return runtime.run(runOpts);
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
    return {
      output: runResult.response,
      usage: {
        input_tokens: runResult.inputTokens,
        output_tokens: runResult.outputTokens,
      },
      costUsd: runResult.costUsd,
      durationMs,
      model: runResult.model,
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

    // Check inline configs first
    const inlineConfig = this.options.inlineAgents?.[agentId];
    if (inlineConfig) {
      const runtime = new AgentRuntime(inlineConfig, this.options.workspaceAdapter);
      this.runtimes.set(agentId, runtime);
      return runtime;
    }

    // Load from .agentforge/agents/{agentId}.yaml
    let config = await loadAgentConfig(agentId, this.agentforgeDir);

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

      const fallback = await loadAgentConfig(fallbackId, this.agentforgeDir);
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
