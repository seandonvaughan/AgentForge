import { join } from 'node:path';
import type { SessionRow } from '@agentforge/db';
import { AgentRuntime, loadAgentConfig, type RunResult } from '../agent-runtime/index.js';
import { writeMemoryEntry, type CycleMemoryEntry } from '../memory/types.js';
import { WorkspaceManager } from '../workspace/index.js';
import type { CodexSandboxMode, RuntimeMode } from '../runtime/types.js';
import {
  listCatalogAgents,
  resolveCatalogAgent,
  type CatalogAgent,
} from './agent-catalog.js';

export interface InvokeAgentRunOptions {
  projectRoot: string;
  agent: string;
  task: string;
  runtimeMode?: RuntimeMode;
  allowedTools?: string[];
  budgetUsd?: number;
  codexSandbox?: CodexSandboxMode;
  codexSearch?: boolean;
  codexAddDirs?: string[];
  codexEphemeral?: boolean;
  codexProfile?: string;
  codexProfileV2?: string;
  codexSkipGitRepoCheck?: boolean;
  codexResumeSessionId?: string;
  codexResumeLast?: boolean;
  dataDir?: string;
}

export interface InvokeAgentRunResult {
  agent: CatalogAgent;
  result: RunResult;
  persistedSession?: SessionRow;
}

export class AgentLookupError extends Error {
  constructor(
    requestedAgent: string,
    readonly availableAgents: CatalogAgent[],
  ) {
    super(
      availableAgents.length > 0
        ? `Agent "${requestedAgent}" was not found.`
        : 'No generated agents were found. Run a team generation command first.',
    );
    this.name = 'AgentLookupError';
  }
}

interface ManualInvokeMemoryInput {
  projectRoot: string;
  agent: CatalogAgent;
  task: string;
  result?: RunResult;
  error?: string;
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function responseSummary(response: string): string {
  try {
    const parsed = JSON.parse(response) as Record<string, unknown>;
    const summary = parsed['summary'];
    if (typeof summary === 'string' && summary.trim()) {
      return compactText(summary, 500);
    }
  } catch {
    // Plain text response.
  }

  return compactText(response, 500);
}

export function recordManualInvokeMemory(
  input: ManualInvokeMemoryInput,
): CycleMemoryEntry {
  const status = input.result?.status ?? 'failed';
  const error = input.error ?? input.result?.error;
  const summary = error
    ? `Manual invoke failed for ${input.agent.agentId}: ${compactText(error, 400)}`
    : responseSummary(input.result?.response ?? '') ||
      `Manual invoke completed for ${input.agent.agentId}: ${compactText(input.task, 300)}`;
  const severity = status === 'completed' ? 'MINOR' : 'MAJOR';
  const type = status === 'completed' ? 'learned-fact' : 'failure-pattern';
  const value = JSON.stringify({
    lesson: summary,
    agentId: input.agent.agentId,
    task: compactText(input.task, 300),
    status,
    ...(input.result?.model ? { model: input.result.model } : {}),
    ...(input.result?.providerKind ? { providerKind: input.result.providerKind } : {}),
    ...(input.result?.runtimeModeResolved ? { runtimeModeResolved: input.result.runtimeModeResolved } : {}),
    ...(typeof input.result?.costUsd === 'number' ? { costUsd: input.result.costUsd } : {}),
    ...(error ? { error: compactText(error, 400) } : {}),
  });

  return writeMemoryEntry(input.projectRoot, {
    type,
    value,
    source: input.agent.agentId,
    tags: [
      'manual-invoke',
      input.agent.agentId,
      `agent:${input.agent.agentId}`,
      `status:${status}`,
      severity.toLowerCase(),
      ...input.agent.skills,
    ],
    metadata: {
      severity,
      agentId: input.agent.agentId,
      sessionId: input.result?.sessionId,
      task: compactText(input.task, 300),
      status,
      summary,
    },
  });
}

export async function invokeAgentRun(
  options: InvokeAgentRunOptions,
): Promise<InvokeAgentRunResult> {
  const agents = await listCatalogAgents(options.projectRoot);
  const selectedAgent = resolveCatalogAgent(options.agent, agents);

  if (!selectedAgent) {
    throw new AgentLookupError(options.agent, agents);
  }

  const manager = new WorkspaceManager({
    dataDir: options.dataDir ?? join(options.projectRoot, '.agentforge', 'v5'),
  });

  try {
    const { adapter } = await manager.getOrCreateDefaultWorkspace();
    // Pass the adapter so any pending DMs for this agent are spliced into the
    // system prompt before invocation (ADR 0001 — Phase 2 comms wiring).
    const config = await loadAgentConfig(
      selectedAgent.agentId,
      join(options.projectRoot, '.agentforge'),
      { adapter },
    );

    if (!config) {
      throw new AgentLookupError(options.agent, agents);
    }

    const runtime = new AgentRuntime(
      {
        ...config,
        ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
      },
      adapter,
    );

    let result: RunResult;
    try {
      result = await runtime.run({
        task: options.task,
        ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
        ...(options.allowedTools?.length ? { allowedTools: options.allowedTools } : {}),
        ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
        ...(options.codexSandbox ? { codexSandbox: options.codexSandbox } : {}),
        ...(options.codexSearch !== undefined ? { codexSearch: options.codexSearch } : {}),
        ...(options.codexAddDirs?.length ? { codexAddDirs: options.codexAddDirs } : {}),
        ...(options.codexEphemeral !== undefined ? { codexEphemeral: options.codexEphemeral } : {}),
        ...(options.codexProfile ? { codexProfile: options.codexProfile } : {}),
        ...(options.codexProfileV2 ? { codexProfileV2: options.codexProfileV2 } : {}),
        ...(options.codexSkipGitRepoCheck !== undefined ? { codexSkipGitRepoCheck: options.codexSkipGitRepoCheck } : {}),
        ...(options.codexResumeSessionId ? { codexResumeSessionId: options.codexResumeSessionId } : {}),
        ...(options.codexResumeLast !== undefined ? { codexResumeLast: options.codexResumeLast } : {}),
      });
    } catch (err) {
      recordManualInvokeMemory({
        projectRoot: options.projectRoot,
        agent: selectedAgent,
        task: options.task,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    recordManualInvokeMemory({
      projectRoot: options.projectRoot,
      agent: selectedAgent,
      task: options.task,
      result,
    });
    const persistedSession = result.sessionId ? adapter.getSession(result.sessionId) : undefined;

    return {
      agent: selectedAgent,
      result,
      ...(persistedSession ? { persistedSession } : {}),
    };
  } finally {
    manager.close();
  }
}
