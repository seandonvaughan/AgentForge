// packages/core/src/memory/types.ts
//
// Rank-1 canonical schema for cross-cycle memory entries.
// All phase handlers that emit learning data import from here so the
// type never drifts between producers (gate, review, cycle-logger) and
// consumers (audit phase, flywheel dashboard).

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** All types of learning data a cycle phase can emit. */
export type MemoryEntryType =
  | 'cycle-outcome'
  | 'gate-verdict'
  | 'review-finding'
  | 'failure-pattern'
  | 'learned-fact';

/** Canonical shape of a cross-cycle memory entry. */
export interface CycleMemoryEntry {
  id: string;
  type: MemoryEntryType;
  /** Human-readable summary or serialised value. */
  value: string;
  createdAt: string; // ISO-8601
  /** cycleId or agentId that produced this entry. */
  source?: string;
  tags?: string[];
}

/**
 * Append a memory entry to `.agentforge/memory/<type>.jsonl`.
 *
 * The call is synchronous and non-fatal: if the write fails (e.g. read-only
 * filesystem in CI) the error is swallowed so the phase result is unaffected.
 *
 * Returns the completed entry (with generated id/createdAt) so callers can
 * log or assert on it in tests.
 */
export function writeMemoryEntry(
  projectRoot: string,
  entry: Omit<CycleMemoryEntry, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: string;
  },
): CycleMemoryEntry {
  const full: CycleMemoryEntry = {
    id: entry.id ?? randomUUID(),
    type: entry.type,
    value: entry.value,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
  };

  try {
    const memoryDir = join(projectRoot, '.agentforge', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    appendFileSync(join(memoryDir, `${full.type}.jsonl`), JSON.stringify(full) + '\n', 'utf8');
  } catch {
    // non-fatal — phase result must not be affected by memory write failures
  }

  return full;
}

/**
 * Read the N most-recent memory entries of a given type from the JSONL store.
 * Returns an empty array if the file is absent or unreadable.
 */
export function readMemoryEntries(
  projectRoot: string,
  type: MemoryEntryType,
  limit = 10,
): CycleMemoryEntry[] {
  try {
    const filePath = join(projectRoot, '.agentforge', 'memory', `${type}.jsonl`);
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as CycleMemoryEntry);
  } catch {
    return [];
  }
}
