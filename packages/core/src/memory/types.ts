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

/**
 * Structured payload for `gate-verdict` entries.
 *
 * Written by GatePhaseHandler at the end of each sprint gate phase.
 * Read by AuditPhaseHandler at the start of the next cycle to detect
 * recurring failure patterns and avoid repeating prior mistakes.
 */
export interface GateVerdictMetadata {
  /** Cycle identifier — matches the sprintId used by AutonomousSprintFramework. */
  cycleId: string;
  /** The gate decision for this cycle. */
  verdict: 'approved' | 'rejected' | 'pending';
  /** Human-readable explanation of why the verdict was reached. */
  rationale: string;
  /** CRITICAL-severity findings that contributed to the gate decision. */
  criticalFindings: string[];
  /** MAJOR-severity findings that contributed to the gate decision. */
  majorFindings: string[];
}

/** Canonical shape of a cross-cycle memory entry.
 *
 *  This is the **write-side** contract: any entry produced via
 *  `writeMemoryEntry` is guaranteed to satisfy this shape, including a
 *  non-empty `id` and `createdAt`. Consumers that parse JSONL files from
 *  disk should use `ParsedMemoryEntry` instead, which is permissive about
 *  legacy entries that may predate the canonical invariants.
 */
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
   * For `gate-verdict` entries this is a `GateVerdictMetadata` object.
   */
  metadata?: ReviewFindingMetadata | GateVerdictMetadata | Record<string, unknown>;
}

/**
 * Permissive **read-side** shape for entries parsed from JSONL files.
 *
 * Unlike `CycleMemoryEntry`, this type does not require `id` or
 * `createdAt` and widens `type` to `string`. This exists because:
 *
 *  1. Legacy memory files written before the `id: string` invariant was
 *     enforced may have entries that only carry a human-readable `key`.
 *  2. Test fixtures and backlog generators sometimes produce entries with
 *     a short slug (`key`) instead of a UUID.
 *  3. Forward-compatibility: a newer cycle may write a `type` the current
 *     reader has not been updated for — we want to parse and surface it
 *     rather than drop the line.
 *
 * **Producers should always use `CycleMemoryEntry`** via `writeMemoryEntry`
 * to guarantee `id` is present. Readers that need to render or filter
 * historical data should prefer `ParsedMemoryEntry` so they can tolerate
 * legacy shapes without weakening the write-side contract.
 */
export interface ParsedMemoryEntry {
  /** UUID produced by writeMemoryEntry (canonical). May be absent on legacy entries. */
  id?: string;
  /** Short slug used by backlog generators and test fixtures. */
  key?: string;
  /** Widened to `string` for forward-compat with new types added in later cycles. */
  type: string;
  value: string;
  createdAt?: string;
  source?: string;
  tags?: string[];
  /** Preserved on parse but typed as `unknown` because legacy entries may
   *  carry arbitrary payload shapes. Narrow at the use site with a guard. */
  metadata?: unknown;
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
 * Input shape for `writeMemoryEntry`.
 *
 * Intentionally widens every optional field to `T | undefined` so that
 * callers under `exactOptionalPropertyTypes: true` can pass values derived
 * from expressions like `rootCause ?? undefined` without hitting TS2379.
 * The helper normalises these to a sparse `CycleMemoryEntry` output where
 * absent fields are omitted entirely (not set to `undefined`).
 *
 * Keeping the input type here — rather than inline on the function
 * signature — ensures call sites can import it and annotate their own
 * builders in a forward-compatible way.
 */
export interface WriteMemoryEntryInput {
  /** Caller-supplied UUID; defaults to `randomUUID()` when omitted. */
  id?: string | undefined;
  /** Human-readable lookup key (e.g. "gate-v6.5-result"). */
  key?: string | undefined;
  type: MemoryEntryType;
  value: string;
  /** ISO-8601 timestamp; defaults to `new Date().toISOString()` when omitted. */
  createdAt?: string | undefined;
  /** cycleId or agentId that produced this entry. */
  source?: string | undefined;
  tags?: string[] | undefined;
  /** Structured payload — see ReviewFindingMetadata / GateVerdictMetadata. */
  metadata?:
    | ReviewFindingMetadata
    | GateVerdictMetadata
    | Record<string, unknown>
    | undefined;
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
  entry: WriteMemoryEntryInput,
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
