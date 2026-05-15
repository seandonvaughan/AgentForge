/**
 * Shared cycle-record reader for the AgentForge workspace.
 *
 * Canonical source of truth for `CycleRecord` and `readCycleRecord`.  Both the
 * server package (packages/server/src/lib/cycle-record.ts, which re-exports
 * from here) and the SvelteKit dashboard package
 * (packages/dashboard/src/routes/flywheel/+page.server.ts) consume this module
 * so there is a single implementation to maintain.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── CycleRecord ────────────────────────────────────────────────────────────

/**
 * The normalised in-memory representation of one autonomous cycle.
 * Fields are optional because not every cycle reaches every milestone (e.g. a
 * cycle aborted before tests run will have no `tests` entry).
 */
export interface CycleRecord {
  cycleId: string;
  sprintVersion?: string | undefined;
  stage?: string | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
  cost?: { totalUsd?: number; budgetUsd?: number } | undefined;
  tests?: { passed?: number; failed?: number; total?: number; passRate?: number } | undefined;
  git?: { branch?: string; commitSha?: string; filesChanged?: string[] } | undefined;
  pr?: { url?: string | null; number?: number | null } | undefined;
}

// ── Internal types ─────────────────────────────────────────────────────────

interface CycleEvent { type: string; at?: string; [key: string]: unknown }

// ── readCycleRecord ────────────────────────────────────────────────────────

/**
 * Read a CycleRecord from a cycle directory.
 *
 * Supports two on-disk formats:
 *  - Legacy (cycles-archived/): has `cycle.json` with the full record shape.
 *  - Current (cycles/): no `cycle.json`; data is spread across `events.jsonl`
 *    and `sprint-link.json`. We reconstruct the CycleRecord from the event
 *    stream so metric computation works correctly for all recent cycles.
 *
 * Returns `null` when the directory contains no recognisable cycle data.
 */
export function readCycleRecord(cycleDir: string, cycleId: string): CycleRecord | null {
  // ── Legacy format: cycle.json present ──────────────────────────────────
  const cycleFile = join(cycleDir, 'cycle.json');
  if (existsSync(cycleFile)) {
    try {
      return JSON.parse(readFileSync(cycleFile, 'utf-8')) as CycleRecord;
    } catch { /* fall through to event-stream reader */ }
  }

  // ── Current format: reconstruct from events.jsonl ──────────────────────
  const eventsFile = join(cycleDir, 'events.jsonl');
  if (!existsSync(eventsFile)) return null;

  let events: CycleEvent[];
  try {
    events = readFileSync(eventsFile, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l) as CycleEvent);
  } catch { return null; }

  const find = (type: string | string[]) => {
    const types = Array.isArray(type) ? type : [type];
    return events.find(e => types.includes(e.type));
  };

  const sprintAssigned = find('sprint.assigned');
  const scoring        = find('scoring.complete');
  const testsEvt       = find('tests.complete');
  const prEvt          = find(['pr.opened', 'opened']);
  const complete       = find('cycle.complete');
  const firstPhase     = find('phase.start');

  // sprintVersion: prefer events, fall back to sprint-link.json
  let sprintVersion: string | undefined =
    (sprintAssigned?.sprintVersion as string | undefined);
  if (!sprintVersion) {
    const linkFile = join(cycleDir, 'sprint-link.json');
    if (existsSync(linkFile)) {
      try {
        const link = JSON.parse(readFileSync(linkFile, 'utf-8')) as { sprintVersion?: string };
        sprintVersion = link.sprintVersion;
      } catch { /* ignore */ }
    }
  }

  const startedAt   = (firstPhase?.at ?? sprintAssigned?.at) as string | undefined;
  const completedAt = (complete?.at) as string | undefined;
  const durationMs  = startedAt && completedAt
    ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
    : undefined;

  const passed   = testsEvt?.passed as number | undefined;
  const failed   = testsEvt?.failed as number | undefined;
  const total    = passed != null && failed != null ? passed + failed : undefined;
  const passRate = total != null && total > 0 ? passed! / total : undefined;

  return {
    cycleId,
    sprintVersion,
    stage: (complete?.stage as string | undefined) ?? (complete ? 'completed' : undefined),
    startedAt,
    completedAt,
    durationMs,
    cost: scoring && typeof scoring.totalCostUsd === 'number'
      ? { totalUsd: scoring.totalCostUsd as number }
      : undefined,
    tests: total != null && typeof passed === 'number' && typeof failed === 'number'
      ? { passed, failed, total, passRate: typeof passRate === 'number' ? passRate : 0 }
      : undefined,
    pr: prEvt
      ? { url: prEvt.url as string | null, number: prEvt.number as number | null }
      : undefined,
  };
}
