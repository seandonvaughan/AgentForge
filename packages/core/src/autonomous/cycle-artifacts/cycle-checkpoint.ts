// packages/core/src/autonomous/cycle-artifacts/cycle-checkpoint.ts
//
// Cycle checkpoint durability contract for Wave 3 T5.
//
// Writes `.agentforge/cycles/<cycleId>/checkpoint.json` atomically (.tmp + rename)
// after EVERY successful phase. On resume, the runner/scheduler reads this file
// and skips phases listed in `completedPhases`.
//
// CodeQL js/path-injection: cycleId is validated match-then-use against
// /^[a-zA-Z0-9-]{8,64}$/ — we use the regex's matched substring rather than
// the raw caller input so the static analyzer can trace a sanitized value.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PhaseNameSchema = z.enum([
  'audit',
  'plan',
  'assign',
  'execute',
  'test',
  'review',
  'gate',
  'release',
  'learn',
]);
export type PhaseName = z.infer<typeof PhaseNameSchema>;

/**
 * Locally inlined ValidatedJsonOutputSchema.
 *
 * T1 has not yet merged the shared symbol into `@agentforge/shared`. To keep
 * this module standalone-buildable, accept an unknown JSON value here. When
 * T1 lands, swap to the shared import.
 */
const ValidatedJsonOutputSchema = z.unknown();

export const ExecuteProgressSchema = z.object({
  completedItemIds: z.array(z.string()),
  inFlightItemIds: z.array(z.string()).default([]),
  costSoFarUsd: z.number().min(0),
  agentOutputs: z.record(z.string(), ValidatedJsonOutputSchema).default({}),
});
export type ExecuteProgress = z.infer<typeof ExecuteProgressSchema>;

export const CycleCheckpointSchema = z.object({
  v: z.literal(1),
  cycleId: z.string(),
  capturedAt: z.string(),
  resumeFromPhase: PhaseNameSchema,
  completedPhases: z.array(PhaseNameSchema),
  executeProgress: ExecuteProgressSchema.optional(),
  budgetUsd: z.number().min(0),
  spentUsd: z.number().min(0),
  parentCheckpointId: z.string().optional(),
});
export type CycleCheckpoint = z.infer<typeof CycleCheckpointSchema>;

// ---------------------------------------------------------------------------
// Path resolution (match-then-use for CodeQL js/path-injection)
// ---------------------------------------------------------------------------

const CYCLE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * Validate and return a safe cycleId. Throws if the input does not match the
 * allowed shape. We return the regex match (not the caller's raw string) so
 * the static analyzer can trace a sanitized value across the join() call.
 */
function safeCycleId(raw: string): string {
  const m = CYCLE_ID_RE.exec(raw);
  if (!m) {
    throw new Error(`[cycle-checkpoint] invalid cycleId segment`);
  }
  return m[0];
}

/**
 * Resolve the absolute path to checkpoint.json for a cycle directory.
 * Match-then-use: we re-validate the trailing segment as a cycleId.
 */
function resolveCheckpointPath(cycleDir: string): string {
  const parts = cycleDir.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  const safeId = safeCycleId(last);
  const parentDir = cycleDir.slice(0, cycleDir.length - last.length);
  return join(parentDir, safeId, 'checkpoint.json');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a checkpoint atomically. Writes to `<path>.tmp` then renames over the
 * target so partial writes are never observable to readers.
 *
 * Throws if `checkpoint` fails schema validation or the rename fails.
 */
export function writeCheckpoint(cycleDir: string, checkpoint: CycleCheckpoint): void {
  const parsed = CycleCheckpointSchema.parse(checkpoint);

  const finalPath = resolveCheckpointPath(cycleDir);
  const tmpPath = `${finalPath}.tmp`;

  mkdirSync(dirname(finalPath), { recursive: true });

  writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
  renameSync(tmpPath, finalPath);
}

/**
 * Read a checkpoint if present. Returns null on ENOENT or any IO/parse error —
 * NEVER throws. Resume is best-effort: a corrupted checkpoint must not crash
 * the runner.
 */
export function readCheckpoint(cycleDir: string): CycleCheckpoint | null {
  let finalPath: string;
  try {
    finalPath = resolveCheckpointPath(cycleDir);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(finalPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return null;
  }

  try {
    const json = JSON.parse(raw);
    const result = CycleCheckpointSchema.safeParse(json);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}
