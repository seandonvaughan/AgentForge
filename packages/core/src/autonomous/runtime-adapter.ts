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
   * Inline agent configs keyed by agentId. If provided, these take precedence
   * over loading from disk. Useful for tests and for injecting synthesized
   * agent configs that don't have a .yaml file yet.
   */
  inlineAgents?: Record<string, AgentRuntimeConfig>;
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
    const runtime = await this.getOrCreateRuntime(agentId);
    const startedAt = Date.now();
    const runOpts: { task: string; allowedTools?: string[] } = { task };
    if (options?.allowedTools) runOpts.allowedTools = options.allowedTools;
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
   * Pre-warm the adapter by registering an inline agent config. Avoids a
   * disk lookup on first use of that agent.
   */
  registerInlineAgent(agentId: string, config: AgentRuntimeConfig): void {
    if (this.runtimes.has(agentId)) return;
    const runtime = new AgentRuntime(config, this.options.workspaceAdapter);
    this.runtimes.set(agentId, runtime);
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

    const runtime = new AgentRuntime(config, this.options.workspaceAdapter);
    this.runtimes.set(agentId, runtime);
    return runtime;
  }
}
