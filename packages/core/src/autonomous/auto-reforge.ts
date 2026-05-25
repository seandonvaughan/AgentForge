// packages/core/src/autonomous/auto-reforge.ts
//
// T2.3 — Auto-reforge hook: after gate approval, run the learning-curator
// + mutator so the agents that ran in this cycle absorb the new lessons.
//
// Workstreams P and Q own the actual curateLearnings / applyLearnings
// implementations. This module stubs those imports with the expected contract
// so the cycle-runner integration and tests can run without those modules
// being present yet. When P+Q land, swap the stubs for the real imports.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  skipReason?: 'no-involved-agents' | 'no-proposed-learnings';
  mutatorReport?: MutatorReport;
  durationMs: number;
}

export interface AutoReforgeReport {
  cycleId: string;
  generatedAt: string;
  involvedAgentIds: string[];
  sourcesScanned: Array<{ path: string; entriesRead: number; scored: number }>;
  sourceCounts: { entriesRead: number; scored: number };
  proposalCounts: { beforeFiltering: number; afterFiltering?: number };
  appliedCount: number;
  skippedProposalCount?: number;
  skipReason?: 'no-involved-agents' | 'no-proposed-learnings';
  dryRun: boolean;
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

  if (opts.involvedAgentIds.length === 0) {
    const durationMs = Date.now() - startedAt;
    persistAutoReforgeReport(opts.projectRoot, {
      cycleId: opts.cycleId,
      generatedAt: new Date().toISOString(),
      involvedAgentIds: [],
      sourcesScanned: [],
      sourceCounts: { entriesRead: 0, scored: 0 },
      proposalCounts: { beforeFiltering: 0 },
      appliedCount: 0,
      skipReason: 'no-involved-agents',
      dryRun: opts.dryRun ?? false,
      durationMs,
    });
    if (opts.bus) {
      opts.bus.publish('learnings.skipped', {
        cycleId: opts.cycleId,
        reason: 'no-involved-agents',
        totalProposed: 0,
        involvedAgentIds: [],
        generatedAt: new Date().toISOString(),
        sourcesScanned: [],
      });
    }
    return {
      cycleId: opts.cycleId,
      skipped: true,
      skipReason: 'no-involved-agents',
      durationMs,
    };
  }

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
    const durationMs = Date.now() - startedAt;
    persistAutoReforgeReport(opts.projectRoot, buildAutoReforgeReport({
      cycleId: opts.cycleId,
      involvedAgentIds: opts.involvedAgentIds,
      curationResult,
      dryRun: opts.dryRun ?? false,
      durationMs,
      skipReason: 'no-proposed-learnings',
    }));
    if (opts.bus) {
      opts.bus.publish('learnings.skipped', {
        cycleId: opts.cycleId,
        reason: 'no-proposed-learnings',
        totalProposed,
        involvedAgentIds: [...opts.involvedAgentIds],
        generatedAt: curationResult.generatedAt,
        sourcesScanned: curationResult.sourcesScanned,
      });
    }
    return {
      cycleId: opts.cycleId,
      skipped: true,
      skipReason: 'no-proposed-learnings',
      durationMs,
    };
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

  const durationMs = Date.now() - startedAt;
  persistAutoReforgeReport(opts.projectRoot, buildAutoReforgeReport({
    cycleId: opts.cycleId,
    involvedAgentIds: opts.involvedAgentIds,
    curationResult,
    mutatorReport,
    dryRun: opts.dryRun ?? false,
    durationMs,
  }));

  return {
    cycleId: opts.cycleId,
    skipped: false,
    mutatorReport,
    durationMs,
  };
}

function buildAutoReforgeReport(input: {
  cycleId: string;
  involvedAgentIds: string[];
  curationResult: CurationResult;
  mutatorReport?: MutatorReport;
  dryRun: boolean;
  durationMs: number;
  skipReason?: AutoReforgeReport['skipReason'];
}): AutoReforgeReport {
  const sourceCounts = input.curationResult.sourcesScanned.reduce(
    (acc, source) => ({
      entriesRead: acc.entriesRead + source.entriesRead,
      scored: acc.scored + source.scored,
    }),
    { entriesRead: 0, scored: 0 },
  );
  const totalProposed = countProposedLearnings(input.curationResult);
  const report: AutoReforgeReport = {
    cycleId: input.cycleId,
    generatedAt: new Date().toISOString(),
    involvedAgentIds: [...input.involvedAgentIds],
    sourcesScanned: input.curationResult.sourcesScanned,
    sourceCounts,
    proposalCounts: { beforeFiltering: totalProposed },
    appliedCount: input.mutatorReport?.totalApplied ?? 0,
    dryRun: input.dryRun,
    durationMs: input.durationMs,
  };

  if (input.mutatorReport) {
    report.proposalCounts.afterFiltering = input.mutatorReport.totalApplied;
    report.skippedProposalCount = input.mutatorReport.totalSkipped;
  }
  if (input.skipReason) {
    report.skipReason = input.skipReason;
  }
  return report;
}

function countProposedLearnings(curationResult: CurationResult): number {
  return Object.values(curationResult.byAgent).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
}

function persistAutoReforgeReport(
  projectRoot: string,
  report: AutoReforgeReport,
): void {
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', report.cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, 'auto-reforge-report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
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
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  const execPath = join(
    cycleDir,
    'phases',
    'execute.json',
  );
  const executeIds = extractAgentIdsFromExecuteJson(execPath);
  if (executeIds.length > 0) return executeIds;

  const planIds = extractAgentIdsFromPlanJson(join(cycleDir, 'plan.json'));
  if (planIds.length > 0) return planIds;

  const eventIds = extractAgentIdsFromEventsJsonl(join(cycleDir, 'events.jsonl'));
  if (eventIds.length > 0) return eventIds;

  return extractAgentIdsFromAssignJson(join(cycleDir, 'phases', 'assign.json'));
}

function extractAgentIdsFromExecuteJson(execPath: string): string[] {
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

function extractAgentIdsFromPlanJson(planPath: string): string[] {
  const data = readJsonObject(planPath);
  if (!data) return [];
  const items = collectPlanItems(data);
  return uniqueStrings(
    items.flatMap((item) => [
      stringField(item, 'assignee'),
      stringField(item, 'agentId'),
      stringField(item, 'assignedAgent'),
      assignmentHintAgentId(item),
    ]),
  );
}

function collectPlanItems(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const directItems = arrayOfObjects(data['items']);
  const sprintItems = arrayOfObjects(data['sprints']).flatMap((sprint) =>
    arrayOfObjects(sprint['items']),
  );
  return [...directItems, ...sprintItems];
}

function extractAgentIdsFromEventsJsonl(eventsPath: string): string[] {
  if (!existsSync(eventsPath)) return [];
  const ids: string[] = [];
  try {
    const raw = readFileSync(eventsPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        for (const record of collectRunRecords(event)) {
          ids.push(
            ...[
              stringField(record, 'agentId'),
              stringField(record, 'assignee'),
              stringField(record, 'assignedAgent'),
            ].filter((id): id is string => id !== undefined),
          );
        }
      } catch {
        // Ignore partial JSONL writes.
      }
    }
  } catch {
    return [];
  }
  return uniqueStrings(ids);
}

function collectRunRecords(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const payloads = [
    event,
    objectField(event, 'payload'),
    objectField(event, 'result'),
    objectField(objectField(event, 'payload'), 'result'),
  ].filter((value): value is Record<string, unknown> => value !== undefined);

  return payloads.flatMap((payload) => [
    ...arrayOfObjects(payload['agentRuns']),
    ...arrayOfObjects(payload['itemResults']),
  ]);
}

function extractAgentIdsFromAssignJson(assignPath: string): string[] {
  const data = readJsonObject(assignPath);
  if (!data) return [];

  const byAgent = objectField(data, 'byAgent');
  const byAgentIds = byAgent ? Object.keys(byAgent) : [];
  const assignments = arrayOfObjects(data['assignments']);
  return uniqueStrings([
    ...byAgentIds,
    ...assignments.flatMap((assignment) => [
      stringField(assignment, 'agentId'),
      stringField(assignment, 'assignee'),
      stringField(assignment, 'assignedAgent'),
    ]),
  ]);
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    )
    : [];
}

function objectField(
  obj: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj?.[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function assignmentHintAgentId(item: Record<string, unknown>): string | undefined {
  const hint = objectField(item, 'assignment_hint');
  return hint ? stringField(hint, 'agent_id') : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}
