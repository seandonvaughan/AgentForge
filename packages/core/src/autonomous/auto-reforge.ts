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
import { dirname, join, relative, resolve, sep } from 'node:path';
import yaml from 'js-yaml';

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

export interface AutoReforgeCostMetrics {
  /** Current observed cost after reading the latest ledger/cycle files. */
  currentCostUsd: number;
  /** Projected budget used to decide whether this self-modification is an outlier. */
  projectedBudgetUsd: number;
}

export interface AutoReforgeCanaryOptions {
  /**
   * Stage auto-reforge as a rollbackable self-modification canary.
   *
   * Disabled by default for direct callers to preserve legacy behavior. The
   * unattended cycle runner enables it for production auto-reforge.
   */
  enabled?: boolean;
  /** Roll back when currentCostUsd is more than this multiple of projectedBudgetUsd. */
  rollbackCostMultiplier?: number;
  /** Re-read cost metrics before and after the staged write. */
  readCostMetrics?: () => AutoReforgeCostMetrics | Promise<AutoReforgeCostMetrics>;
}

export interface AutoReforgeCanaryRecord {
  cycleId: string;
  status: 'promoted' | 'rolled_back';
  targetAgentIds: string[];
  startedAt: string;
  completedAt: string;
  rollbackCostMultiplier: number;
  costBefore?: AutoReforgeCostMetrics;
  costAfter?: AutoReforgeCostMetrics;
  rollbackReason?: string;
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
    // Q reads a Record<agentId, ProposedLearning[]> from disk. P persists the
    // richer CurationResult for curator tests, so the auto-reforge boundary
    // writes the mutator's exact input shape immediately before applying.
    await persistMutatorInput(input.projectRoot, input.proposed);
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
  /** Canary/rollback guardrails for the self-modification write. */
  canary?: AutoReforgeCanaryOptions;
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
  canary?: AutoReforgeCanaryRecord;
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
  const involvedAgentIds = opts.involvedAgentIds.map(assertSafeAgentId);

  // 1. Curate learnings for all agents that ran in this cycle.
  const curationResult = await curate({
    projectRoot: opts.projectRoot,
    agentIds: involvedAgentIds,
  });

  // 2. Short-circuit if the curator produced nothing.
  const totalProposed = Object.values(curationResult.byAgent).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  if (totalProposed === 0) {
    return { cycleId: opts.cycleId, skipped: true, durationMs: Date.now() - startedAt };
  }

  // 3. Apply the proposed learnings via the mutator. In unattended cycles this
  // is staged as a rollbackable canary so bad self-modifications do not remain
  // active after YAML, model, or cost guardrails fail.
  const targetAgentIds = targetAgentsForCuration(curationResult);
  const canaryEnabled = opts.canary?.enabled === true && opts.dryRun !== true;
  const applyInput: ApplyLearningsInput = {
    projectRoot: opts.projectRoot,
    proposed: curationResult,
    dryRun: opts.dryRun ?? false,
  };
  const { mutatorReport, canary } = canaryEnabled
    ? await applyWithCanaryGuardrails({
        projectRoot: opts.projectRoot,
        cycleId: opts.cycleId,
        targetAgentIds,
        apply,
        applyInput,
        canary: opts.canary ?? {},
      })
    : { mutatorReport: await apply(applyInput), canary: undefined };

  // 4. Publish a bus event when a bus is provided.
  if (opts.bus && canary?.status !== 'rolled_back') {
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
    ...(canary ? { canary } : {}),
    durationMs: Date.now() - startedAt,
  };
}

async function persistMutatorInput(
  projectRoot: string,
  proposed: CurationResult,
): Promise<void> {
  const forgeDir = join(projectRoot, '.agentforge', 'forge');
  await mkdir(forgeDir, { recursive: true });
  await writeFile(
    join(forgeDir, 'learnings-proposed.json'),
    JSON.stringify(proposed.byAgent, null, 2),
    'utf8',
  );
}

interface ApplyWithCanaryInput {
  projectRoot: string;
  cycleId: string;
  targetAgentIds: string[];
  apply: (input: ApplyLearningsInput) => Promise<MutatorReport>;
  applyInput: ApplyLearningsInput;
  canary: AutoReforgeCanaryOptions;
}

async function applyWithCanaryGuardrails(
  input: ApplyWithCanaryInput,
): Promise<{ mutatorReport: MutatorReport; canary: AutoReforgeCanaryRecord }> {
  const startedAt = new Date().toISOString();
  const rollbackCostMultiplier = validateRollbackCostMultiplier(
    input.canary.rollbackCostMultiplier ?? 2,
  );
  const snapshots = await snapshotAgentFiles(input.projectRoot, input.targetAgentIds);
  const costBefore = await readOptionalCostMetrics(input.canary.readCostMetrics);

  let mutatorReport: MutatorReport;
  try {
    mutatorReport = await input.apply(input.applyInput);
  } catch (err) {
    await restoreAgentSnapshots(snapshots);
    throw err;
  }

  let costAfter: AutoReforgeCostMetrics | undefined;
  let rollbackReason: string | undefined;
  try {
    costAfter = await readOptionalCostMetrics(input.canary.readCostMetrics);
    rollbackReason =
      validateChangedAgentYaml(input.projectRoot, input.targetAgentIds) ??
      evaluateCostOutlier(costAfter, rollbackCostMultiplier);
  } catch (err) {
    rollbackReason = `Auto-rollback: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const baseRecord = {
    cycleId: input.cycleId,
    targetAgentIds: input.targetAgentIds,
    startedAt,
    completedAt: new Date().toISOString(),
    rollbackCostMultiplier,
    ...(costBefore ? { costBefore } : {}),
    ...(costAfter ? { costAfter } : {}),
  };

  if (rollbackReason) {
    await restoreAgentSnapshots(snapshots);
    const rolledBack: AutoReforgeCanaryRecord = {
      ...baseRecord,
      status: 'rolled_back',
      rollbackReason,
    };
    await writeCanaryRecord(input.projectRoot, rolledBack);
    return { mutatorReport, canary: rolledBack };
  }

  const promoted: AutoReforgeCanaryRecord = {
    ...baseRecord,
    status: 'promoted',
  };
  await writeCanaryRecord(input.projectRoot, promoted);
  return { mutatorReport, canary: promoted };
}

function targetAgentsForCuration(curationResult: CurationResult): string[] {
  return Object.entries(curationResult.byAgent)
    .filter(([, proposals]) => proposals.length > 0)
    .map(([agentId]) => assertSafeAgentId(agentId));
}

function validateRollbackCostMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error('auto-reforge canary rollbackCostMultiplier must be a finite positive number');
  }
  return multiplier;
}

async function readOptionalCostMetrics(
  reader: AutoReforgeCanaryOptions['readCostMetrics'],
): Promise<AutoReforgeCostMetrics | undefined> {
  if (!reader) return undefined;
  const metrics = await reader();
  if (!isFiniteNonNegative(metrics.currentCostUsd) || !isFinitePositive(metrics.projectedBudgetUsd)) {
    throw new Error('auto-reforge canary cost metrics must be finite and non-negative with a positive projected budget');
  }
  return metrics;
}

function evaluateCostOutlier(
  metrics: AutoReforgeCostMetrics | undefined,
  rollbackCostMultiplier: number,
): string | undefined {
  if (!metrics) return undefined;
  const limit = metrics.projectedBudgetUsd * rollbackCostMultiplier;
  if (metrics.currentCostUsd > limit) {
    return `Auto-rollback: current cost $${metrics.currentCostUsd.toFixed(2)} exceeds ` +
      `${rollbackCostMultiplier}x projected budget $${metrics.projectedBudgetUsd.toFixed(2)}`;
  }
  return undefined;
}

function validateChangedAgentYaml(projectRoot: string, agentIds: string[]): string | undefined {
  for (const agentId of agentIds) {
    const filePath = safeAgentYamlPath(projectRoot, agentId);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return `Auto-rollback: missing agent YAML for "${agentId}" after auto-reforge`;
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      return `Auto-rollback: invalid YAML for "${agentId}": ${err instanceof Error ? err.message : String(err)}`;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `Auto-rollback: agent YAML for "${agentId}" must be an object`;
    }
    const model = (parsed as { model?: unknown }).model;
    if (model !== 'opus' && model !== 'sonnet' && model !== 'haiku') {
      return `Auto-rollback: agent "${agentId}" must declare an explicit model tier`;
    }
  }
  return undefined;
}

interface AgentSnapshot {
  agentId: string;
  filePath: string;
  existed: boolean;
  content?: string;
}

async function snapshotAgentFiles(
  projectRoot: string,
  agentIds: string[],
): Promise<AgentSnapshot[]> {
  const snapshots: AgentSnapshot[] = [];
  for (const agentId of agentIds) {
    const filePath = safeAgentYamlPath(projectRoot, agentId);
    try {
      snapshots.push({
        agentId,
        filePath,
        existed: true,
        content: await readFile(filePath, 'utf8'),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      snapshots.push({ agentId, filePath, existed: false });
    }
  }
  return snapshots;
}

async function restoreAgentSnapshots(snapshots: AgentSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.existed) {
      await mkdir(dirname(snapshot.filePath), { recursive: true });
      await writeFile(snapshot.filePath, snapshot.content ?? '', 'utf8');
    } else {
      await rm(snapshot.filePath, { force: true });
    }
  }
}

async function writeCanaryRecord(
  projectRoot: string,
  record: AutoReforgeCanaryRecord,
): Promise<void> {
  const dir = join(projectRoot, '.agentforge', 'forge', 'auto-reforge-canaries');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${record.cycleId}.json`), JSON.stringify(record, null, 2), 'utf8');
}

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSafeAgentId(agentId: string): string {
  if (!SAFE_AGENT_ID.test(agentId)) {
    throw new Error(`Invalid agent id for auto-reforge: "${agentId}"`);
  }
  return agentId;
}

function safeAgentYamlPath(projectRoot: string, agentId: string): string {
  assertSafeAgentId(agentId);
  const agentsDir = resolve(projectRoot, '.agentforge', 'agents');
  const filePath = resolve(agentsDir, `${agentId}.yaml`);
  const rel = relative(agentsDir, filePath);
  if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`Agent path escapes .agentforge/agents for "${agentId}"`);
  }
  return filePath;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
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
