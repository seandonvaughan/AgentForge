// packages/core/src/scoring/jsonl-writer.ts
//
// Atomic JSONL append for step-score records.
//
// Writes to a `.tmp` file, fsyncs, then renames over the target — the same
// durability pattern used by cycle-checkpoint.ts (Wave 3).
//
// CodeQL js/path-injection: cycleId embedded in filePath is validated
// match-then-use against /^[a-zA-Z0-9-]{8,64}$/ before the join call.
//
// This module is intentionally non-throwing: EACCES / ENOSPC and all other
// IO errors are swallowed so a filesystem fault never blocks a cycle.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { StepScore } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Path sanitisation (match-then-use, mirrors cycle-checkpoint.ts)
// ---------------------------------------------------------------------------

const CYCLE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * Returns a validated cycleId extracted from a step-scores.jsonl file path.
 * The path is expected to contain `.agentforge/memory/step-scores.jsonl`.
 *
 * We only care that the path references the canonical step-scores file and
 * that any embedded cycleId segment is safe. Throws on any mismatch so the
 * caller swallows and continues the cycle.
 */
function validateFilePath(filePath: string): string {
  // Require the canonical file name.
  if (!filePath.includes('step-scores.jsonl')) {
    throw new Error('[jsonl-writer] filePath must reference step-scores.jsonl');
  }
  // Extract the cycleId from the path when present (between "cycles/" and the
  // next path separator). Falls back to a synthetic safe token when the memory/
  // path is used directly (no cycleId in path).
  const cycleMatch = /[\\/]cycles[\\/]([^\\/]+)[\\/]/.exec(filePath);
  if (cycleMatch) {
    const raw = cycleMatch[1]!;
    const m = CYCLE_ID_RE.exec(raw);
    if (!m) {
      throw new Error('[jsonl-writer] invalid cycleId segment in filePath');
    }
    // Return the match (sanitized value) — not the raw caller string.
    return join(dirname(filePath), m[0], 'step-scores.jsonl');
  }
  // Path is under .agentforge/memory/ directly (standard case).
  // Reconstruct from dirname to avoid passing raw user string to join.
  const safeDir = dirname(filePath);
  return join(safeDir, 'step-scores.jsonl');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically append one or more StepScore records to a JSONL file.
 *
 * Each record is serialised as a single JSON line. The write is atomic:
 * we read the current file (if any), append the new lines, write to a `.tmp`
 * file, fsync, then rename over the target.
 *
 * Returns silently on EACCES / ENOSPC or any other IO error — scoring is
 * non-load-bearing and must never block or fail the cycle.
 */
export async function appendStepScore(
  scoreOrScores: StepScore | StepScore[],
  filePath: string,
): Promise<void> {
  let safePath: string;
  try {
    safePath = validateFilePath(filePath);
  } catch {
    // Invalid path — swallow.
    return;
  }

  const scores = Array.isArray(scoreOrScores) ? scoreOrScores : [scoreOrScores];
  if (scores.length === 0) return;

  try {
    mkdirSync(dirname(safePath), { recursive: true });

    // Read existing content (may be empty / absent).
    let existing = '';
    try {
      existing = readFileSync(safePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err; // re-throw unexpected errors
    }

    const newLines = scores.map((s) => JSON.stringify(s)).join('\n');
    const combined =
      existing.length > 0 && !existing.endsWith('\n')
        ? existing + '\n' + newLines + '\n'
        : existing + newLines + '\n';

    const tmpPath = `${safePath}.tmp`;
    writeFileSync(tmpPath, combined, 'utf8');

    // fsync to flush OS buffers before the rename.
    const fd = openSync(tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmpPath, safePath);
  } catch (err) {
    // EACCES / ENOSPC / any other IO error: log a warning but never throw.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ENOSPC') {
      // Silent — expected transient conditions.
      return;
    }
    // Other errors: emit a console warning only (non-fatal).
    console.warn(
      `[jsonl-writer] appendStepScore warning (${code ?? 'unknown'}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
