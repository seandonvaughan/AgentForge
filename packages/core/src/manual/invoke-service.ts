import { join } from 'node:path';
import type { SessionRow } from '@agentforge/db';
import { AgentRuntime, loadAgentConfig, type RunResult } from '../agent-runtime/index.js';
import { WorkspaceManager } from '../workspace/index.js';
import type { RuntimeMode } from '../runtime/types.js';
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
    const config = await loadAgentConfig(
      selectedAgent.agentId,
      join(options.projectRoot, '.agentforge'),
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

    const result = await runtime.run({
      task: options.task,
      ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
      ...(options.allowedTools?.length ? { allowedTools: options.allowedTools } : {}),
      ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
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
