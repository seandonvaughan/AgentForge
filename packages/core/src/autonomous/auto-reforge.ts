// packages/core/src/autonomous/auto-reforge.ts
//
// T2.3 — Auto-reforge hook: after gate approval, run the learning-curator
// + mutator so the agents that ran in this cycle absorb the new lessons.
//
// Workstreams P and Q own the actual curateLearnings / applyLearnings
// implementations. This module stubs those imports with the expected contract
// so the cycle-runner integration and tests can run without those modules
// being present yet. When P+Q land, swap the stubs for the real imports.

import { readFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Real implementations from Workstreams P (curator) and Q (mutator).
// Adapted to R's expected shapes below.
import { curateLearnings as _realCurate } from '../team/engine/learnings/curator.js';
import { applyLearnings as _realApply } from '../team/engine/learnings/mutator.js';

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
    // Q reads proposed from disk; P has already written it to
    // .agentforge/forge/learnings-proposed.json. Q's perAgent is an array;
    // we re-key it into a Record<agentId, ...> to match R's contract.
    const realReport = await _realApply({
      projectRoot: input.projectRoot,
      dryRun: input.dryRun ?? false,
      proposedByAgent: input.proposed.byAgent,
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
  /**
   * Percentage of involved agents that should receive self-modifications
   * immediately. Remaining agents are deferred to later cycles.
   * Defaults to 25.
   */
  canaryTrafficPercent?: number;
  /**
   * Projected spend for this cycle (typically scoring output). When provided
   * with `actualCostUsd`, auto-reforge can trigger fail-closed rollback.
   */
  projectedCostUsd?: number;
  /**
   * Actual spend observed so far for this cycle.
   */
  actualCostUsd?: number;
  /**
   * Rollback trigger multiplier against projected spend. Defaults to 2.
   */
  rollbackCostMultiplier?: number;
  /** Optional bus for emitting learnings.applied events. */
  bus?: { publish: (topic: string, payload: unknown) => void };
  /** Injected curator (for testing). */
  curateLearnings?: (input: CurationInput) => Promise<CurationResult>;
  /** Injected mutator (for testing). */
  applyLearnings?: (input: ApplyLearningsInput) => Promise<MutatorReport>;
}

export interface SelfModificationCanaryResult {
  trafficPercent: number;
  targetedAgents: string[];
  canaryAgents: string[];
  deferredAgents: string[];
}

export interface SelfModificationRollbackResult {
  triggered: boolean;
  reason?: string;
  projectedCostUsd?: number;
  actualCostUsd?: number;
  multiplier: number;
  rolledBackAgents: string[];
}

export interface AutoReforgeResult {
  cycleId: string;
  /** true if no proposed learnings were produced (nothing to apply). */
  skipped: boolean;
  mutatorReport?: MutatorReport;
  canary?: SelfModificationCanaryResult;
  rollback?: SelfModificationRollbackResult;
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
  const canaryTrafficPercent = clampPercent(opts.canaryTrafficPercent ?? 25);
  const rollbackCostMultiplier = opts.rollbackCostMultiplier ?? 2;

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

  // 3. Stage canary cohort for self-modifications.
  const targetedAgents = Object.entries(curationResult.byAgent)
    .filter(([, learnings]) => Array.isArray(learnings) && learnings.length > 0)
    .map(([agentId]) => agentId)
    .sort();
  const cohort = splitCanaryCohort(opts.cycleId, targetedAgents, canaryTrafficPercent);
  const canaryCurationResult = filterCurationByAgents(curationResult, cohort.canaryAgents);
  const snapshots = await snapshotAgentLearnings(opts.projectRoot, cohort.canaryAgents);

  // 4. Apply only the staged canary learnings via the mutator.
  const mutatorReport = await apply({
    projectRoot: opts.projectRoot,
    proposed: canaryCurationResult,
    dryRun: opts.dryRun ?? false,
  });

  // 5. Fail-closed rollback when cycle spend is a cost outlier.
  const rollback = evaluateRollback({
    projectedCostUsd: opts.projectedCostUsd,
    actualCostUsd: opts.actualCostUsd,
    multiplier: rollbackCostMultiplier,
  });
  if (rollback.triggered && !opts.dryRun) {
    const rolledBackAgents = await rollbackAgentLearnings(
      opts.projectRoot,
      snapshots,
      appliedAgentIds(mutatorReport),
    );
    rollback.rolledBackAgents = rolledBackAgents;
  }

  const canary: SelfModificationCanaryResult = {
    trafficPercent: canaryTrafficPercent,
    targetedAgents,
    canaryAgents: cohort.canaryAgents,
    deferredAgents: cohort.deferredAgents,
  };

  // 6. Publish a bus event when a bus is provided.
  if (opts.bus) {
    opts.bus.publish('learnings.applied', {
      cycleId: opts.cycleId,
      perAgent: mutatorReport.perAgent,
      totalApplied: mutatorReport.totalApplied,
      dryRun: mutatorReport.dryRun,
      canary,
      rollback,
    });
  }

  return {
    cycleId: opts.cycleId,
    skipped: false,
    mutatorReport,
    canary,
    rollback,
    durationMs: Date.now() - startedAt,
  };
}

interface CanaryCohort {
  canaryAgents: string[];
  deferredAgents: string[];
}

type LearningSnapshotMap = Map<string, string | null>;

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function splitCanaryCohort(
  cycleId: string,
  agentIds: string[],
  trafficPercent: number,
): CanaryCohort {
  if (trafficPercent >= 100) {
    return { canaryAgents: [...agentIds], deferredAgents: [] };
  }
  if (trafficPercent <= 0 || agentIds.length === 0) {
    return { canaryAgents: [], deferredAgents: [...agentIds] };
  }

  const canaryAgents = agentIds.filter((agentId) => {
    const bucket = hashBucket(`${cycleId}:${agentId}`);
    return bucket < trafficPercent;
  });
  const stableCanary = canaryAgents.length > 0 ? canaryAgents : [agentIds[0]!];
  const canarySet = new Set(stableCanary);
  const deferredAgents = agentIds.filter((agentId) => !canarySet.has(agentId));
  return {
    canaryAgents: stableCanary,
    deferredAgents,
  };
}

function hashBucket(value: string): number {
  const digest = createHash('sha1').update(value).digest();
  return digest.readUInt32BE(0) % 100;
}

function filterCurationByAgents(
  curation: CurationResult,
  agentIds: string[],
): CurationResult {
  const byAgent: CurationResult['byAgent'] = {};
  const allow = new Set(agentIds);
  for (const [agentId, learnings] of Object.entries(curation.byAgent)) {
    if (!allow.has(agentId)) continue;
    byAgent[agentId] = [...learnings];
  }
  return {
    byAgent,
    sourcesScanned: curation.sourcesScanned,
    generatedAt: curation.generatedAt,
  };
}

async function snapshotAgentLearnings(
  projectRoot: string,
  agentIds: string[],
): Promise<LearningSnapshotMap> {
  const snapshots: LearningSnapshotMap = new Map();
  for (const agentId of agentIds) {
    const path = join(projectRoot, '.agentforge', 'agents', `${agentId}.yaml`);
    try {
      snapshots.set(agentId, await readFile(path, 'utf8'));
    } catch {
      snapshots.set(agentId, null);
    }
  }
  return snapshots;
}

function appliedAgentIds(report: MutatorReport): string[] {
  return Object.entries(report.perAgent)
    .filter(([, meta]) => meta.applied > 0)
    .map(([agentId]) => agentId);
}

async function rollbackAgentLearnings(
  projectRoot: string,
  snapshots: LearningSnapshotMap,
  agentIds: string[],
): Promise<string[]> {
  const rolledBack: string[] = [];
  for (const agentId of agentIds) {
    if (!snapshots.has(agentId)) continue;
    const path = join(projectRoot, '.agentforge', 'agents', `${agentId}.yaml`);
    const snapshot = snapshots.get(agentId);
    try {
      if (snapshot === null) {
        await rm(path, { force: true });
      } else {
        await mkdir(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
        await writeFile(path, snapshot, 'utf8');
      }
      rolledBack.push(agentId);
    } catch {
      // Best-effort rollback to keep self-modification path non-fatal.
    }
  }
  return rolledBack;
}

function evaluateRollback(input: {
  projectedCostUsd?: number;
  actualCostUsd?: number;
  multiplier: number;
}): SelfModificationRollbackResult {
  const rollback: SelfModificationRollbackResult = {
    triggered: false,
    multiplier: input.multiplier,
    rolledBackAgents: [],
  };
  if (input.projectedCostUsd !== undefined) rollback.projectedCostUsd = input.projectedCostUsd;
  if (input.actualCostUsd !== undefined) rollback.actualCostUsd = input.actualCostUsd;

  if (
    input.projectedCostUsd === undefined ||
    input.actualCostUsd === undefined ||
    input.projectedCostUsd <= 0
  ) {
    return rollback;
  }

  const threshold = input.projectedCostUsd * input.multiplier;
  if (input.actualCostUsd > threshold) {
    rollback.triggered = true;
    rollback.reason =
      `Cost outlier rollback: actual $${input.actualCostUsd.toFixed(2)} exceeds ` +
      `${input.multiplier}x projected $${input.projectedCostUsd.toFixed(2)}`;
  }
  return rollback;
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
