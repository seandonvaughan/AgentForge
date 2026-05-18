/**
 * cycle-jobs-ledger.ts
 *
 * Reads `.agentforge/cycles/<cycleId>/phases/execute.json` files on disk and
 * produces `LedgerJobRow` objects so the jobs and sessions endpoints can surface
 * real execution history without requiring SQL rows.
 *
 * Each `agentRun` (or `itemResult`) entry in the execute.json becomes one
 * synthetic job row.  Timing falls back to the parent cycle's first/last event
 * timestamp when the per-item field is absent.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Public contract (shared with jobs.ts and index.ts sessions handler)
// ---------------------------------------------------------------------------

export interface LedgerJobRow {
  id: string;        // == itemId
  cycleId: string;
  agentId: string;
  status: 'succeeded' | 'failed';
  startedAt: string;
  completedAt: string;
  costUsd: number;
  attempts: number;
  response: string;  // first 2000 chars preview
}

// ---------------------------------------------------------------------------
// Internal types that mirror the on-disk shape
// ---------------------------------------------------------------------------

interface AgentRunEntry {
  itemId?: unknown;
  status?: unknown;
  costUsd?: unknown;
  durationMs?: unknown;
  response?: unknown;
  attempts?: unknown;
  agentId?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

interface ExecuteJson {
  phase?: unknown;
  status?: unknown;
  durationMs?: unknown;
  costUsd?: unknown;
  agentRuns?: unknown;
  itemResults?: unknown;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function safeInsideBase(base: string, ...parts: string[]): string | null {
  const resolved = resolve(join(base, ...parts));
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (resolved !== base && !resolved.startsWith(baseWithSep)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function readJsonSafe(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Read the first (cycle_started) or last (cycle_completed) `at` field from
 * events.jsonl to derive cycle-level timing when per-item timing is absent.
 */
function readCycleTiming(cycleDir: string): { startedAt: string; completedAt: string } {
  const eventsFile = join(cycleDir, 'events.jsonl');
  const fallback = new Date().toISOString();

  if (!existsSync(eventsFile)) return { startedAt: fallback, completedAt: fallback };

  let firstAt: string | null = null;
  let lastAt: string | null = null;

  try {
    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        const at = typeof ev['at'] === 'string' ? ev['at'] : null;
        if (at) {
          if (firstAt === null) firstAt = at;
          lastAt = at;
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* file unreadable */ }

  return {
    startedAt: firstAt ?? fallback,
    completedAt: lastAt ?? firstAt ?? fallback,
  };
}

/**
 * Convert one agentRun/itemResult entry from execute.json into a LedgerJobRow.
 * Falls back to cycle-level timing when per-item timestamps are absent.
 */
function entryToRow(
  entry: AgentRunEntry,
  cycleId: string,
  cycleTiming: { startedAt: string; completedAt: string },
): LedgerJobRow | null {
  const itemId = typeof entry.itemId === 'string' ? entry.itemId : null;
  const agentId = typeof entry.agentId === 'string' ? entry.agentId : 'unknown';

  if (!itemId) return null;

  // Normalise status: execute.json uses "completed" / "failed"; we expose "succeeded" / "failed"
  const rawStatus = typeof entry.status === 'string' ? entry.status : 'completed';
  const status: 'succeeded' | 'failed' = rawStatus === 'failed' ? 'failed' : 'succeeded';

  const costUsd = typeof entry.costUsd === 'number' ? entry.costUsd : 0;
  const attempts = typeof entry.attempts === 'number' ? entry.attempts : 1;

  const rawResponse = typeof entry.response === 'string' ? entry.response : '';
  const response = rawResponse.length > 2000 ? rawResponse.slice(0, 2000) : rawResponse;

  const startedAt =
    typeof entry.startedAt === 'string' ? entry.startedAt : cycleTiming.startedAt;
  const completedAt =
    typeof entry.completedAt === 'string' ? entry.completedAt : cycleTiming.completedAt;

  return { id: itemId, cycleId, agentId, status, startedAt, completedAt, costUsd, attempts, response };
}

/**
 * Read all LedgerJobRows from a single cycle directory.
 * Returns an empty array when execute.json is absent or malformed.
 */
function readLedgerRowsForCycle(cyclesBase: string, cycleId: string): LedgerJobRow[] {
  // Path safety: cycleId must stay inside cyclesBase
  const cycleDir = safeInsideBase(cyclesBase, cycleId);
  if (!cycleDir) return [];

  const executeFile = join(cycleDir, 'phases', 'execute.json');
  if (!existsSync(executeFile)) return [];

  const raw = readJsonSafe(executeFile);
  if (!raw || typeof raw !== 'object') return [];

  const data = raw as ExecuteJson;

  // Prefer itemResults; fall back to agentRuns (same shape, different key name)
  const runs = Array.isArray(data.itemResults)
    ? (data.itemResults as AgentRunEntry[])
    : Array.isArray(data.agentRuns)
      ? (data.agentRuns as AgentRunEntry[])
      : [];

  if (runs.length === 0) return [];

  const cycleTiming = readCycleTiming(cycleDir);

  const rows: LedgerJobRow[] = [];
  for (const entry of runs) {
    const row = entryToRow(entry, cycleId, cycleTiming);
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan every cycle directory under `cyclesBase` and return all LedgerJobRows.
 *
 * @param cyclesBase  Absolute path to `.agentforge/cycles/`
 */
export function readAllLedgerJobs(cyclesBase: string): LedgerJobRow[] {
  if (!existsSync(cyclesBase)) return [];

  let cycleIds: string[];
  try {
    cycleIds = readdirSync(cyclesBase);
  } catch {
    return [];
  }

  const rows: LedgerJobRow[] = [];
  for (const entry of cycleIds) {
    // Only descend into UUID-shaped directories; skip files and dotfiles
    if (!entry || entry.startsWith('.')) continue;
    const rows2 = readLedgerRowsForCycle(cyclesBase, entry);
    for (const r of rows2) rows.push(r);
  }
  return rows;
}

/**
 * Read LedgerJobRows for one specific cycle.
 *
 * @param cyclesBase  Absolute path to `.agentforge/cycles/`
 * @param cycleId     UUID of the cycle to read
 */
export function readLedgerJobsForCycle(cyclesBase: string, cycleId: string): LedgerJobRow[] {
  return readLedgerRowsForCycle(cyclesBase, cycleId);
}

/**
 * Look up a single LedgerJobRow by itemId across all cycles.
 *
 * Linear scan — acceptable because cycles are O(hundreds) and this is
 * used only by the `:jobId` detail endpoint.
 */
export function findLedgerJobById(cyclesBase: string, jobId: string): LedgerJobRow | null {
  if (!existsSync(cyclesBase)) return null;

  let cycleIds: string[];
  try {
    cycleIds = readdirSync(cyclesBase);
  } catch {
    return null;
  }

  for (const entry of cycleIds) {
    if (!entry || entry.startsWith('.')) continue;
    const rows = readLedgerRowsForCycle(cyclesBase, entry);
    // Use String.includes() not regex — CLAUDE.md lesson 6
    const found = rows.find(r => r.id === jobId);
    if (found) return found;
  }
  return null;
}

/**
 * Return the path to the `cycles` directory for a given project root.
 * Convenience helper so callers don't need to reconstruct the path.
 */
export function cyclesBaseDirFor(projectRoot: string): string {
  return resolve(join(projectRoot, '.agentforge', 'cycles'));
}
