// packages/core/src/memory/lesson-attribution.ts
//
// Append-only writer + reader for lesson-attribution entries.
// Mirrors the lock + appendFileSync pattern from memory/types.ts writeMemoryEntry.
// Does NOT extend the closed MemoryEntryType union.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A lesson-attribution record written by execute-phase (initial) and then
 * augmented with cycle-level gate/verify verdicts by gate-phase and
 * verify-phase.
 *
 * Gate verdict and verify outcome are cycle-scoped (not per-item) — they are
 * recorded as-is with `scope:'cycle'` to mark this honesty constraint.
 *
 * Conditional-spread rules (exactOptionalPropertyTypes: true):
 *   - NEVER assign a literal `undefined` to `gateVerdict` or `verifyPassed`.
 *   - Use `...(x !== undefined ? { gateVerdict: x } : {})` at all call sites.
 */
export interface LessonAttributionEntry {
  id: string;                              // randomUUID()
  cycleId: string;
  itemId: string;
  agentId: string;
  lessonId: string;                        // computeLessonId(lessonText)
  lessonText: string;
  gateVerdict?: 'approved' | 'rejected';   // cycle-scoped, filled at gate (conditional-spread)
  verifyPassed?: boolean;                  // cycle-scoped, filled at verify (conditional-spread)
  scope: 'cycle';                          // honesty marker — gate/verify are cycle-scoped
  ts: string;                              // ISO-8601
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const ATTRIBUTION_FILE = 'lesson-attribution.jsonl';

function getAttributionPath(projectRoot: string): string {
  return join(projectRoot, '.agentforge', 'memory', ATTRIBUTION_FILE);
}

function getLockPath(projectRoot: string): string {
  return getAttributionPath(projectRoot) + '.lock';
}

// ---------------------------------------------------------------------------
// Lock helpers (mirrors memory/types.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Append one or more lesson-attribution rows to
 * `.agentforge/memory/lesson-attribution.jsonl`.
 *
 * Each row is stamped with a fresh `id` (UUID) and `ts` (ISO) at write time.
 * The call is synchronous and non-fatal: if the write fails (e.g. read-only
 * filesystem in CI) the error is swallowed so the phase result is unaffected.
 * A simple exclusive lock file is held during the write to prevent interleaved
 * appends from parallel agent processes.
 */
export function appendLessonAttributions(
  projectRoot: string,
  rows: Omit<LessonAttributionEntry, 'id' | 'ts'>[],
): void {
  if (rows.length === 0) return;

  try {
    const memoryDir = join(projectRoot, '.agentforge', 'memory');
    mkdirSync(memoryDir, { recursive: true });

    const filePath = getAttributionPath(projectRoot);
    const lockPath = getLockPath(projectRoot);
    const locked = acquireLock(lockPath);
    try {
      const now = new Date().toISOString();
      const lines = rows.map((row) => {
        const entry: LessonAttributionEntry = {
          ...row,
          id: randomUUID(),
          ts: now,
        };
        return JSON.stringify(entry);
      });
      appendFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    } finally {
      if (locked) releaseLock(lockPath);
    }
  } catch (err) {
    // non-fatal — phase result must not be affected by attribution write failures
    console.warn('[lesson-attribution] Failed to append rows', err);
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Read all lesson-attribution entries from
 * `.agentforge/memory/lesson-attribution.jsonl`.
 * Returns an empty array if the file is absent or unreadable.
 * Malformed lines are silently skipped.
 */
export function readLessonAttributions(projectRoot: string): LessonAttributionEntry[] {
  try {
    const filePath = getAttributionPath(projectRoot);
    const raw = readFileSync(filePath, 'utf8');
    const results: LessonAttributionEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed) as LessonAttributionEntry);
      } catch {
        // malformed line — skip
      }
    }
    return results;
  } catch {
    return [];
  }
}
