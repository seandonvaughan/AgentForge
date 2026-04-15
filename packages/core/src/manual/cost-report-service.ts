import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceManager } from '../workspace/index.js';
import { MODEL_PRICING } from '../agent-runtime/types.js';
import type { RuntimeMode, ExecutionProviderKind } from '../runtime/types.js';

interface LegacyCostEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  totalSpentUsd: number;
  totalAgentRuns: number;
  agentBreakdown?: Record<string, number>;
}

export interface CostBreakdown {
  label: string;
  totalUsd: number;
  runs: number;
}

export interface CostReport {
  source: 'workspace-db' | 'legacy-json' | 'empty';
  sessionsRecorded: number;
  totalSpentUsd: number;
  totalAgentRuns: number;
  perAgent: CostBreakdown[];
  perModel: CostBreakdown[];
  lastSession?: {
    sessionId: string;
    startedAt: string;
    completedAt?: string | null;
    costUsd: number;
    status: string;
    providerKind?: ExecutionProviderKind;
    runtimeModeResolved?: RuntimeMode;
  };
  pricingReference: typeof MODEL_PRICING;
}

export async function generateCostReport(projectRoot: string): Promise<CostReport> {
  const manager = new WorkspaceManager({
    dataDir: join(projectRoot, '.agentforge', 'v5'),
  });

  try {
    const { adapter } = await manager.getOrCreateDefaultWorkspace();
    const sessions = adapter.listSessions({ limit: 500 });
    const costs = adapter.getAllCosts();

    if (sessions.length > 0 || costs.length > 0) {
      const perAgent = new Map<string, CostBreakdown>();
      const perModel = new Map<string, CostBreakdown>();

      for (const cost of costs) {
        mergeCost(perAgent, cost.agent_id, cost.cost_usd, 1);
        mergeCost(perModel, cost.model, cost.cost_usd, 1);
      }

      const lastSession = sessions[0];
      const runtimeMetadata = lastSession
        ? parseRuntimeMetadata(adapter.listDecisionEvents({
            sessionId: lastSession.id,
            decisionType: 'runtime_transport',
            limit: 1,
          })[0]?.payload_json)
        : {};

      return {
        source: 'workspace-db',
        sessionsRecorded: sessions.length,
        totalSpentUsd: costs.reduce((sum, row) => sum + row.cost_usd, 0),
        totalAgentRuns: costs.length,
        perAgent: sortBreakdowns(perAgent),
        perModel: sortBreakdowns(perModel),
        ...(lastSession
          ? {
              lastSession: {
                sessionId: lastSession.id,
                startedAt: lastSession.started_at,
                completedAt: lastSession.completed_at,
                costUsd: lastSession.cost_usd,
                status: lastSession.status,
                ...(runtimeMetadata.providerKind ? { providerKind: runtimeMetadata.providerKind } : {}),
                ...(runtimeMetadata.runtimeModeResolved
                  ? { runtimeModeResolved: runtimeMetadata.runtimeModeResolved }
                  : {}),
              },
            }
          : {}),
        pricingReference: MODEL_PRICING,
      };
    }
  } finally {
    manager.close();
  }

  const legacyEntries = await loadLegacyEntries(projectRoot);
  if (legacyEntries.length === 0) {
    return {
      source: 'empty',
      sessionsRecorded: 0,
      totalSpentUsd: 0,
      totalAgentRuns: 0,
      perAgent: [],
      perModel: [],
      pricingReference: MODEL_PRICING,
    };
  }

  const perAgent = new Map<string, CostBreakdown>();
  for (const entry of legacyEntries) {
    for (const [agent, costUsd] of Object.entries(entry.agentBreakdown ?? {})) {
      mergeCost(perAgent, agent, costUsd, 1);
    }
  }

  const totalSpentUsd = legacyEntries.reduce((sum, entry) => sum + entry.totalSpentUsd, 0);
  const totalAgentRuns = legacyEntries.reduce((sum, entry) => sum + entry.totalAgentRuns, 0);
  const lastEntry = legacyEntries[legacyEntries.length - 1];

  return {
    source: 'legacy-json',
    sessionsRecorded: legacyEntries.length,
    totalSpentUsd,
    totalAgentRuns,
    perAgent: sortBreakdowns(perAgent),
    perModel: [],
    ...(lastEntry
      ? {
          lastSession: {
            sessionId: lastEntry.sessionId,
            startedAt: lastEntry.startedAt,
            completedAt: lastEntry.endedAt,
            costUsd: lastEntry.totalSpentUsd,
            status: 'completed',
          },
        }
      : {}),
    pricingReference: MODEL_PRICING,
  };
}

async function loadLegacyEntries(projectRoot: string): Promise<LegacyCostEntry[]> {
  const sessionsDir = join(projectRoot, '.agentforge', 'sessions');

  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const entries: LegacyCostEntry[] = [];
  for (const file of files.filter((entry) => entry.startsWith('cost-entry-') && entry.endsWith('.json')).sort()) {
    try {
      const raw = await readFile(join(sessionsDir, file), 'utf8');
      entries.push(JSON.parse(raw) as LegacyCostEntry);
    } catch {
      // Ignore malformed legacy files.
    }
  }

  return entries;
}

function mergeCost(
  target: Map<string, CostBreakdown>,
  label: string,
  totalUsd: number,
  runs: number,
): void {
  const existing = target.get(label);
  if (existing) {
    existing.totalUsd += totalUsd;
    existing.runs += runs;
    return;
  }

  target.set(label, { label, totalUsd, runs });
}

function sortBreakdowns(values: Map<string, CostBreakdown>): CostBreakdown[] {
  return [...values.values()].sort((left, right) => right.totalUsd - left.totalUsd);
}

function parseRuntimeMetadata(payloadJson?: string): {
  providerKind?: ExecutionProviderKind;
  runtimeModeResolved?: RuntimeMode;
} {
  if (!payloadJson) return {};

  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      ...(typeof payload.providerKind === 'string'
        ? { providerKind: payload.providerKind as ExecutionProviderKind }
        : {}),
      ...(typeof payload.runtimeModeResolved === 'string'
        ? { runtimeModeResolved: payload.runtimeModeResolved as RuntimeMode }
        : {}),
    };
  } catch {
    return {};
  }
}
