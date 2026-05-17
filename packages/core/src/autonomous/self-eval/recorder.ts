// packages/core/src/autonomous/self-eval/recorder.ts
//
// Appends a SelfEvalRecord to .agentforge/memory/self-eval.jsonl using
// the same lock-protected atomic-append pattern used by writeMemoryEntry()
// in packages/core/src/memory/types.ts.
//
// Workstream T2.6 — Cycle 2 / v19.0.0.

import { appendFileSync, closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SelfEvalRecord } from './types.js';

const SELF_EVAL_FILE = 'self-eval.jsonl';

export interface RecordSelfEvalOpts {
  projectRoot: string;
  record: SelfEvalRecord;
}

/**
 * Append a SelfEvalRecord to `.agentforge/memory/self-eval.jsonl`.
 *
 * Uses an advisory lock file (<path>.lock) so concurrent agents do not
 * interleave partial writes.  The function is async to keep the public API
 * future-compatible with async I/O backends, but the current implementation
 * uses synchronous Node.js fs calls (same pattern as writeMemoryEntry).
 *
 * Throws on I/O errors — callers (execute-phase-handler) should catch and
 * treat as non-fatal if desired.
 */
export async function recordSelfEval(opts: RecordSelfEvalOpts): Promise<void> {
  const { projectRoot, record } = opts;

  const memoryDir = join(projectRoot, '.agentforge', 'memory');
  mkdirSync(memoryDir, { recursive: true });

  const filePath = join(memoryDir, SELF_EVAL_FILE);
  const lockPath = filePath + '.lock';

  const locked = acquireLock(lockPath);
  try {
    appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  } finally {
    if (locked) releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Internal lock helpers (mirrors memory/types.ts pattern)
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
