// packages/core/src/memory/types.ts
//
// Rank-1 canonical schema for cross-cycle memory entries.
// All phase handlers that emit learning data import from here so the
// type never drifts between producers (gate, review, cycle-logger) and
// consumers (audit phase, flywheel dashboard).

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** All types of learning data a cycle phase can emit. */
export type MemoryEntryType =
  | 'cycle-outcome'
  | 'gate-verdict'
  | 'review-finding'
  | 'failure-pattern'
  | 'learned-fact';

/**
 * Structured payload for `review-finding` entries.
 * Populated on a best-effort basis from the reviewer agent's markdown output.
 * All fields except `severity` and `summary` may be null when the reviewer
 * did not include explicit file/line/fix information.
 */
export interface ReviewFindingMetadata {
  /** Relative file path that the finding relates to, or null if not parseable. */
  file: string | null;
  /** Line number within `file`, or null if not specified. */
  line: number | null;
  /** Severity level that triggered the memory write. */
  severity: 'CRITICAL' | 'MAJOR';
  /** The finding description, with severity prefix and file/line info stripped. */
  summary: string;
  /** Suggested remediation extracted from the finding text, or null if absent. */
  fixSuggestion: string | null;
}

/** Canonical shape of a cross-cycle memory entry. */
export interface CycleMemoryEntry {
  id: string;
  /** Human-readable lookup key (e.g. "gate-v6.5-result"). Unlike `id`, this
   *  is chosen by the caller and intended for querying by name. */
  key?: string;
  type: MemoryEntryType;
  /** Human-readable summary or serialised value. */
  value: string;
  createdAt: string; // ISO-8601
  /** cycleId or agentId that produced this entry. */
  source?: string;
  tags?: string[];
  /**
   * Structured payload for entries that carry machine-readable data.
   * For `review-finding` entries this is a `ReviewFindingMetadata` object.
   * Other entry types may define their own metadata shapes in the future.
   */
  metadata?: ReviewFindingMetadata | Record<string, unknown>;
}

/**
 * Acquire a simple exclusive lock file.  Returns `true` if the lock was
 * obtained (and must be released), `false` if locking failed (write should
 * still proceed best-effort without the lock).
 */
function acquireLock(lockPath: string): boolean {
  try {
    // O_CREAT | O_EXCL: atomic create-if-absent — fails if lock already held.
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

/**
 * Append a memory entry to `.agentforge/memory/<type>.jsonl`.
 *
 * The call is synchronous and non-fatal: if the write fails (e.g. read-only
 * filesystem in CI) the error is swallowed so the phase result is unaffected.
 * A simple exclusive lock file (`<type>.jsonl.lock`) is held during the write
 * to prevent interleaved appends from parallel agent processes.
 *
 * Returns the completed entry (with generated id/createdAt) so callers can
 * log or assert on it in tests.
 */
export function writeMemoryEntry(
  projectRoot: string,
  entry: Omit<CycleMemoryEntry, 'id' | 'createdAt'> & {
    id?: string;
    key?: string;
    createdAt?: string;
  },
): CycleMemoryEntry {
  const full: CycleMemoryEntry = {
    id: entry.id ?? randomUUID(),
    ...(entry.key !== undefined ? { key: entry.key } : {}),
    type: entry.type,
    value: entry.value,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  };

  try {
    const memoryDir = join(projectRoot, '.agentforge', 'memory');
    mkdirSync(memoryDir, { recursive: true });

    const filePath = join(memoryDir, `${full.type}.jsonl`);
    const lockPath = filePath + '.lock';
    const locked = acquireLock(lockPath);
    try {
      appendFileSync(filePath, JSON.stringify(full) + '\n', 'utf8');
    } finally {
      if (locked) releaseLock(lockPath);
    }
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
