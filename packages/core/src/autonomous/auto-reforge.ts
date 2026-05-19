// packages/core/src/autonomous/auto-reforge.ts
//
// T2.3 — Auto-reforge hook: after gate approval, run the learning-curator
// + mutator so the agents that ran in this cycle absorb the new lessons.
//
// Workstreams P and Q own the actual curateLearnings / applyLearnings
// implementations. This module stubs those imports with the expected contract
// so the cycle-runner integration and tests can run without those modules
// being present yet. When P+Q land, swap the stubs for the real imports.

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Real implementations from Workstreams P (curator) and Q (mutator).
// Adapted to R's expected shapes below.
import { curateLearnings as _realCurate } from '../team/engine/learnings/curator.js';
import { applyLearnings as _realApply } from '../team/engine/learnings/mutator.js';

const SAFE_AGENT_ID = /^[a-zA-Z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Upstream types from Workstreams P + Q (stubs until they land)
// ---------------------------------------------------------------------------

export interface CurationInput {
  projectRoot: string;
  agentIds: string[];
  maxEntriesPerSource?: number;
}

export interface ProposedLearning {
  agentId: string;
  lesson: string;
  score: number;
  sourceId: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
  rationale: 'role-tag' | 'subsystem' | 'recurring-pattern';
  sourceCreatedAt: string;
}

export interface CurationResult {
  byAgent: Record<string, ProposedLearning[]>;
  sourcesScanned: Array<{ path: string; entriesRead: number; scored: number }>;
  generatedAt: string;
}

export interface MutatorReport {
  perAgent: Record<
    string,
    {
      applied: number;
      skipped: number;
      capped: boolean;
      lessons: string[];
    }
  >;
  totalApplied: number;
  totalSkipped: number;
  dryRun: boolean;
}

export interface ApplyLearningsInput {
  projectRoot: string;
  proposed: CurationResult;
  dryRun?: boolean;
}

export interface AutoReforgeCanaryOptions {
  enabled?: boolean;
  rolloutPercent?: number;
  minCanaryAgents?: number;
  autoPromote?: boolean;
  rollbackCostMultiplier?: number;
}

// ---------------------------------------------------------------------------
// Stub implementations (replaced when Workstreams P+Q land)
// ---------------------------------------------------------------------------

/**
 * Stub for the Workstream P learning-curator.
 *
 * When the real implementation is available, replace this with a static import:
 *   import { curateLearnings } from '../learnings/curator.js';
 *
 * The stub returns an empty CurationResult so the auto-reforge hook
 * short-circuits cleanly (skipped = true) until the real curator lands.
 * Using a named stub function (not a try/require) so it works in ESM.
 */
async function stubCurateLearnings(
  _input: CurationInput,
): Promise<CurationResult> {
  return { byAgent: {}, sourcesScanned: [], generatedAt: new Date().toISOString() };
}

/**
 * Stub for the Workstream Q reforge mutator.
 *
 * When the real implementation is available, replace this with a static import:
 *   import { applyLearnings } from '../learnings/mutator.js';
 *
 * The stub returns an empty MutatorReport.
 * Using a named stub function (not a try/require) so it works in ESM.
 */
async function stubApplyLearnings(
  input: ApplyLearningsInput,
): Promise<MutatorReport> {
  return {
    perAgent: {},
    totalApplied: 0,
    totalSkipped: 0,
    dryRun: input.dryRun ?? false,
  };
}

// Adapt Q's actual MutatorReport (perAgent: array) to R's expected shape
// (perAgent: record). Wires P's real curator and Q's real mutator into the
// auto-reforge hook; tests can still override via the options object.
const _curateLearnings: (input: CurationInput) => Promise<CurationResult> =
  async (input) => {
    void stubCurateLearnings; // keep reference so the stub remains as a fallback path
    return _realCurate({
      projectRoot: input.projectRoot,
      agentIds: input.agentIds,
      ...(input.maxEntriesPerSource !== undefined
        ? { maxEntriesPerSource: input.maxEntriesPerSource }
        : {}),
    }) as Promise<CurationResult>;
  };

const _applyLearnings: (input: ApplyLearningsInput) => Promise<MutatorReport> =
  async (input) => {
    void stubApplyLearnings; // keep reference so the stub remains as a fallback path
    persistMutatorInput(input.projectRoot, input.proposed);
    // Q reads proposed from disk; P has already written it to
    // .agentforge/forge/learnings-proposed.json. Q's perAgent is an array;
    // we re-key it into a Record<agentId, ...> to match R's contract.
    const realReport = await _realApply({
      projectRoot: input.projectRoot,
      dryRun: input.dryRun ?? false,
    });
    const perAgentRecord: MutatorReport['perAgent'] = {};
    let totalApplied = 0;
    let totalSkipped = 0;
    for (const entry of realReport.perAgent) {
      const applied = entry.added.length;
      const skipped = entry.deduped + entry.contradicted + entry.capped;
      perAgentRecord[entry.agentId] = {
        applied,
        skipped,
        capped: entry.capped > 0,
        lessons: entry.added,
      };
      totalApplied += applied;
      totalSkipped += skipped;
    }
    return {
      perAgent: perAgentRecord,
      totalApplied,
      totalSkipped,
      dryRun: realReport.dryRun,
    };
  };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AutoReforgeOptions {
  projectRoot: string;
  cycleId: string;
  involvedAgentIds: string[];
  dryRun?: boolean;
  canary?: AutoReforgeCanaryOptions;
  projectedBudgetUsd?: number;
  currentCostUsd?: number;
  /** Optional bus for emitting learnings.applied events. */
  bus?: { publish: (topic: string, payload: unknown) => void };
  /** Injected curator (for testing). */
  curateLearnings?: (input: CurationInput) => Promise<CurationResult>;
  /** Injected mutator (for testing). */
  applyLearnings?: (input: ApplyLearningsInput) => Promise<MutatorReport>;
}

export interface AutoReforgeResult {
  cycleId: string;
  /** true if no proposed learnings were produced (nothing to apply). */
  skipped: boolean;
  mutatorReport?: MutatorReport;
  canary?: {
    enabled: boolean;
    status: 'staged' | 'promoted' | 'rolled_back';
    stagedAgents: string[];
    promotedAgents: string[];
    rolledBackAgents: string[];
    rollbackReason?: string;
  };
  durationMs: number;
}

/**
 * Run the learning-curator + mutator so agents that participated in this cycle
 * absorb the lessons from its gate-verdict, review-findings, and outcomes.
 *
 * This is called by the cycle-runner after the gate APPROVES and before the
 * cycle is marked COMPLETED. Errors are intentionally non-fatal: the caller
 * wraps this in a try/catch so a reforge failure never kills a passed cycle.
 */
export async function runAutoReforge(
  opts: AutoReforgeOptions,
): Promise<AutoReforgeResult> {
  const startedAt = Date.now();
  const curate = opts.curateLearnings ?? _curateLearnings;
  const apply = opts.applyLearnings ?? _applyLearnings;

  // 1. Curate learnings for all agents that ran in this cycle.
  const curationResult = await curate({
    projectRoot: opts.projectRoot,
    agentIds: opts.involvedAgentIds,
  });

  // 2. Short-circuit if the curator produced nothing.
  const totalProposed = Object.values(curationResult.byAgent).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  if (totalProposed === 0) {
    return { cycleId: opts.cycleId, skipped: true, durationMs: Date.now() - startedAt };
  }

  const canaryEnabled = opts.canary?.enabled === true;
  const candidateAgentIds = Object.entries(curationResult.byAgent)
    .filter(([agentId, lessons]) => isSafeAgentId(agentId) && lessons.length > 0)
    .map(([agentId]) => agentId);

  if (canaryEnabled && candidateAgentIds.length > 1) {
    const rolloutPercent = clamp(
      Number.isFinite(opts.canary?.rolloutPercent)
        ? Number(opts.canary?.rolloutPercent)
        : 20,
      1,
      100,
    );
    const minCanaryAgents = Math.max(
      1,
      Number.isFinite(opts.canary?.minCanaryAgents)
        ? Math.floor(Number(opts.canary?.minCanaryAgents))
        : 1,
    );
    const canaryCount = Math.min(
      candidateAgentIds.length,
      Math.max(minCanaryAgents, Math.ceil((candidateAgentIds.length * rolloutPercent) / 100)),
    );
    const stagedAgents = candidateAgentIds.slice(0, canaryCount);
    const remainingAgents = candidateAgentIds.slice(canaryCount);
    const projectedBudgetUsd = Number.isFinite(opts.projectedBudgetUsd)
      ? Number(opts.projectedBudgetUsd)
      : 0;
    const currentCostUsd = Number.isFinite(opts.currentCostUsd)
      ? Number(opts.currentCostUsd)
      : 0;
    const rollbackCostMultiplier = Number.isFinite(opts.canary?.rollbackCostMultiplier) &&
      Number(opts.canary?.rollbackCostMultiplier) > 0
      ? Number(opts.canary?.rollbackCostMultiplier)
      : 2;

    if (
      projectedBudgetUsd > 0 &&
      currentCostUsd > projectedBudgetUsd * rollbackCostMultiplier
    ) {
      return {
        cycleId: opts.cycleId,
        skipped: false,
        canary: {
          enabled: true,
          status: 'rolled_back',
          stagedAgents: [],
          promotedAgents: [],
          rolledBackAgents: [],
          rollbackReason:
            `cost outlier: $${currentCostUsd.toFixed(2)} > ` +
            `${rollbackCostMultiplier.toFixed(2)}x projected $${projectedBudgetUsd.toFixed(2)}`,
        },
        durationMs: Date.now() - startedAt,
      };
    }
    const stagedSnapshot = snapshotAgentLearnings(opts.projectRoot, stagedAgents);

    try {
      const stagedReport = await apply({
        projectRoot: opts.projectRoot,
        proposed: sliceCurationByAgents(curationResult, stagedAgents),
        dryRun: opts.dryRun ?? false,
      });

      if (
        projectedBudgetUsd > 0 &&
        currentCostUsd > projectedBudgetUsd * rollbackCostMultiplier
      ) {
        restoreAgentLearningsSnapshot(opts.projectRoot, stagedSnapshot);
        return {
          cycleId: opts.cycleId,
          skipped: false,
          mutatorReport: stagedReport,
          canary: {
            enabled: true,
            status: 'rolled_back',
            stagedAgents,
            promotedAgents: [],
            rolledBackAgents: stagedAgents,
            rollbackReason:
              `cost outlier: $${currentCostUsd.toFixed(2)} > ` +
              `${rollbackCostMultiplier.toFixed(2)}x projected $${projectedBudgetUsd.toFixed(2)}`,
          },
          durationMs: Date.now() - startedAt,
        };
      }

      const autoPromote = opts.canary?.autoPromote !== false;
      if (!autoPromote || remainingAgents.length === 0) {
        return {
          cycleId: opts.cycleId,
          skipped: false,
          mutatorReport: stagedReport,
          canary: {
            enabled: true,
            status: remainingAgents.length === 0 ? 'promoted' : 'staged',
            stagedAgents,
            promotedAgents: remainingAgents.length === 0 ? [...stagedAgents] : [],
            rolledBackAgents: [],
          },
          durationMs: Date.now() - startedAt,
        };
      }

      try {
        const promotedReport = await apply({
          projectRoot: opts.projectRoot,
          proposed: sliceCurationByAgents(curationResult, remainingAgents),
          dryRun: opts.dryRun ?? false,
        });
        const mergedReport = mergeMutatorReports(stagedReport, promotedReport);
        if (opts.bus) {
          opts.bus.publish('learnings.applied', {
            cycleId: opts.cycleId,
            perAgent: mergedReport.perAgent,
            totalApplied: mergedReport.totalApplied,
            dryRun: mergedReport.dryRun,
          });
        }

        return {
          cycleId: opts.cycleId,
          skipped: false,
          mutatorReport: mergedReport,
          canary: {
            enabled: true,
            status: 'promoted',
            stagedAgents,
            promotedAgents: [...candidateAgentIds],
            rolledBackAgents: [],
          },
          durationMs: Date.now() - startedAt,
        };
      } catch (promoteErr) {
        restoreAgentLearningsSnapshot(opts.projectRoot, stagedSnapshot);
        return {
          cycleId: opts.cycleId,
          skipped: false,
          mutatorReport: stagedReport,
          canary: {
            enabled: true,
            status: 'rolled_back',
            stagedAgents,
            promotedAgents: [],
            rolledBackAgents: stagedAgents,
            rollbackReason: promoteErr instanceof Error ? promoteErr.message : String(promoteErr),
          },
          durationMs: Date.now() - startedAt,
        };
      }
    } catch (canaryErr) {
      restoreAgentLearningsSnapshot(opts.projectRoot, stagedSnapshot);
      return {
        cycleId: opts.cycleId,
        skipped: false,
        canary: {
          enabled: true,
          status: 'rolled_back',
          stagedAgents,
          promotedAgents: [],
          rolledBackAgents: stagedAgents,
          rollbackReason: canaryErr instanceof Error ? canaryErr.message : String(canaryErr),
        },
        durationMs: Date.now() - startedAt,
      };
    }
  }

  // 3. Apply the proposed learnings via the mutator.
  const mutatorReport = await apply({
    projectRoot: opts.projectRoot,
    proposed: curationResult,
    dryRun: opts.dryRun ?? false,
  });

  // 4. Publish a bus event when a bus is provided.
  if (opts.bus) {
    opts.bus.publish('learnings.applied', {
      cycleId: opts.cycleId,
      perAgent: mutatorReport.perAgent,
      totalApplied: mutatorReport.totalApplied,
      dryRun: mutatorReport.dryRun,
    });
  }

  return {
    cycleId: opts.cycleId,
    skipped: false,
    mutatorReport,
    ...(canaryEnabled
      ? {
          canary: {
            enabled: true,
            status: 'promoted' as const,
            stagedAgents: candidateAgentIds,
            promotedAgents: candidateAgentIds,
            rolledBackAgents: [],
          },
        }
      : {}),
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers used by the cycle-runner to extract involvedAgentIds
// ---------------------------------------------------------------------------

/**
 * Extract the unique set of agent IDs that executed items in a cycle.
 *
 * Strategy: read `phases/execute.json` from the cycle directory. This file
 * is written by the execute-phase handler and includes an `agentRuns` or
 * `itemResults` array where each entry carries an `agentId` field. This is
 * the cleanest extraction point because:
 *   1. It is written once per cycle (not incremental like events.jsonl).
 *   2. The agentId is stored directly alongside each item result.
 *   3. No regex parsing needed — the file is structured JSON.
 *
 * Falls back to an empty array when the file is absent or unreadable (e.g.
 * when all items were skipped or the execute phase was stubbed in tests).
 */
export function extractInvolvedAgentIds(
  projectRoot: string,
  cycleId: string,
): string[] {
  const execPath = join(
    projectRoot,
    '.agentforge',
    'cycles',
    cycleId,
    'phases',
    'execute.json',
  );
  if (!existsSync(execPath)) return [];
  try {
    const raw = readFileSync(execPath, 'utf8');
    const data = JSON.parse(raw) as {
      agentRuns?: Array<{ agentId?: string }>;
      itemResults?: Array<{ agentId?: string }>;
    };
    const runs = data.agentRuns ?? data.itemResults ?? [];
    const ids = runs
      .map((r) => r.agentId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

function persistMutatorInput(projectRoot: string, proposed: CurationResult): void {
  const forgeDir = join(projectRoot, '.agentforge', 'forge');
  mkdirSync(forgeDir, { recursive: true });
  const safeByAgent = Object.fromEntries(
    Object.entries(proposed.byAgent).filter(([agentId]) => isSafeAgentId(agentId)),
  );
  writeFileSync(
    join(forgeDir, 'learnings-proposed.json'),
    JSON.stringify(safeByAgent, null, 2),
    'utf8',
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sliceCurationByAgents(result: CurationResult, agentIds: string[]): CurationResult {
  const pick = new Set(agentIds.filter(isSafeAgentId));
  const byAgent: CurationResult['byAgent'] = {};
  for (const [agentId, learnings] of Object.entries(result.byAgent)) {
    if (pick.has(agentId)) byAgent[agentId] = learnings;
  }
  return {
    byAgent,
    sourcesScanned: result.sourcesScanned,
    generatedAt: result.generatedAt,
  };
}

function mergeMutatorReports(a: MutatorReport, b: MutatorReport): MutatorReport {
  return {
    perAgent: { ...a.perAgent, ...b.perAgent },
    totalApplied: a.totalApplied + b.totalApplied,
    totalSkipped: a.totalSkipped + b.totalSkipped,
    dryRun: a.dryRun || b.dryRun,
  };
}

function snapshotAgentLearnings(
  projectRoot: string,
  agentIds: string[],
): Map<string, string | null> {
  const snapshots = new Map<string, string | null>();
  for (const agentId of agentIds) {
    if (!isSafeAgentId(agentId)) continue;
    const path = join(projectRoot, '.agentforge', 'agents', `${agentId}.yaml`);
    snapshots.set(agentId, existsSync(path) ? readFileSync(path, 'utf8') : null);
  }
  return snapshots;
}

function restoreAgentLearningsSnapshot(
  projectRoot: string,
  snapshots: Map<string, string | null>,
): void {
  for (const [agentId, content] of snapshots.entries()) {
    if (!isSafeAgentId(agentId)) continue;
    const path = join(projectRoot, '.agentforge', 'agents', `${agentId}.yaml`);
    if (content === null) {
      rmSync(path, { force: true });
      continue;
    }
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
}

function isSafeAgentId(agentId: string): boolean {
  return SAFE_AGENT_ID.test(agentId);
}
